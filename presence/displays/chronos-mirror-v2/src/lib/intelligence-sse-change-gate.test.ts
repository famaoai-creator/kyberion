import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntelligenceSseChangeGate } from './intelligence-sse-change-gate';

describe('intelligence SSE change gate', () => {
  afterEach(() => vi.useRealTimers());

  it('suppresses unchanged payloads over 30 seconds and emits changed state once', () => {
    vi.useFakeTimers();
    const gate = createIntelligenceSseChangeGate();
    const stablePayload = { accessRole: 'readonly', runtime: { ready: 1 } };
    let dataFrames = 0;
    const poll = (payload: unknown) => {
      if (gate.hasChanged(payload)) dataFrames += 1;
    };

    poll(stablePayload);
    for (let elapsed = 0; elapsed < 30_000; elapsed += 2_000) {
      vi.advanceTimersByTime(2_000);
      poll(stablePayload);
    }
    expect(dataFrames).toBe(1);

    poll({ accessRole: 'readonly', runtime: { ready: 2 } });
    expect(dataFrames).toBe(2);
    poll({ accessRole: 'readonly', runtime: { ready: 2 } });
    expect(dataFrames).toBe(2);
  });
});
