import { describe, expect, it } from 'vitest';
import { repairJsonString, tryRepairJson } from './json-repair.js';

describe('json-repair', () => {
  it('returns null for content without a JSON fragment', () => {
    expect(tryRepairJson('not json')).toBeNull();
  });

  it('strips markdown fences and trailing commas', () => {
    expect(tryRepairJson('```json\n{ "a": 1, }\n```')).toEqual({ a: 1 });
  });

  it('quotes simple unquoted keys and single-quoted strings', () => {
    expect(tryRepairJson("{foo: 'bar'}")).toEqual({ foo: 'bar' });
  });

  it('extracts nested arrays without truncating at the first nested closing bracket', () => {
    expect(tryRepairJson('prefix [[1], [2, 3]] suffix')).toEqual([[1], [2, 3]]);
  });

  it('keeps valid repaired JSON as a parseable string', () => {
    const repaired = repairJsonString('{foo: [1, 2,],}');
    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired as string)).toEqual({ foo: [1, 2] });
  });
});
