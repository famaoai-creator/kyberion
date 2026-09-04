import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  parseWisdomJsonObject,
  parseWisdomReconcileStrategy,
  readWisdomJsonObjectAtPath,
  readWisdomRecordArray,
  readWisdomStringArray,
} from './wisdom-persisted-json.js';

const TEST_ROOT = pathResolver.sharedTmp(`wisdom-persisted-json-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

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

  it('reads persisted objects through the regular-file and safe JSON boundary', () => {
    const filePath = `${TEST_ROOT}/valid.json`;
    safeWriteFile(filePath, '{"topic":"decision"}', { mkdir: true });

    expect(readWisdomJsonObjectAtPath(filePath)).toEqual({ topic: 'decision' });
  });

  it('rejects dangerous persisted JSON before wisdom parsing', () => {
    const filePath = `${TEST_ROOT}/dangerous.json`;
    safeWriteFile(filePath, '{"constructor":{"polluted":true}}', { mkdir: true });

    expect(() => readWisdomJsonObjectAtPath(filePath)).toThrow('dangerous JSON key');
  });

  it('rejects a directory masquerading as persisted wisdom JSON', () => {
    const directoryPath = `${TEST_ROOT}/directory.json`;
    safeMkdir(directoryPath, { recursive: true });

    expect(() => readWisdomJsonObjectAtPath(directoryPath)).toThrow('existing regular file');
  });
});
