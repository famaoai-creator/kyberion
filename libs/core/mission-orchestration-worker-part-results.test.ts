import { describe, expect, it } from 'vitest';
import { parseBestOfJudgeVerdict } from './mission-orchestration-worker-part-results.js';

describe('parseBestOfJudgeVerdict', () => {
  it('normalizes a JSON verdict embedded in model text', () => {
    expect(
      parseBestOfJudgeVerdict(
        'Result:\n{"winner":"b","rationale":"robust","merge_hints":["keep tests"]}'
      )
    ).toEqual({
      winner: 'B',
      rationale: 'robust',
      merge_hints: ['keep tests'],
    });
  });

  it('rejects a non-object response and preserves the caller fallback', () => {
    expect(parseBestOfJudgeVerdict('[{"winner":"A"}]')).toBeNull();
    expect(parseBestOfJudgeVerdict('{"winner":{"value":"A"}}')).toBeNull();
  });

  it('drops non-string merge hints instead of stringifying arbitrary values', () => {
    expect(
      parseBestOfJudgeVerdict('{"winner":"A","merge_hints":["valid",{"secret":"x"},3]}')
    ).toEqual({
      winner: 'A',
      merge_hints: ['valid'],
    });
  });

  it('rejects nested dangerous JSON keys', () => {
    expect(parseBestOfJudgeVerdict('{"winner":"A","meta":{"__proto__":{}}}')).toBeNull();
  });
});
