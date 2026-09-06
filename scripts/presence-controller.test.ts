import { describe, expect, it, vi } from 'vitest';
import { main, parsePresenceStimulus, parsePresenceStimulusLine } from './presence-controller.js';

const validStimulus = {
  timestamp: '2026-09-01T00:00:00.000Z',
  source_channel: 'slack',
  delivery_mode: 'REALTIME',
  payload: 'hello',
  status: 'PENDING',
  metadata: { channel_id: 'C123' },
};

describe('presence controller stimulus boundary', () => {
  it('accepts the documented legacy stimulus shape', () => {
    expect(parsePresenceStimulus(validStimulus)).toMatchObject(validStimulus);
  });

  it('preserves optional fields after validation', () => {
    expect(parsePresenceStimulus({ ...validStimulus, correlation_id: 'corr-1' })).toMatchObject({
      correlation_id: 'corr-1',
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['array root', '[]'],
    ['missing timestamp', JSON.stringify({ ...validStimulus, timestamp: undefined })],
    ['invalid status', JSON.stringify({ ...validStimulus, status: 'QUEUED' })],
    ['invalid metadata', JSON.stringify({ ...validStimulus, metadata: [] })],
  ])('rejects %s before controller handling', (_, line) => {
    expect(parsePresenceStimulusLine(line)).toBeUndefined();
  });

  it('routes usage output through the shared printer', async () => {
    const print = vi.fn();

    await main(['--help'], print);

    expect(print).toHaveBeenCalledWith(
      'Usage: pnpm presence-controller <resolve|perceive|prune> [args]'
    );
  });

  it('routes perceived JSON through the shared printer', async () => {
    const print = vi.fn();

    await main(['perceive'], print);

    expect(print).toHaveBeenCalledWith(expect.any(String));
  });
});
