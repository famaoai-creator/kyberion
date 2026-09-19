import { afterEach, describe, expect, it } from 'vitest';
import { StubVideoFrameBus } from './video-frame-bus.js';
import { VideoDeviceLeaseManager } from './video-device-lease.js';
import { safeRmSync } from './secure-io.js';
import * as pathResolver from './path-resolver.js';

const leaseDir = pathResolver.sharedTmp('video-frame-bus-parity-leases');

afterEach(() => safeRmSync(leaseDir, { recursive: true, force: true }));

describe('StubVideoFrameBus parity', () => {
  it('negotiates format and rejects mismatched mime types', async () => {
    const bus = new StubVideoFrameBus();
    await bus.open({ mime_type: 'image/jpeg', width: 640, height: 480 });
    await expect(
      bus.writeFrames(
        (async function* () {
          yield {
            format: { mime_type: 'image/png' as const, width: 640, height: 480 },
            payload: new Uint8Array([1]),
            ts_ms: 0,
          };
        })()
      )
    ).rejects.toThrow(/format mismatch/);
    await bus.close();
  });

  it('exposes health and metrics mirroring the audio bus', async () => {
    const bus = new StubVideoFrameBus();
    await bus.open({ mime_type: 'image/jpeg' });
    const reader = (async () => {
      for await (const _frame of bus.frameStream()) {
        break;
      }
    })();
    await bus.writeFrames(
      (async function* () {
        yield {
          format: { mime_type: 'image/jpeg' as const },
          payload: new Uint8Array([1, 2]),
          ts_ms: 0,
        };
      })()
    );
    await reader;
    const health = bus.health();
    expect(health.queue_depth).toBeGreaterThanOrEqual(0);
    expect(health.lease_held).toBe(false);
    const metrics = bus.metrics();
    expect(metrics.frames_out).toBe(1);
    expect(metrics.frames_in).toBe(1);
    await bus.close();
    expect(bus.health().status).toBe('closed');
  });

  it('holds a device lease while opened when device_uid is given', async () => {
    const bus = new StubVideoFrameBus({
      device_uid: `parity-cam-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      lease_manager: new VideoDeviceLeaseManager({ lease_dir: leaseDir }),
    });
    await bus.open({ mime_type: 'image/jpeg' });
    expect(bus.health().lease_held).toBe(true);
    await bus.close();
    await bus.close();
    expect(bus.health().status).toBe('closed');
  });

  it('does not count dropped newest frames as output', async () => {
    const bus = new StubVideoFrameBus({
      buffer_policy: { max_frames: 1, max_buffer_ms: 10_000, overflow: 'drop_newest' },
    });
    await bus.writeFrames(
      (async function* () {
        yield {
          format: { mime_type: 'image/jpeg' as const },
          payload: new Uint8Array([1]),
          ts_ms: 0,
        };
        yield {
          format: { mime_type: 'image/jpeg' as const },
          payload: new Uint8Array([2]),
          ts_ms: 33,
        };
      })()
    );
    expect(bus.metrics().frames_out).toBe(1);
    expect(bus.metrics().dropped_frames).toBe(1);
    await bus.close();
  });

  it('fails the writer when the queue overflow policy is fail', async () => {
    const bus = new StubVideoFrameBus({
      buffer_policy: { max_frames: 1, max_buffer_ms: 10_000, overflow: 'fail' },
    });
    await expect(
      bus.writeFrames(
        (async function* () {
          yield {
            format: { mime_type: 'image/jpeg' as const },
            payload: new Uint8Array([1]),
            ts_ms: 0,
          };
          yield {
            format: { mime_type: 'image/jpeg' as const },
            payload: new Uint8Array([2]),
            ts_ms: 33,
          };
        })()
      )
    ).rejects.toThrow(/overflow/);
    expect(bus.health().status).toBe('degraded');
    await expect(
      bus.writeFrames(
        (async function* () {
          yield {
            format: { mime_type: 'image/jpeg' as const },
            payload: new Uint8Array([3]),
            ts_ms: 66,
          };
        })()
      )
    ).rejects.toThrow(/degraded/);
  });

  it('allows an unopened bus to be closed and read as empty', async () => {
    const bus = new StubVideoFrameBus();
    await bus.close();
    const frames: unknown[] = [];
    for await (const frame of bus.frameStream()) frames.push(frame);
    expect(frames).toEqual([]);
  });

  it('drops oldest frames under a tiny buffer policy', async () => {
    const bus = new StubVideoFrameBus({
      buffer_policy: { max_frames: 1, max_buffer_ms: 10_000, overflow: 'drop_oldest' },
    });
    await bus.writeFrames(
      (async function* () {
        yield {
          format: { mime_type: 'image/jpeg' as const },
          payload: new Uint8Array([1]),
          ts_ms: 0,
        };
        yield {
          format: { mime_type: 'image/jpeg' as const },
          payload: new Uint8Array([2]),
          ts_ms: 33,
        };
      })()
    );
    expect(bus.metrics().dropped_frames).toBe(1);
    await bus.close();
  });
});
