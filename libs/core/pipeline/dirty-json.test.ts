import { describe, expect, it } from 'vitest';

import { DIRTY_JSON_ERRORS, DIRTY_JSON_MAX_INPUT_CHARS, parseDirtyJson } from './dirty-json.js';

describe('parseDirtyJson', () => {
  it('returns already-valid JSON unchanged', () => {
    const input = '{ "a": 1, "b": [true, null, "x"], "note": "it\'s fine" }';
    const result = parseDirtyJson(input);
    expect(result).toEqual({
      ok: true,
      value: { a: 1, b: [true, null, 'x'], note: "it's fine" },
    });
  });

  it('fixes trailing commas in objects and arrays', () => {
    expect(parseDirtyJson('{"a": 1, "b": [1, 2, 3,], }')).toEqual({
      ok: true,
      value: { a: 1, b: [1, 2, 3] },
    });
  });

  it('converts single-quoted strings and keys', () => {
    expect(parseDirtyJson("{ capability: 'demo', action: 'run' }")).toEqual({
      ok: true,
      value: { capability: 'demo', action: 'run' },
    });
  });

  it('keeps apostrophes inside double-quoted strings literal', () => {
    expect(parseDirtyJson('{"note": "it\'s broken", }')).toEqual({
      ok: true,
      value: { note: "it's broken" },
    });
  });

  it('quotes unquoted values and normalizes bare literals', () => {
    expect(parseDirtyJson('{a: foo, b: undefined, c: TRUE, d: -12.5e2}')).toEqual({
      ok: true,
      value: { a: 'foo', b: null, c: true, d: -1250 },
    });
  });

  it('closes unbalanced braces left by truncation', () => {
    expect(parseDirtyJson('{"tool_name":"x","tool_args":{}')).toEqual({
      ok: true,
      value: { tool_name: 'x', tool_args: {} },
    });
  });

  it('closes unbalanced arrays and nested objects', () => {
    expect(parseDirtyJson('{"a": [1, {"b": 2}')).toEqual({
      ok: true,
      value: { a: [1, { b: 2 }] },
    });
  });

  it('pairs a mismatched closer with the outer opener like Agent Zero', () => {
    expect(parseDirtyJson('{"a": [1, 2}}}')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
    expect(parseDirtyJson('[{]}]')).toEqual({ ok: true, value: [{}] });
  });

  it('closes an unterminated string before closing the object', () => {
    expect(parseDirtyJson('{"a": "truncated text')).toEqual({
      ok: true,
      value: { a: 'truncated text' },
    });
  });

  it('supplies null for a value the truncated input never provided', () => {
    expect(parseDirtyJson('{"a": "x", "b":')).toEqual({
      ok: true,
      value: { a: 'x', b: null },
    });
  });

  it('extracts a JSON block from surrounding prose and markdown fences', () => {
    expect(
      parseDirtyJson('Here is the plan:\n```json\n{ "a": 1, }\n```\nHope that helps!')
    ).toEqual({ ok: true, value: { a: 1 } });
  });

  it('strips line and block comments', () => {
    expect(
      parseDirtyJson('{\n// leading comment\n"a": 1, /* mid */ "b": 2 // trailing\n}')
    ).toEqual({ ok: true, value: { a: 1, b: 2 } });
  });

  it('rejects non-JSON input with a stable code', () => {
    expect(parseDirtyJson('this is not json')).toEqual({
      ok: false,
      error: DIRTY_JSON_ERRORS.NO_JSON_BLOCK,
    });
    expect(parseDirtyJson('')).toEqual({ ok: false, error: DIRTY_JSON_ERRORS.EMPTY_INPUT });
    expect(parseDirtyJson('   ')).toEqual({
      ok: false,
      error: DIRTY_JSON_ERRORS.EMPTY_INPUT,
    });
  });

  it('rejects JSON that stays unrepairable', () => {
    for (const input of ['{"a" 1}', '{"a": "x" "b"}', '{"a": }']) {
      const result = parseDirtyJson(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(DIRTY_JSON_ERRORS.UNREPAIRABLE);
    }
  });

  it('enforces the input size cap', () => {
    const oversized = `{"a":"${'x'.repeat(DIRTY_JSON_MAX_INPUT_CHARS)}` + '"}';
    const result = parseDirtyJson(oversized);
    expect(result).toEqual({ ok: false, error: DIRTY_JSON_ERRORS.INPUT_TOO_LARGE });
  });

  it('never admits dangerous keys through the repair path', () => {
    const result = parseDirtyJson('{"__proto__":{"polluted":true}');
    expect(result.ok).toBe(false);
  });
});
