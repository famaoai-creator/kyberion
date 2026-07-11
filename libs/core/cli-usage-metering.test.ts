import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics } from './metrics.js';
import { recordEstimatedCliUsage } from './cli-usage-metering.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordEstimatedCliUsage (OP-01)', () => {
  it('records estimated tokens with the estimated flag and mission attribution', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    const previousMission = process.env.MISSION_ID;
    process.env.MISSION_ID = 'MSN-METER-1';
    try {
      recordEstimatedCliUsage('gemini-cli', 'gemini-test', Date.now() - 5, 'success', 400, 80);
    } finally {
      if (previousMission === undefined) delete process.env.MISSION_ID;
      else process.env.MISSION_ID = previousMission;
    }

    expect(spy).toHaveBeenCalledOnce();
    const [component, , status, extra] = spy.mock.calls[0];
    expect(component).toBe('gemini-cli');
    expect(status).toBe('success');
    expect(extra).toMatchObject({
      model: 'gemini-test',
      estimated: true,
      mission_id: 'MSN-METER-1',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
  });

  it('never throws when the metrics collector fails', () => {
    vi.spyOn(metrics, 'record').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() =>
      recordEstimatedCliUsage('codex-cli', 'codex-test', Date.now(), 'error', 10, 0)
    ).not.toThrow();
  });
});
