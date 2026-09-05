import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  loadKnowledgeIndexCacheAtPath,
  writeKnowledgeIndexCacheAtPath,
  type KnowledgeIndexCache,
} from './knowledge-index-cache.js';

const TEST_ROOT = pathResolver.sharedTmp(`knowledge-index-cache-test/${process.pid}`);
const TEST_PATH = `${TEST_ROOT}/ki-0123456789abcdef.json`;

const validCache: KnowledgeIndexCache = {
  scopeHash: '0123456789abcdef',
  model: 'test-model',
  builtAt: '2026-09-03T00:00:00.000Z',
  entries: [{ source: 'knowledge/example.md', textHash: '0123456789ab', vector: [0.1, -0.2] }],
};

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('knowledge index cache contract', () => {
  it('writes and loads a schema-valid cache', () => {
    writeKnowledgeIndexCacheAtPath(TEST_PATH, validCache);

    expect(loadKnowledgeIndexCacheAtPath(TEST_PATH)).toEqual(validCache);
    expect(String(safeReadFile(TEST_PATH, { encoding: 'utf8' }))).toContain('test-model');
  });

  it('treats malformed persisted cache as absent', () => {
    safeWriteFile(TEST_PATH, JSON.stringify({ ...validCache, unexpected: true }));

    expect(loadKnowledgeIndexCacheAtPath(TEST_PATH)).toBeNull();
  });

  it('rejects invalid cache writes and non-regular targets', () => {
    expect(() =>
      writeKnowledgeIndexCacheAtPath(TEST_PATH, {
        ...validCache,
        scopeHash: 'not-a-scope-hash',
      })
    ).toThrow(/Invalid catalog knowledge-index-cache/);

    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(TEST_PATH, '{}');
    expect(() => writeKnowledgeIndexCacheAtPath(TEST_ROOT, validCache)).toThrow(
      'Knowledge index cache must be a regular file'
    );
  });
});
