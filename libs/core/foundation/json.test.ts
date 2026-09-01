import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFoundationIo, registerFoundationIo, type FoundationIo } from './io.js';
import { parseSafeJsonInput, parseSafeJsonObjectValue, readJsonLines } from './json.js';

describe('foundation safe JSON parser', () => {
  it('accepts safe trees and rejects malformed or dangerous input', () => {
    expect(parseSafeJsonInput('{"items":[1,{"label":"ok"}]}', 'payload')).toEqual({
      items: [1, { label: 'ok' }],
    });
    expect(() => parseSafeJsonInput('{', 'payload')).toThrow('payload must be valid JSON');
    expect(() => parseSafeJsonInput('{"nested":{"constructor":{}}}', 'payload')).toThrow(
      'payload contains a dangerous JSON key'
    );
  });

  it('requires object roots after safe-tree validation', () => {
    expect(parseSafeJsonObjectValue({ ok: true }, 'request')).toEqual({ ok: true });
    expect(() => parseSafeJsonObjectValue([], 'request')).toThrow('request must be a JSON object');
  });
});

describe('foundation JSONL reader', () => {
  let original: FoundationIo;
  const files = new Map<string, string>();

  beforeEach(() => {
    original = getFoundationIo();
    registerFoundationIo({
      loadJson: () => {
        throw new Error('not used');
      },
      loadJsonIfPresent: () => null,
      appendFile: () => undefined,
      exists: (filePath) => files.has(filePath),
      readFile: (filePath) => files.get(filePath) || '',
      stat: () => ({ mtimeMs: 0, size: 0 }),
      writeFile: () => undefined,
    });
  });

  afterEach(() => {
    files.clear();
    registerFoundationIo(original);
  });

  it('reads non-empty JSON lines and ignores blank lines', () => {
    files.set('events.jsonl', '{"id":1}\n\n {"id":2}\n');

    expect(readJsonLines<{ id: number }>('events.jsonl')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('can skip malformed or rejected records while preserving one-based line numbers', () => {
    files.set('events.jsonl', '{"id":1}\nnot-json\n{"id":3}\n');
    const seenLines: number[] = [];

    const records = readJsonLines<{ id: number }>('events.jsonl', {
      onMalformed: 'skip',
      map: (value, lineNumber) => {
        seenLines.push(lineNumber);
        const id = (value as { id?: unknown }).id;
        if (id !== 1 && id !== 3) throw new Error('domain record rejected');
        return { id: Number(id) };
      },
    });

    expect(records).toEqual([{ id: 1 }, { id: 3 }]);
    expect(seenLines).toEqual([1, 3]);
  });

  it('throws on malformed JSON by default', () => {
    files.set('events.jsonl', '{"id":1}\nnot-json\n');

    expect(() => readJsonLines('events.jsonl')).toThrow();
  });

  it('treats dangerous JSON keys as malformed rows', () => {
    files.set('events.jsonl', '{"id":1}\n{"nested":{"constructor":{}}}\n{"id":3}\n');

    expect(
      readJsonLines<{ id: number }>('events.jsonl', {
        onMalformed: 'skip',
      })
    ).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('lets domain readers translate malformed lines into stable errors', () => {
    files.set('events.jsonl', '{"id":1}\nnot-json\n');
    const errors: string[] = [];

    const records = readJsonLines<{ id: number }>('events.jsonl', {
      onMalformed: (error, lineNumber) => {
        errors.push(`${lineNumber}:${String(error).slice(0, 12)}`);
      },
    });

    expect(records).toEqual([{ id: 1 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^2:/);
  });
});
