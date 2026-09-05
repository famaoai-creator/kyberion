import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  loadKnowledgeIndexUsageAtPath,
  writeKnowledgeIndexUsageAtPath,
  type KnowledgeIndexUsageMap,
} from './knowledge-index-usage.js';

const TEST_ROOT = pathResolver.sharedTmp(`knowledge-index-usage-test/${process.pid}`);
const TEST_PATH = `${TEST_ROOT}/ki-usage.json`;

const validUsage: KnowledgeIndexUsageMap = {
  '0123456789abcdef': '2026-09-03T00:00:00.000Z',
};

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('knowledge index usage contract', () => {
  it('round-trips a schema-valid usage map', () => {
    writeKnowledgeIndexUsageAtPath(TEST_PATH, validUsage);
    expect(loadKnowledgeIndexUsageAtPath(TEST_PATH)).toEqual(validUsage);
  });

  it('returns an empty map for missing or schema-invalid usage data', () => {
    expect(loadKnowledgeIndexUsageAtPath(TEST_PATH)).toEqual({});
    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(TEST_PATH, JSON.stringify({ invalid: 'not-a-date' }));
    expect(loadKnowledgeIndexUsageAtPath(TEST_PATH)).toEqual({});
  });

  it('rejects writes to a directory', () => {
    safeMkdir(TEST_PATH, { recursive: true });
    expect(() => writeKnowledgeIndexUsageAtPath(TEST_PATH, validUsage)).toThrow(
      '[KNOWLEDGE_INDEX_USAGE] usage must be a regular file'
    );
  });
});
