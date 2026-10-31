import { describe, expect, it, vi } from 'vitest';
import { runTickWithHeartbeat } from './chronos_daemon.js';

const at = (iso: string) => () => new Date(iso);

describe('chronos tick heartbeat', () => {
  it('refreshes the running heartbeat only after a led tick completes', async () => {
    const write = vi.fn();
    const liveness: Record<string, unknown> = { started_at: '2026-11-01T00:00:00.000Z' };
    await runTickWithHeartbeat(async () => true, write, liveness, at('2026-11-01T00:01:00.000Z'));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('running', { phase: 'tick' });
    expect(liveness.last_tick_ok_at).toBe('2026-11-01T00:01:00.000Z');
  });

  it('a throwing tick records error state instead of a fresh healthy heartbeat, then rethrows', async () => {
    const write = vi.fn();
    const liveness: Record<string, unknown> = { last_tick_ok_at: '2026-11-01T00:01:00.000Z' };
    await expect(
      runTickWithHeartbeat(
        async () => {
          throw new Error('delivery journal unreadable');
        },
        write,
        liveness,
        at('2026-11-01T00:02:00.000Z')
      )
    ).rejects.toThrow('delivery journal unreadable');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('error', { phase: 'tick' });
    expect(liveness).toMatchObject({
      last_tick_ok_at: '2026-11-01T00:01:00.000Z',
      last_tick_error: 'delivery journal unreadable',
      last_tick_error_at: '2026-11-01T00:02:00.000Z',
    });
  });

  it('a standby tick (lease held elsewhere) writes no heartbeat', async () => {
    const write = vi.fn();
    await runTickWithHeartbeat(async () => false, write, {}, at('2026-11-01T00:03:00.000Z'));
    expect(write).not.toHaveBeenCalled();
  });
});
