import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkFiniteStateSafety,
  type ModelStep,
  type SafetyModel,
} from '../../core/testing/finite-state-checker.js';
import {
  registerCameraOutputBridge,
  resetCameraOutputBridges,
  resolveCameraOutputBridge,
  type CameraOutputBridge,
} from '../../core/media/camera-output-bridge.js';
import { V4l2VirtualCameraOutputBridge } from './v4l2-virtual-camera-output.js';
import type { VirtualCameraInjectionBridge } from '../../core/virtual/virtual-camera-injection-bridge.js';
import type { VideoDeviceLeaseManager } from '../../core/video/video-device-lease.js';

// Safety properties under verification (executable safety model; see
// knowledge/product/architecture/executable-safety-models.md):
//   A. resolveCameraOutputBridge: an explicit id resolves only a registered
//      backend that probes available; 'auto' selects the first
//      probed-available non-stub backend in id order (the seam sorts
//      providers by id); nothing usable fails with every probe reason —
//      never a silent fallback.
//   B. V4l2VirtualCameraOutputBridge lifecycle: a device lease is held only
//      inside an in-flight injection and always released (success, failure,
//      or probe refusal); a concurrent start is refused; a loop request is
//      refused before any probe or lease; stop() is idempotent and abandons
//      an in-flight call without letting the abandoned settle clobber a
//      later call's lease, guard, or health fields.
//
// Abstraction: providers reduce to ids + availability; the v4l2 world
// collapses to phase/status/lease counters. Real ffmpeg processes, device
// nodes, platform probing, and audit chains are outside the model.

// ---------------------------------------------------------------------------
// Spec A: backend resolution lattice (differential specification)
// ---------------------------------------------------------------------------

interface BridgeCell {
  id: string;
  available: boolean;
}

type ResolveOutcome = { kind: 'selected'; id: string } | { kind: 'error'; pattern: RegExp };

/** Independent restatement of the resolution contract. */
function specResolve(registry: BridgeCell[], preference: string): ResolveOutcome {
  const wanted = preference.trim().toLowerCase() || 'auto';
  if (wanted !== 'auto') {
    const backend = registry.find((entry) => entry.id === wanted);
    if (!backend) return { kind: 'error', pattern: /unknown backend/ };
    if (!backend.available) return { kind: 'error', pattern: /unavailable/ };
    return { kind: 'selected', id: backend.id };
  }
  // The seam lists providers sorted by id, not in registration order.
  const backend = [...registry]
    .sort((left, right) => left.id.localeCompare(right.id))
    .find((entry) => entry.id !== 'stub' && entry.available);
  return backend
    ? { kind: 'selected', id: backend.id }
    : { kind: 'error', pattern: /no usable camera backend/ };
}

function fakeBridge(cell: BridgeCell): CameraOutputBridge {
  return {
    bridge_id: cell.id,
    capabilities: { virtual_camera: true, looping_source: true, scene_switching: true },
    probe: async () =>
      cell.available ? { available: true } : { available: false, reason: 'fixture' },
    startAvatarOutput: async () => ({ scene: 's', source: 'v', virtualCamStarted: true }),
    stopAvatarOutput: async () => undefined,
  };
}

const REGISTRY_IDS = ['obs-virtual-cam', 'v4l2', 'stub'] as const;

function* registryOrderings(): Generator<BridgeCell['id'][]> {
  // All ordered subsets of REGISTRY_IDS (size 0–3): 16 orderings.
  const pool = [...REGISTRY_IDS];
  const pick = (prefix: string[] = []): string[][] =>
    pool
      .filter((id) => !prefix.includes(id))
      .flatMap((id) => {
        const next = [...prefix, id];
        return [next, ...pick(next)];
      });
  return yield* [[], ...pick()];
}

afterEach(() => resetCameraOutputBridges());

describe('camera-output resolution differential', () => {
  it('matches the specification for every registry ordering, availability mask, and preference', async () => {
    const preferences = ['auto', 'obs-virtual-cam', 'v4l2', 'stub', 'ghost', '', ' AUTO '];
    let cases = 0;
    for (const ordering of registryOrderings()) {
      const masks = 1 << ordering.length;
      for (let mask = 0; mask < masks; mask += 1) {
        const registry = ordering.map((id, index) => ({
          id,
          available: ((mask >> index) & 1) === 1,
        }));
        for (const preference of preferences) {
          resetCameraOutputBridges();
          for (const cell of registry) registerCameraOutputBridge(fakeBridge(cell));
          const expected = specResolve(registry, preference);
          let backend: CameraOutputBridge | undefined;
          let thrown: unknown;
          try {
            backend = await resolveCameraOutputBridge(preference);
          } catch (error) {
            thrown = error;
          }
          const ctx = `registry=${JSON.stringify(registry)} pref=${preference}`;
          if (expected.kind === 'selected') {
            expect(thrown, ctx).toBeUndefined();
            expect(backend?.bridge_id, ctx).toBe(expected.id);
          } else {
            expect(thrown, ctx).toBeDefined();
            expect(String(thrown), ctx).toMatch(expected.pattern);
          }
          cases += 1;
        }
      }
    }
    // 79 ordering/mask cells (1 + 3×2 + 6×4 + 6×8) × 7 preferences.
    expect(cases).toBe(553);
  });
});

// ---------------------------------------------------------------------------
// Spec B: v4l2 output lifecycle — started gate, lease window, stop
// ---------------------------------------------------------------------------

const V4L2_START_BUDGET = 2;

interface V4l2State {
  phase: 'idle' | 'probe' | 'inject' | 'settled';
  status: 'closed' | 'healthy' | 'failed';
  started: boolean;
  leases: number;
  probeOk: number;
  injected: number;
  /** start() calls so far (bounded to keep the graph finite). */
  starts: number;
  loopProbed: boolean;
}

const v4l2Idle: V4l2State = {
  phase: 'idle',
  status: 'closed',
  started: false,
  leases: 0,
  probeOk: 0,
  injected: 0,
  starts: 0,
  loopProbed: false,
};

interface V4l2Config {
  /** probeDetails refuses early on non-Linux platforms. */
  platform: 'linux' | 'darwin';
}

function v4l2Next(cfg: V4l2Config) {
  return (s: V4l2State): ModelStep<V4l2State>[] => {
    const out: ModelStep<V4l2State>[] = [];
    const busy = s.phase === 'probe' || s.phase === 'inject';
    // Caller-visible refusals leave no state change: concurrent start and
    // unsupported loop requests are rejected before any probe or lease.
    if (busy) out.push({ action: 'start:busy-refused', state: s });
    else out.push({ action: 'start:loop-refused', state: s });
    switch (s.phase) {
      case 'idle':
      case 'settled':
        if (s.starts < V4L2_START_BUDGET) {
          out.push({
            action: 'start',
            // The previous status persists until the new call settles.
            state: { ...s, phase: 'probe', started: true, starts: s.starts + 1 },
          });
        }
        out.push({ action: 'stop', state: { ...s, status: 'closed' } });
        break;
      case 'probe':
        if (cfg.platform !== 'linux') {
          out.push({
            action: 'probe:platform-unavailable',
            state: { ...s, phase: 'settled', status: 'failed', started: false },
          });
        } else {
          out.push({
            action: 'probe:ok',
            state: { ...s, phase: 'inject', probeOk: s.probeOk + 1, leases: s.leases + 1 },
          });
          out.push({
            action: 'probe:unavailable',
            state: { ...s, phase: 'settled', status: 'failed', started: false },
          });
        }
        break;
      case 'inject':
        out.push({
          action: 'inject:ok',
          state: {
            ...s,
            phase: 'settled',
            status: 'healthy',
            started: false,
            leases: 0,
            injected: s.injected + 1,
          },
        });
        out.push({
          action: 'inject:fail',
          state: { ...s, phase: 'settled', status: 'failed', started: false, leases: 0 },
        });
        break;
    }
    return out;
  };
}

const v4l2Invariants: SafetyModel<V4l2State>['invariants'] = {
  'settled retains no lease and no running flag': (s) =>
    s.phase !== 'settled' || (s.leases === 0 && !s.started),
  'a lease is held only inside a live injection': (s) => s.leases === 0 || s.phase === 'inject',
  'at most one device lease': (s) => s.leases <= 1,
  'started only inside an in-flight call': (s) =>
    !s.started || s.phase === 'probe' || s.phase === 'inject',
  'a device probe precedes every injection': (s) => s.injected <= s.probeOk,
  'a loop request never reaches the probe': (s) => !s.loopProbed,
  'a healthy report requires a successful injection': (s) =>
    s.status !== 'healthy' || s.injected > 0,
};

function v4l2Model(cfg: V4l2Config): SafetyModel<V4l2State> {
  return {
    initial: [v4l2Idle],
    key: (s) => JSON.stringify(s),
    next: v4l2Next(cfg),
    invariants: v4l2Invariants,
  };
}

describe('v4l2 output lifecycle finite-state specification', () => {
  it('exhausts the linux lifecycle', () => {
    const result = checkFiniteStateSafety(v4l2Model({ platform: 'linux' }));
    expect(result).toEqual({ status: 'verified', visited: 35, transitions: 91 });
  });
  it('exhausts the non-linux lifecycle', () => {
    const result = checkFiniteStateSafety(v4l2Model({ platform: 'darwin' }));
    expect(result).toEqual({ status: 'verified', visited: 8, transitions: 19 });
  });

  it('detects a lease retained past settle', () => {
    const cfg: V4l2Config = { platform: 'linux' };
    const next = v4l2Next(cfg);
    const result = checkFiniteStateSafety({
      ...v4l2Model(cfg),
      next: (s) =>
        next(s).map((step) =>
          step.action === 'inject:ok'
            ? { ...step, state: { ...step.state, leases: s.leases } }
            : step
        ),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('settled retains no lease and no running flag');
  });

  it('detects a concurrent start admitted during injection', () => {
    const cfg: V4l2Config = { platform: 'linux' };
    const next = v4l2Next(cfg);
    const result = checkFiniteStateSafety({
      ...v4l2Model(cfg),
      next: (s) => {
        const out = next(s);
        // Mutant: a second start during an in-flight call probes again.
        if (s.phase === 'inject') {
          out.push({ action: 'mutant:start-during-inject', state: { ...s, phase: 'probe' } });
        }
        return out;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a lease is held only inside a live injection');
  });

  it('detects a loop request reaching the probe', () => {
    const cfg: V4l2Config = { platform: 'linux' };
    const next = v4l2Next(cfg);
    const result = checkFiniteStateSafety({
      ...v4l2Model(cfg),
      next: (s) =>
        next(s).map((step) =>
          step.action === 'start:loop-refused'
            ? {
                action: 'mutant:loop-probes',
                state: { ...s, phase: 'probe' as const, started: true, loopProbed: true },
              }
            : step
        ),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a loop request never reaches the probe');
  });
});

// ---------------------------------------------------------------------------
// Conformance: the real bridge under scripted injection outcomes.
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeLeaseState {
  acquired: number;
  released: number;
}

function fakeLeaseManager(state: FakeLeaseState): VideoDeviceLeaseManager {
  return {
    acquire: () => {
      state.acquired += 1;
      let released = false;
      return {
        record: {
          lease_id: 'fake',
          device_uid: 'dev0',
          pid: 1,
          session_id: 'test',
          acquired_at: '',
          expires_at: '',
          heartbeat_at: '',
        },
        heartbeat: () => undefined,
        release: () => {
          if (!released) {
            released = true;
            state.released += 1;
          }
        },
      };
    },
  } as unknown as VideoDeviceLeaseManager;
}

function fakeInjectionBridge(behavior: {
  probeAvailable?: boolean;
  inject?: () => Promise<unknown>;
}): { bridge: VirtualCameraInjectionBridge; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    bridge: {
      bridge_id: 'virtual-camera-injection-bridge',
      probe: vi.fn(async () => {
        calls.push('probe');
        return {
          bridge_id: 'virtual-camera-injection-bridge' as const,
          platform: 'linux' as const,
          backend: behavior.probeAvailable === false ? 'stub' : 'ffmpeg-v4l2',
          available: behavior.probeAvailable !== false,
          selected_device_path: '/dev/video2',
        };
      }),
      injectFromMp4: vi.fn(async () => {
        calls.push('inject');
        return behavior.inject ? await behavior.inject() : { status: 'succeeded' };
      }),
      injectFrames: vi.fn(),
      injectBus: vi.fn(),
    } as unknown as VirtualCameraInjectionBridge,
  };
}

describe('V4l2VirtualCameraOutputBridge conformance', () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function linuxBridge(
    injection: { bridge: VirtualCameraInjectionBridge; calls: string[] },
    lease: FakeLeaseState
  ) {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    return new V4l2VirtualCameraOutputBridge({
      devicePath: '/dev/video2',
      ffmpegBin: 'true',
      injectionBridge: injection.bridge,
      lease_manager: fakeLeaseManager(lease),
    });
  }

  it('a loop request is refused before any probe or lease', async () => {
    const lease = { acquired: 0, released: 0 };
    const injection = fakeInjectionBridge({});
    const bridge = linuxBridge(injection, lease);
    await expect(bridge.startAvatarOutput({ videoPath: 'a.mp4', loop: true })).rejects.toThrow(
      /persistent loop/
    );
    expect(injection.calls).toEqual([]);
    expect(lease).toEqual({ acquired: 0, released: 0 });
  });

  it('a probe refusal never acquires the lease', async () => {
    const lease = { acquired: 0, released: 0 };
    const injection = fakeInjectionBridge({ probeAvailable: false });
    const bridge = linuxBridge(injection, lease);
    await expect(bridge.startAvatarOutput({ videoPath: 'a.mp4' })).rejects.toThrow(/not available/);
    expect(injection.calls).toEqual(['probe']);
    expect(lease).toEqual({ acquired: 0, released: 0 });
    expect(bridge.health().status).toBe('failed');
  });

  it('the lease is released on both success and injection failure', async () => {
    const lease = { acquired: 0, released: 0 };
    const injection = fakeInjectionBridge({
      inject: async () => ({ status: 'blocked', reason: 'fixture blocked' }),
    });
    const bridge = linuxBridge(injection, lease);
    await expect(bridge.startAvatarOutput({ videoPath: 'a.mp4' })).rejects.toThrow(/blocked/);
    expect(lease).toEqual({ acquired: 1, released: 1 });
    expect(bridge.health()).toMatchObject({ status: 'failed', lease_held: false });
  });

  it('a concurrent start is refused while a successful run holds no lease afterwards', async () => {
    const lease = { acquired: 0, released: 0 };
    const gate = deferred<unknown>();
    const injection = fakeInjectionBridge({ inject: () => gate.promise });
    const bridge = linuxBridge(injection, lease);
    const first = bridge.startAvatarOutput({ videoPath: 'a.mp4' });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(bridge.startAvatarOutput({ videoPath: 'b.mp4' })).rejects.toThrow(
      /already processing/
    );
    gate.resolve({ status: 'succeeded', injected_frame_count: 2 });
    await first;
    expect(lease).toEqual({ acquired: 1, released: 1 });
    expect(bridge.health()).toMatchObject({
      status: 'healthy',
      lease_held: false,
      output_process_alive: false,
    });
    // A later start is permitted again.
    gate.resolve({ status: 'succeeded' });
    await bridge.startAvatarOutput({ videoPath: 'c.mp4' });
    expect(injection.calls.filter((call) => call === 'inject')).toHaveLength(2);
  });

  it('stop() is idempotent and releases the lease', async () => {
    const lease = { acquired: 0, released: 0 };
    const injection = fakeInjectionBridge({});
    const bridge = linuxBridge(injection, lease);
    await bridge.startAvatarOutput({ videoPath: 'a.mp4' });
    await bridge.stopAvatarOutput();
    await bridge.stopAvatarOutput();
    expect(bridge.health()).toMatchObject({ status: 'closed', lease_held: false });
  });

  it("an abandoned call's settle never releases a later call's lease or guard", async () => {
    const lease = { acquired: 0, released: 0 };
    const gateA = deferred<unknown>();
    const gateB = deferred<unknown>();
    let call = 0;
    const injection = fakeInjectionBridge({
      inject: () => {
        call += 1;
        return call === 1 ? gateA.promise : gateB.promise;
      },
    });
    const bridge = linuxBridge(injection, lease);
    const first = bridge.startAvatarOutput({ videoPath: 'a.mp4' });
    await new Promise((resolve) => setImmediate(resolve));
    // Abandon the first call mid-flight: its lease is released and its
    // start-guard cleared, but the call itself still runs to settle.
    await bridge.stopAvatarOutput();
    expect(lease).toEqual({ acquired: 1, released: 1 });
    const second = bridge.startAvatarOutput({ videoPath: 'b.mp4' });
    await new Promise((resolve) => setImmediate(resolve));
    gateA.resolve({ status: 'succeeded' });
    await first;
    // The first call's settle must not release the second call's lease,
    // clear its guard, or publish its own result into shared health.
    expect(lease).toEqual({ acquired: 2, released: 1 });
    expect(bridge.health()).toMatchObject({
      status: 'closed',
      output_process_alive: true,
      lease_held: true,
    });
    gateB.resolve({ status: 'succeeded' });
    await second;
    expect(lease).toEqual({ acquired: 2, released: 2 });
    expect(bridge.health()).toMatchObject({ output_process_alive: false, lease_held: false });
  });
});
