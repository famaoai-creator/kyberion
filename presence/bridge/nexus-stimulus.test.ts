import { describe, expect, it } from 'vitest';
import { normalizeGuspStimulus, parseGuspStimulusLine } from './nexus-stimulus.js';

const validStimulus = {
  id: 'req-1',
  ts: '2026-09-01T00:00:00.000Z',
  ttl: 60,
  origin: { channel: 'system', source_id: 'service-actuator' },
  signal: { intent: 'alert', priority: 8, payload: 'service failed' },
  control: {
    status: 'pending',
    feedback: 'auto',
    evidence: [
      { step: 'auto_recovery', ts: '2026-09-01T00:00:00.000Z', agent: 'service-actuator' },
    ],
  },
};

describe('nexus stimulus parser', () => {
  it('accepts legacy control feedback and the optional policy shape', () => {
    expect(normalizeGuspStimulus(validStimulus)).toMatchObject({
      id: 'req-1',
      control: { status: 'pending', feedback: 'auto' },
    });
    expect(
      normalizeGuspStimulus({
        ...validStimulus,
        policy: { flow: 'interactive', feedback: 'silent', retention: 'short' },
      }).policy?.feedback
    ).toBe('silent');
  });

  it.each([
    ['primitive root', null],
    ['invalid JSON', '{'],
    [
      'invalid status',
      { ...validStimulus, control: { ...validStimulus.control, status: 'queued' } },
    ],
    ['invalid payload', { ...validStimulus, signal: { ...validStimulus.signal, payload: [] } }],
    ['unknown root field', { ...validStimulus, unexpected: true }],
    ['invalid timestamp', { ...validStimulus, ts: 'not-a-date' }],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeGuspStimulus(value)).toThrow();
    expect(parseGuspStimulusLine(JSON.stringify(value))).toBeUndefined();
  });

  it('rejects nested dangerous keys before stimulus normalization', () => {
    const unsafe = JSON.stringify({
      ...validStimulus,
      origin: { ...validStimulus.origin, metadata: { ['__proto__']: { polluted: true } } },
    });
    expect(parseGuspStimulusLine(unsafe)).toBeUndefined();
  });
});
