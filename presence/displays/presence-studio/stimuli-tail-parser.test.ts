import { describe, expect, it } from 'vitest';
import { parseStimuliTailContent } from './presence-studio-runtime-data.js';

const valid = {
  id: 'stimulus-1',
  ts: '2026-09-01T00:00:00.000Z',
  ttl: 60,
  origin: { channel: 'test', source_id: 'source-1' },
  signal: { type: 'conversation', priority: 1, payload: 'hello' },
  control: { status: 'pending', evidence: [] },
};

describe('presence studio stimuli tail parser', () => {
  it('projects only canonical GUSP stimulus records', () => {
    expect(parseStimuliTailContent(`${JSON.stringify(valid)}\nnot-json\n`)).toEqual([valid]);
  });

  it('keeps the bounded tail and rejects malformed nested records', () => {
    const records = Array.from({ length: 3 }, (_, index) =>
      JSON.stringify({ ...valid, id: `s-${index}` })
    );
    expect(parseStimuliTailContent(`${records.join('\n')}\n`, 2).map((item) => item.id)).toEqual([
      's-1',
      's-2',
    ]);
    expect(
      parseStimuliTailContent(
        `${JSON.stringify({ ...valid, signal: { type: 'conversation', priority: 'high', payload: 'x' } })}\n`
      )
    ).toEqual([]);
  });
});
