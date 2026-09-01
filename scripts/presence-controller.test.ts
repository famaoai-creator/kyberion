import { describe, expect, it } from 'vitest';
import { parsePresenceStimulus, parsePresenceStimulusLine } from './presence-controller.js';

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
});
