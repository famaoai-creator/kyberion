import { describe, expect, it } from 'vitest';
import { resolveAskTransportTimeout } from './agent-runtime-supervisor-client.js';

describe('resolveAskTransportTimeout', () => {
  it('keeps the default transport budget for ordinary asks', () => {
    expect(resolveAskTransportTimeout()).toBe(60_000);
    expect(resolveAskTransportTimeout(1_000)).toBe(60_000);
  });

  it('keeps the supervisor socket open beyond a task dispatch budget', () => {
    expect(resolveAskTransportTimeout(180_000)).toBe(185_000);
    expect(resolveAskTransportTimeout(300_000)).toBe(305_000);
  });
});
