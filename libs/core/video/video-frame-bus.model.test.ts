import { describe, expect, it } from 'vitest';
import {
  checkFiniteStateSafety,
  type ModelStep,
  type SafetyModel,
} from '../testing/finite-state-checker.js';
import { BoundedVideoQueue } from './bounded-video-queue.js';
import { StubVideoFrameBus } from './video-frame-bus.js';
import type { VideoDeviceLeaseManager } from './video-device-lease.js';
import type { VideoFrame } from '../meeting/meeting-session-types.js';

// Safety properties under verification (executable safety model; see
// knowledge/product/architecture/executable-safety-models.md):
//   A. BoundedVideoQueue: queue depth and buffered_ms stay within policy on
//      every push; overflow evicts from the oldest end only (drop_oldest),
//      rejects only the incoming frame (drop_newest), or fails closed
//      (fail); a pending reader is handed the frame directly, never queued;
//      close drains all waiters; frame delivery order is preserved.
//   B. StubVideoFrameBus: a write reaches the queue only after open/auto-open
//      and a matching negotiated format; a queue failure degrades the bus
//      and releases the device lease; close() releases the lease, keeps
//      queued frames drainable, makes later writes silent no-ops, and
//      cannot be reopened.
//
// Abstraction: frames are unique ids, not pixels; timestamps collapse to a
// fixed 33ms grid; the frame budget is four; the queue bound is two; device
// lease acquire/release is a counted seam. Real capture devices, pixel
// formats, ffmpeg and event-loop scheduling are outside the model.

const flushTicks = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise<void>((r) => setImmediate(r));
};

const jpegFrame = (ts_ms: number, bytes = 4): VideoFrame => ({
  format: { mime_type: 'image/jpeg', width: 640, height: 480 },
  payload: new Uint8Array(bytes),
  ts_ms,
});

const pngFrame = (ts_ms: number): VideoFrame => ({
  format: { mime_type: 'image/png', width: 640, height: 480 },
  payload: new Uint8Array(4),
  ts_ms,
});

// ---------------------------------------------------------------------------
// Spec A: bounded video queue under the three overflow policies
// ---------------------------------------------------------------------------

type OverflowPolicy = 'drop_oldest' | 'drop_newest' | 'fail';
const FRAME_COUNT = 4;
const FRAME_MS = 33;
const WAITER_CAP = 2;

interface QueueConfig {
  policy: OverflowPolicy;
  maxFrames: number;
  maxMs: number;
}

interface QueuedFrame {
  id: number;
  dur: number;
}

interface QueueState {
  queue: QueuedFrame[];
  buffered: number;
  waiters: number;
  closed: boolean;
  failed: boolean;
  /** Next frame id to push; also the count of pushes attempted. */
  pushed: number;
  /** Id of the last accepted frame (queue or handoff); -1 before any. */
  lastAccepted: number;
  delivered: number[];
  droppedQueued: number[];
  droppedNew: number[];
}

const queueIdle: QueueState = {
  queue: [],
  buffered: 0,
  waiters: 0,
  closed: false,
  failed: false,
  pushed: 0,
  lastAccepted: -1,
  delivered: [],
  droppedQueued: [],
  droppedNew: [],
};

const frameDuration = (id: number, lastAccepted: number): number =>
  lastAccepted < 0 ? FRAME_MS : (id - lastAccepted) * FRAME_MS;

function queueNext(cfg: QueueConfig) {
  return (s: QueueState): readonly ModelStep<QueueState>[] => {
    if (s.failed) return [];
    const out: ModelStep<QueueState>[] = [];
    if (s.pushed < FRAME_COUNT && !s.closed) {
      const id = s.pushed;
      const dur = frameDuration(id, s.lastAccepted);
      const base = { ...s, pushed: id + 1 };
      if (s.waiters > 0) {
        // A waiting reader takes the frame directly — the queue never sees it.
        out.push({
          action: 'push:handoff',
          state: {
            ...base,
            waiters: s.waiters - 1,
            lastAccepted: id,
            delivered: [...s.delivered, id],
          },
        });
      } else {
        const overflow = s.queue.length >= cfg.maxFrames || s.buffered + dur > cfg.maxMs;
        if (!overflow) {
          out.push({
            action: 'push:queue',
            state: {
              ...base,
              queue: [...s.queue, { id, dur }],
              buffered: s.buffered + dur,
              lastAccepted: id,
            },
          });
        } else if (cfg.policy === 'drop_newest') {
          out.push({
            action: 'push:drop-new',
            state: { ...base, droppedNew: [...s.droppedNew, id] },
          });
        } else if (cfg.policy === 'fail') {
          out.push({
            action: 'push:overflow-fail',
            state: {
              ...base,
              failed: true,
              closed: true,
              waiters: 0,
              droppedNew: [...s.droppedNew, id],
            },
          });
        } else {
          // drop_oldest: evict from the front until the incoming frame fits.
          const queue = [...s.queue];
          const droppedQueued = [...s.droppedQueued];
          let buffered = s.buffered;
          while (
            queue.length > 0 &&
            (queue.length >= cfg.maxFrames || buffered + dur > cfg.maxMs)
          ) {
            const removed = queue.shift()!;
            buffered -= removed.dur;
            droppedQueued.push(removed.id);
          }
          if (queue.length >= cfg.maxFrames || buffered + dur > cfg.maxMs) {
            out.push({
              action: 'push:drop-after-evict',
              state: {
                ...base,
                queue,
                buffered,
                droppedQueued,
                droppedNew: [...s.droppedNew, id],
              },
            });
          } else {
            out.push({
              action: 'push:evict-then-queue',
              state: {
                ...base,
                queue: [...queue, { id, dur }],
                buffered: buffered + dur,
                droppedQueued,
                lastAccepted: id,
              },
            });
          }
        }
      }
    }
    if (s.queue.length > 0) {
      const head = s.queue[0]!;
      out.push({
        action: 'next:pop',
        state: {
          ...s,
          queue: s.queue.slice(1),
          buffered: s.buffered - head.dur,
          delivered: [...s.delivered, head.id],
        },
      });
    } else if (!s.closed && s.waiters < WAITER_CAP) {
      out.push({ action: 'next:wait', state: { ...s, waiters: s.waiters + 1 } });
    }
    if (!s.closed) {
      out.push({ action: 'close', state: { ...s, closed: true, waiters: 0 } });
    }
    return out;
  };
}

const maxOf = (xs: number[]): number => xs.reduce((a, b) => Math.max(a, b), -Infinity);
const minOf = (xs: number[]): number => xs.reduce((a, b) => Math.min(a, b), Infinity);

function queueInvariants(cfg: QueueConfig): SafetyModel<QueueState>['invariants'] {
  return {
    'queue depth stays within policy': (s) => s.queue.length <= cfg.maxFrames,
    'buffered ms stays within policy': (s) => s.buffered <= cfg.maxMs,
    'buffered ms equals queued durations': (s) =>
      s.buffered === s.queue.reduce((total, f) => total + f.dur, 0),
    'push accounting is complete': (s) =>
      s.pushed ===
      s.queue.length + s.delivered.length + s.droppedQueued.length + s.droppedNew.length,
    'delivered frames keep push order': (s) =>
      s.delivered.every((id, index) => index === 0 || s.delivered[index - 1]! < id),
    'queued frames keep push order': (s) =>
      s.queue.every((f, index) => index === 0 || s.queue[index - 1]!.id < f.id),
    'a pending reader implies an empty queue': (s) => s.waiters === 0 || s.queue.length === 0,
    'no frame is both queued and delivered': (s) =>
      s.queue.every((f) => !s.delivered.includes(f.id)),
    'no frame is queued twice': (s) => new Set(s.queue.map((f) => f.id)).size === s.queue.length,
    'closed drains every waiter': (s) => !s.closed || s.waiters === 0,
    'failure implies closed': (s) => !s.failed || (s.closed && s.waiters === 0),
    'evictions take older frames than the survivors': (s) =>
      cfg.policy !== 'drop_oldest' ||
      s.droppedQueued.length === 0 ||
      s.queue.length === 0 ||
      maxOf(s.droppedQueued) < minOf(s.queue.map((f) => f.id)),
    'evicted frames never resurface': (s) =>
      s.droppedQueued.every((id) => !s.queue.some((f) => f.id === id) && !s.delivered.includes(id)),
    'rejected frames never resurface': (s) =>
      s.droppedNew.every((id) => !s.queue.some((f) => f.id === id) && !s.delivered.includes(id)),
  };
}

function queueModel(cfg: QueueConfig): SafetyModel<QueueState> {
  return {
    initial: [queueIdle],
    key: (s) => JSON.stringify(s),
    next: queueNext(cfg),
    invariants: queueInvariants(cfg),
  };
}

const QUEUE_CONFIGS: QueueConfig[] = [
  { policy: 'drop_oldest', maxFrames: 2, maxMs: 66 },
  { policy: 'drop_newest', maxFrames: 2, maxMs: 66 },
  { policy: 'fail', maxFrames: 1, maxMs: 66 },
];

describe('bounded video queue finite-state specification', () => {
  it('exhausts drop_oldest without a safety violation', () => {
    const result = checkFiniteStateSafety(queueModel(QUEUE_CONFIGS[0]!));
    expect(result).toEqual({ status: 'verified', visited: 66, transitions: 112 });
  });
  it('exhausts drop_newest without a safety violation', () => {
    const result = checkFiniteStateSafety(queueModel(QUEUE_CONFIGS[1]!));
    expect(result).toEqual({ status: 'verified', visited: 64, transitions: 109 });
  });
  it('exhausts fail without a safety violation', () => {
    const result = checkFiniteStateSafety(queueModel(QUEUE_CONFIGS[2]!));
    expect(result).toEqual({ status: 'verified', visited: 31, transitions: 52 });
  });

  it('detects a tail-eviction mutation under drop_oldest', () => {
    const cfg = QUEUE_CONFIGS[0]!;
    const next = queueNext(cfg);
    const result = checkFiniteStateSafety({
      ...queueModel(cfg),
      next: (s) =>
        next(s).map((step) => {
          if (step.action !== 'push:evict-then-queue') return step;
          // Mutant: evict the NEWEST queued frame instead of the oldest, then
          // admit the incoming frame (buffered math stays consistent).
          const victim = s.queue.at(-1)!;
          const dur = frameDuration(s.pushed, s.lastAccepted);
          return {
            ...step,
            state: {
              ...step.state,
              queue: [...s.queue.slice(0, -1), { id: s.pushed, dur }],
              buffered: s.buffered - victim.dur + dur,
              droppedQueued: [victim.id],
            },
          };
        }),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('evictions take older frames than the survivors');
  });

  it('detects a waiter-while-queued mutation', () => {
    const cfg = QUEUE_CONFIGS[0]!;
    const next = queueNext(cfg);
    const result = checkFiniteStateSafety({
      ...queueModel(cfg),
      next: (s) => {
        const steps = next(s);
        if (s.queue.length > 0) {
          steps.push({ action: 'next:wait-while-queued', state: { ...s, waiters: s.waiters + 1 } });
        }
        return steps;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a pending reader implies an empty queue');
  });

  it('detects a close-that-keeps-waiters mutation', () => {
    const cfg = QUEUE_CONFIGS[0]!;
    const next = queueNext(cfg);
    const result = checkFiniteStateSafety({
      ...queueModel(cfg),
      next: (s) =>
        next(s).map((step) =>
          step.action === 'close' ? { ...step, state: { ...step.state, waiters: s.waiters } } : step
        ),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('closed drains every waiter');
  });
});

// ---------------------------------------------------------------------------
// Spec B: stub frame bus lifecycle — open, format negotiation, lease, degrade
// ---------------------------------------------------------------------------

type BusFormat = 'none' | 'jpeg' | 'png';
const BUS_QUEUE_CAP = 2;

interface BusConfig {
  device: boolean;
  policy: OverflowPolicy;
}

const BUS_WRITE_BUDGET = 3;

interface BusState {
  opened: boolean;
  everOpened: boolean;
  closed: boolean;
  status: 'closed' | 'healthy' | 'degraded';
  openedVia: 'none' | 'explicit' | 'reader' | 'write';
  format: BusFormat;
  leases: number;
  queueLen: number;
  waiters: number;
  /** Write attempts so far (bounded to keep the graph finite). */
  writes: number;
  in: number;
  out: number;
  rejectedNew: number;
  qDropped: number;
  queueFailed: boolean;
  outAtDegrade: number;
}

const busIdle: BusState = {
  opened: false,
  everOpened: false,
  closed: false,
  status: 'closed',
  openedVia: 'none',
  format: 'none',
  leases: 0,
  queueLen: 0,
  waiters: 0,
  writes: 0,
  in: 0,
  out: 0,
  rejectedNew: 0,
  qDropped: 0,
  queueFailed: false,
  outAtDegrade: -1,
};

function busNext(cfg: BusConfig) {
  return (s: BusState): readonly ModelStep<BusState>[] => {
    const out: ModelStep<BusState>[] = [];
    if (s.closed) {
      // A closed bus only drains what the queue still holds.
      if (s.queueLen > 0) {
        out.push({
          action: 'read:pop',
          state: { ...s, queueLen: s.queueLen - 1, in: s.in + 1 },
        });
      }
      return out;
    }
    for (const f of ['jpeg', 'png'] as const) {
      // Explicit open: locks the negotiated format and takes the lease.
      if (!s.opened) {
        out.push({
          action: `open:${f}`,
          state: {
            ...s,
            opened: true,
            everOpened: true,
            openedVia: 'explicit',
            status: 'healthy',
            format: f,
            leases: s.leases + (cfg.device ? 1 : 0),
          },
        });
      } else if (s.format === 'none') {
        out.push({ action: `open:${f}:adopt`, state: { ...s, format: f } });
      }
      // Write path: degraded buses and format mismatches throw before the
      // queue and are conformance-only (no state change to model).
      if (s.status === 'degraded' || s.writes >= BUS_WRITE_BUDGET) continue;
      let pre = s;
      if (!s.opened) {
        pre = {
          ...s,
          opened: true,
          everOpened: true,
          openedVia: 'write',
          status: 'healthy',
          format: f,
          leases: s.leases + (cfg.device ? 1 : 0),
        };
      } else if (s.format === 'none') {
        pre = { ...s, format: f };
      }
      if (pre.format !== f) continue;
      const wrote = { ...pre, writes: pre.writes + 1 };
      if (pre.waiters > 0) {
        out.push({
          action: `write:${f}:handoff`,
          state: { ...wrote, out: pre.out + 1, in: pre.in + 1, waiters: pre.waiters - 1 },
        });
      } else if (pre.queueLen < BUS_QUEUE_CAP) {
        out.push({
          action: `write:${f}`,
          state: { ...wrote, out: pre.out + 1, queueLen: pre.queueLen + 1 },
        });
      } else if (cfg.policy === 'drop_oldest') {
        out.push({
          action: `write:${f}:evict`,
          state: { ...wrote, out: pre.out + 1, qDropped: pre.qDropped + 1 },
        });
      } else if (cfg.policy === 'drop_newest') {
        out.push({
          action: `write:${f}:rejected`,
          state: { ...wrote, rejectedNew: pre.rejectedNew + 1, qDropped: pre.qDropped + 1 },
        });
      } else {
        out.push({
          action: `write:${f}:queue-error`,
          state: {
            ...wrote,
            status: 'degraded',
            outAtDegrade: pre.out,
            leases: 0,
            queueFailed: true,
          },
        });
      }
    }
    if (!s.everOpened) {
      out.push({
        action: 'reader-open',
        state: {
          ...s,
          opened: true,
          everOpened: true,
          openedVia: 'reader',
          status: 'healthy',
          leases: s.leases + (cfg.device ? 1 : 0),
        },
      });
    }
    if (s.queueLen > 0) {
      out.push({
        action: 'read:pop',
        state: { ...s, queueLen: s.queueLen - 1, in: s.in + 1 },
      });
    } else if (s.everOpened && s.waiters < 1) {
      out.push({ action: 'read:wait', state: { ...s, waiters: s.waiters + 1 } });
    }
    out.push({
      action: 'close',
      state: { ...s, closed: true, opened: false, status: 'closed', leases: 0, waiters: 0 },
    });
    return out;
  };
}

function busInvariants(cfg: BusConfig): SafetyModel<BusState>['invariants'] {
  return {
    'closed drains lease and waiters': (s) =>
      !s.closed || (!s.opened && s.leases === 0 && s.waiters === 0 && s.status === 'closed'),
    'write-path degradation releases the lease': (s) =>
      !(s.status === 'degraded' && s.queueFailed) || s.leases === 0,
    'at most one device lease': (s) => s.leases <= 1,
    'healthy requires open': (s) => s.status !== 'healthy' || s.opened,
    'a degraded bus accepts no more writes': (s) =>
      s.status !== 'degraded' || s.out === s.outAtDegrade,
    'a pending reader implies an empty queue': (s) => s.waiters === 0 || s.queueLen === 0,
    'frame accounting balances': (s) => s.out + s.rejectedNew === s.in + s.queueLen + s.qDropped,
    'ever opened stays open or closes': (s) => !s.everOpened || s.opened || s.closed,
    'a held lease requires an open bus': (s) => s.leases === 0 || s.opened,
    'explicit open locks a format': (s) => s.openedVia !== 'explicit' || s.format !== 'none',
    'a set format implies the bus opened': (s) => s.format === 'none' || s.everOpened,
    'queue failure implies degraded or closed': (s) =>
      !s.queueFailed || s.status === 'degraded' || s.closed,
  };
}

function busModel(cfg: BusConfig): SafetyModel<BusState> {
  return {
    initial: [busIdle],
    key: (s) => JSON.stringify(s),
    next: busNext(cfg),
    invariants: busInvariants(cfg),
  };
}

describe('stub video frame bus finite-state specification', () => {
  it('exhausts the device-leased drop_oldest lifecycle', () => {
    const result = checkFiniteStateSafety(busModel({ device: true, policy: 'drop_oldest' }));
    expect(result).toEqual({ status: 'verified', visited: 173, transitions: 277 });
  });
  it('exhausts the fail-policy lifecycle (degrade path)', () => {
    const result = checkFiniteStateSafety(busModel({ device: true, policy: 'fail' }));
    expect(result).toEqual({ status: 'verified', visited: 173, transitions: 277 });
  });
  it('exhausts the lease-free lifecycle', () => {
    const result = checkFiniteStateSafety(busModel({ device: false, policy: 'drop_newest' }));
    expect(result).toEqual({ status: 'verified', visited: 173, transitions: 277 });
  });

  it('detects a degraded-bus write mutation', () => {
    const cfg: BusConfig = { device: true, policy: 'fail' };
    const next = busNext(cfg);
    const result = checkFiniteStateSafety({
      ...busModel(cfg),
      next: (s) => {
        const steps = next(s);
        if (s.status === 'degraded' && s.opened) {
          steps.push({
            action: 'write:degraded',
            state: { ...s, out: s.out + 1, queueLen: s.queueLen + 1 },
          });
        }
        return steps;
      },
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('a degraded bus accepts no more writes');
  });

  it('detects a queue-error lease-retention mutation', () => {
    const cfg: BusConfig = { device: true, policy: 'fail' };
    const next = busNext(cfg);
    const result = checkFiniteStateSafety({
      ...busModel(cfg),
      next: (s) =>
        next(s).map((step) =>
          step.action.endsWith('queue-error')
            ? { ...step, state: { ...step.state, leases: s.leases } }
            : step
        ),
    });
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('write-path degradation releases the lease');
  });
});

// ---------------------------------------------------------------------------
// Conformance: the real queue and bus under scripted sequences
// ---------------------------------------------------------------------------

describe('BoundedVideoQueue conformance', () => {
  it('drop_oldest evicts the front on both the frame and the ms bound', () => {
    const queue = new BoundedVideoQueue({
      max_frames: 2,
      max_buffer_ms: 66,
      overflow: 'drop_oldest',
    });
    expect(queue.push(jpegFrame(0))).toBe(true);
    expect(queue.push(jpegFrame(33))).toBe(true);
    // frame cap 2 reached → evict ts 0
    expect(queue.push(jpegFrame(66))).toBe(true);
    expect(queue.metrics()).toMatchObject({ depth: 2, buffered_ms: 66, dropped_frames: 1 });
  });

  it('a dropped incoming frame inflates the next frame duration by the gap', () => {
    const queue = new BoundedVideoQueue({
      max_frames: 2,
      max_buffer_ms: 66,
      overflow: 'drop_newest',
    });
    expect(queue.push(jpegFrame(0))).toBe(true);
    expect(queue.push(jpegFrame(33))).toBe(true);
    expect(queue.push(jpegFrame(66))).toBe(false); // dropped; ts stays at 33
    // Duration is measured from the last ACCEPTED frame: 132-33 = 99 > 66.
    expect(queue.push(jpegFrame(132))).toBe(false);
    expect(queue.metrics()).toMatchObject({ depth: 2, buffered_ms: 66, dropped_frames: 2 });
  });

  it('hands a pushed frame directly to a waiting reader without queueing', async () => {
    const queue = new BoundedVideoQueue({
      max_frames: 2,
      max_buffer_ms: 66,
      overflow: 'drop_oldest',
    });
    const pending = queue.next();
    await flushTicks();
    expect(queue.push(jpegFrame(0))).toBe(true);
    expect(queue.metrics().depth).toBe(0);
    expect((await pending)?.ts_ms).toBe(0);
  });

  it('close() resolves pending readers with null and keeps buffered frames drainable', async () => {
    const queue = new BoundedVideoQueue({
      max_frames: 4,
      max_buffer_ms: 1000,
      overflow: 'drop_oldest',
    });
    const pending = queue.next(); // empty queue → a pending reader
    await flushTicks();
    queue.close();
    expect(await pending).toBeNull(); // the waiter resolves null, not a frame
    const drained = new BoundedVideoQueue({
      max_frames: 4,
      max_buffer_ms: 1000,
      overflow: 'drop_oldest',
    });
    drained.push(jpegFrame(0));
    drained.close();
    expect((await drained.next())?.ts_ms).toBe(0); // buffered frames still drain
    expect(await drained.next()).toBeNull();
    expect(drained.push(jpegFrame(33))).toBe(false); // pushes after close are rejected
  });

  it('fail overflow throws, closes, and poisons every later next()', async () => {
    const queue = new BoundedVideoQueue({ max_frames: 1, max_buffer_ms: 66, overflow: 'fail' });
    queue.push(jpegFrame(0));
    expect(() => queue.push(jpegFrame(33))).toThrow(/overflow/);
    // The failure check runs before the drain: even the buffered frame is lost.
    await expect(queue.next()).rejects.toThrow(/overflow/);
    expect(queue.push(jpegFrame(66))).toBe(false);
    // The rejected incoming frame is counted as a drop, like drop_newest.
    expect(queue.metrics()).toMatchObject({ dropped_frames: 1, dropped_ms: 33 });
  });
});

interface FakeLeaseState {
  acquired: number;
  released: number;
}

function fakeLeaseManager(state: FakeLeaseState): VideoDeviceLeaseManager {
  const manager = {
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
  };
  return manager as unknown as VideoDeviceLeaseManager;
}

const writeAll = (bus: StubVideoFrameBus, frames: VideoFrame[]): Promise<void> =>
  bus.writeFrames(
    (async function* () {
      for (const frame of frames) yield frame;
    })()
  );

describe('StubVideoFrameBus conformance', () => {
  it('explicit open locks the format; a mismatching write throws without degrading', async () => {
    const lease = { acquired: 0, released: 0 };
    const bus = new StubVideoFrameBus({
      device_uid: 'dev0',
      lease_manager: fakeLeaseManager(lease),
    });
    await bus.open({ mime_type: 'image/jpeg', width: 640, height: 480 });
    expect(lease).toMatchObject({ acquired: 1, released: 0 });
    await expect(writeAll(bus, [pngFrame(0)])).rejects.toThrow(/format mismatch/);
    expect(bus.health().status).toBe('healthy'); // caller error, not device failure
    expect(bus.health().lease_held).toBe(true);
    await bus.close();
    expect(lease.released).toBe(1);
  });

  it('reader auto-open leaves the format unset until the first write adopts it', async () => {
    const bus = new StubVideoFrameBus({
      buffer_policy: { max_frames: 4, max_buffer_ms: 200, overflow: 'drop_oldest' },
    });
    const read = (async () => {
      const seen: number[] = [];
      for await (const frame of bus.frameStream()) seen.push(frame.ts_ms);
      return seen;
    })();
    await flushTicks();
    await writeAll(bus, [jpegFrame(0), jpegFrame(33)]);
    await expect(writeAll(bus, [pngFrame(66)])).rejects.toThrow(/format mismatch/);
    await bus.close();
    expect(await read).toEqual([0, 33]);
  });

  it('a fail-policy overflow degrades the bus, releases the lease, and rejects later writes', async () => {
    const lease = { acquired: 0, released: 0 };
    const bus = new StubVideoFrameBus({
      device_uid: 'dev0',
      lease_manager: fakeLeaseManager(lease),
      buffer_policy: { max_frames: 1, max_buffer_ms: 33, overflow: 'fail' },
    });
    await bus.open();
    await writeAll(bus, [jpegFrame(0)]);
    // Second write overflows the queue → degraded, lease released.
    await expect(writeAll(bus, [jpegFrame(33)])).rejects.toThrow(/overflow/);
    expect(bus.health().status).toBe('degraded');
    expect(bus.health().lease_held).toBe(false);
    expect(lease.released).toBe(1);
    // A degraded bus refuses every later write before touching the queue.
    await expect(writeAll(bus, [jpegFrame(66)])).rejects.toThrow(/degraded/);
    expect(bus.metrics().frames_out).toBe(1);
    // The queue failure poisons reads too: the buffered frame is not drainable.
    await expect(bus.frameStream().next()).rejects.toThrow(/overflow/);
    expect(bus.metrics().dropped_frames).toBe(1);
    await bus.close();
  });

  it('drop_oldest keeps the newest frames and counts the eviction', async () => {
    const bus = new StubVideoFrameBus({
      buffer_policy: { max_frames: 2, max_buffer_ms: 200, overflow: 'drop_oldest' },
    });
    await writeAll(bus, [jpegFrame(0), jpegFrame(33), jpegFrame(66)]);
    expect(bus.metrics()).toMatchObject({ frames_out: 3, dropped_frames: 1 });
    const read = (async () => {
      const seen: number[] = [];
      for await (const frame of bus.frameStream()) seen.push(frame.ts_ms);
      return seen;
    })();
    await bus.close();
    expect(await read).toEqual([33, 66]); // ts 0 evicted, newest kept
    expect(bus.metrics().frames_in).toBe(2);
  });

  it('close() is terminal for writes, releases the lease, and reports closed health', async () => {
    const lease = { acquired: 0, released: 0 };
    const bus = new StubVideoFrameBus({
      device_uid: 'dev0',
      lease_manager: fakeLeaseManager(lease),
    });
    await bus.open();
    await bus.close();
    expect(lease).toMatchObject({ acquired: 1, released: 1 });
    const health = bus.health();
    expect(health.status).toBe('closed');
    expect(health.lease_held).toBe(false);
    await expect(bus.open()).rejects.toThrow(/closed/);
    // A write to a closed bus returns early via `closing` — a silent no-op,
    // not a throw: frames_out must stay unchanged.
    await writeAll(bus, [jpegFrame(0)]);
    expect(bus.metrics().frames_out).toBe(0);
  });
});
