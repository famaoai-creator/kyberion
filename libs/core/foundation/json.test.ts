import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getFoundationIo,
  registerFoundationIo,
  type FoundationIo,
  type FoundationReadOptions,
} from './io.js';
import {
  parseSafeJsonInput,
  parseSafeJsonEntriesInput,
  parseSafeJsonObjectValue,
  parsePersistedPipelineStrategy,
  readJsonObjectRequest,
  readJsonLines,
  writeJson,
} from './json.js';
import { safeReadFile, safeRmSync } from '../secure-io.js';

describe('foundation exclusive JSON writer', () => {
  const directory = 'active/shared/tmp/foundation-json-exclusive-tests';
  afterEach(() => safeRmSync(directory, { recursive: true, force: true }));

  it('creates pretty JSON with a final newline and preserves existing reviewed bytes', () => {
    const file = `${directory}/reviewed.json`;
    writeJson(file, { digest: 'reviewed' }, { createOnly: true });
    const original = safeReadFile(file, { encoding: 'utf8' }).toString();
    expect(original).toBe('{\n  "digest": "reviewed"\n}\n');
    expect(() => writeJson(file, { digest: 'replacement' }, { createOnly: true })).toThrow();
    expect(safeReadFile(file, { encoding: 'utf8' }).toString()).toBe(original);
    writeJson(file, { digest: 'ordinary-update' });
    expect(safeReadFile(file, { encoding: 'utf8' }).toString()).toContain('ordinary-update');
  });

  it('fails closed without an exclusive bridge instead of falling back to overwrite', () => {
    const original = getFoundationIo();
    let writes = 0;
    registerFoundationIo({
      ...original,
      createExclusiveFile: undefined,
      writeFile: () => {
        writes++;
      },
    });
    try {
      expect(() => writeJson(`${directory}/reviewed.json`, {}, { createOnly: true })).toThrow(
        'secure_foundation_exclusive_io_not_registered'
      );
      expect(writes).toBe(0);
    } finally {
      registerFoundationIo(original);
    }
  });
});

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

  it('validates JSON entries independently so unsafe siblings are skipped', () => {
    expect(
      parseSafeJsonEntriesInput('[{"__proto__":{"polluted":true}},{"topic":"valid"}]', 'entries')
    ).toEqual([{ topic: 'valid' }]);
    expect(() => parseSafeJsonEntriesInput('{', 'entries')).toThrow('entries must be valid JSON');
  });

  it('validates persisted pipeline strategy steps before execution', () => {
    const parsed = parsePersistedPipelineStrategy({
      strategies: [
        {
          pipeline: [
            {
              type: 'control',
              op: 'if',
              params: {
                condition: { path: 'ready', equals: true },
                then: [{ type: 'apply', op: 'log', params: { message: 'ready' } }],
              },
            },
          ],
        },
      ],
    });

    expect(parsed.strategies[0].pipeline[0].params.then).toEqual([
      { type: 'apply', op: 'log', params: { message: 'ready' } },
    ]);
    expect(() =>
      parsePersistedPipelineStrategy({
        strategies: [{ pipeline: [{ type: 'apply', op: 'log', params: [] }] }],
      })
    ).toThrow('params must be a JSON object');
    expect(() =>
      parsePersistedPipelineStrategy({
        strategies: [
          {
            pipeline: [
              {
                type: 'control',
                op: 'if',
                params: {
                  then: [
                    {
                      type: 'apply',
                      op: 'log',
                      params: JSON.parse('{"__proto__":{}}') as Record<string, unknown>,
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
    ).toThrow('dangerous JSON key');
  });

  it.each([
    ['malformed JSON', () => Promise.reject(new SyntaxError('invalid JSON'))],
    ['null', async () => null],
    ['array', async () => []],
    ['dangerous object', async () => ({ nested: { constructor: {} } })],
  ])('rejects %s at the async request boundary', async (_label, json) => {
    await expect(readJsonObjectRequest({ json }, 'surface request')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('returns a safe JSON object unchanged at the async request boundary', async () => {
    const body = { action: 'approve', nested: { value: true } };
    await expect(
      readJsonObjectRequest({ json: async () => body }, 'surface request')
    ).resolves.toEqual({
      ok: true,
      body,
    });
  });
});

describe('foundation JSONL reader', () => {
  let original: FoundationIo;
  const files = new Map<string, string>();
  let capturedReadOptions: FoundationReadOptions | undefined;

  beforeEach(() => {
    original = getFoundationIo();
    registerFoundationIo({
      loadJson: () => {
        throw new Error('not used');
      },
      loadJsonIfPresent: () => null,
      appendFile: () => undefined,
      exists: (filePath) => files.has(filePath),
      readFile: (filePath, options) => {
        capturedReadOptions = options;
        return files.get(filePath) || '';
      },
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

  it('forwards governed read options to the whole JSONL file', () => {
    files.set('events.jsonl', '{"id":1}\n');

    expect(
      readJsonLines<{ id: number }>('events.jsonl', {
        readOptions: { maxSizeMB: 5, label: 'bounded event store' },
      })
    ).toEqual([{ id: 1 }]);
    expect(capturedReadOptions).toEqual({ maxSizeMB: 5, label: 'bounded event store' });
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
      onMalformed: (error, lineNumber, rawLine) => {
        errors.push(`${lineNumber}:${rawLine}:${String(error).slice(0, 12)}`);
      },
    });

    expect(records).toEqual([{ id: 1 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^2:not-json:/);
  });

  it('passes the original raw line to domain mappers', () => {
    files.set('events.jsonl', '{"id":1}\n  {"id":2}  \n');
    const rawLines: string[] = [];

    expect(
      readJsonLines<{ id: number }>('events.jsonl', {
        map: (value, _lineNumber, rawLine) => {
          rawLines.push(rawLine);
          return value as { id: number };
        },
      })
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect(rawLines).toEqual(['{"id":1}', '  {"id":2}  ']);
  });
});
