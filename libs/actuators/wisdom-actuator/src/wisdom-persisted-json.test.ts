import { describe, expect, it } from 'vitest';
import {
  parseWisdomJsonObject,
  parseWisdomReconcileStrategy,
  readWisdomRecordArray,
  readWisdomStringArray,
} from './wisdom-persisted-json.js';

describe('wisdom persisted JSON boundary', () => {
  it('accepts an object while rejecting non-object roots and dangerous keys', () => {
    expect(parseWisdomJsonObject({ topic: 'decision' })).toEqual({ topic: 'decision' });
    expect(parseWisdomJsonObject(null)).toBeNull();
    expect(parseWisdomJsonObject([])).toBeNull();
    expect(parseWisdomJsonObject({ constructor: { polluted: true } })).toBeNull();
  });

  it('requires declared record and string arrays to have the correct shape', () => {
    expect(
      readWisdomRecordArray({ hypotheses: [{ id: 'H-1' }] }, ['hypotheses'], 'source')
    ).toEqual([{ id: 'H-1' }]);
    expect(() =>
      readWisdomRecordArray({ hypotheses: ['not-a-record'] }, ['hypotheses'], 'source')
    ).toThrow('[WISDOM_JSON_SHAPE_INVALID]');
    expect(() =>
      readWisdomStringArray({ evidence_refs: ['ok', 1] }, 'evidence_refs', 'hypothesis')
    ).toThrow('[WISDOM_JSON_SHAPE_INVALID]');
  });

  it('validates reconcile strategies and nested control steps before execution', () => {
    const parsed = parseWisdomReconcileStrategy({
      strategies: [
        {
          id: 'safe-read',
          pipeline: [
            {
              type: 'control',
              op: 'if',
              params: { then: [{ type: 'capture', op: 'query', params: {} }] },
            },
          ],
        },
      ],
    });
    expect(parsed?.strategies[0]?.pipeline[0]?.type).toBe('control');
    expect(
      parseWisdomReconcileStrategy({ strategies: [{ pipeline: [{ type: 'capture' }] }] })
    ).toBeNull();
    expect(
      parseWisdomReconcileStrategy({
        strategies: [{ pipeline: [{ type: 'control', op: 'if', params: { then: ['bad'] } }] }],
      })
    ).toBeNull();
  });
});
