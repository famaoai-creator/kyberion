import { describe, expect, it } from 'vitest';
import { normalizeNerveMessage, parseNerveMessageLine } from './stimuli-journal.js';

const validMessage = {
  id: 'msg-1',
  ts: '2026-09-01T00:00:00.000Z',
  from: 'sensor',
  node_id: 'node-1',
  to: 'operator',
  type: 'event',
  intent: 'alert',
  payload: { severity: 'high' },
  metadata: { mission_id: 'MSN-1', ttl: 60 },
};

describe('NerveMessage JSONL boundary', () => {
  it('projects a valid NerveMessage and preserves payload', () => {
    expect(normalizeNerveMessage(validMessage)).toEqual(validMessage);
  });

  it.each([
    null,
    [],
    { ...validMessage, type: 'unknown' },
    { ...validMessage, metadata: [] },
    { ...validMessage, intent: '' },
    { ...validMessage, metadata: { ttl: '60' } },
  ])('rejects malformed NerveMessage input: %j', (value) => {
    expect(() => normalizeNerveMessage(value)).toThrow();
  });

  it('skips malformed JSONL lines before they reach sensory memory', () => {
    expect(parseNerveMessageLine(JSON.stringify(validMessage))).toEqual(validMessage);
    expect(parseNerveMessageLine('[]')).toBeUndefined();
    expect(parseNerveMessageLine('{"id":"missing-required-fields"}')).toBeUndefined();
    expect(parseNerveMessageLine('{')).toBeUndefined();
  });

  it('skips JSONL lines with nested dangerous keys', () => {
    const unsafe = JSON.stringify({
      ...validMessage,
      metadata: { ...validMessage.metadata, ['__proto__']: { polluted: true } },
    });
    expect(parseNerveMessageLine(unsafe)).toBeUndefined();
  });
});
