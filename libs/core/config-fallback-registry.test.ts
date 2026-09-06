import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfigFallbackRegistryAtPath } from './config-fallback-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const TEST_ROOT = pathResolver.sharedTmp('config-fallback-registry-loader-test');

afterEach(() => safeRmSync(TEST_ROOT, { recursive: true, force: true }));

describe('config fallback registry loader', () => {
  it('loads a valid registry through the canonical schema boundary', () => {
    safeMkdir(TEST_ROOT, { recursive: true });
    const filePath = path.join(TEST_ROOT, 'registry.json');
    safeWriteFile(
      filePath,
      JSON.stringify({
        version: '1.0.0',
        entries: [
          {
            knowledge_path: 'product/governance/example.json',
            first_seen: '2026-09-03T00:00:00.000Z',
            last_seen: '2026-09-03T00:00:01.000Z',
            occurrence_count: 1,
            last_error: 'missing file',
            reason: 'file_not_found',
            defaults_snapshot: { enabled: true },
            resolved: false,
          },
        ],
      })
    );

    expect(loadConfigFallbackRegistryAtPath(filePath).entries).toHaveLength(1);
  });

  it('rejects malformed entries and directories before registry use', () => {
    safeMkdir(TEST_ROOT, { recursive: true });
    const invalidPath = path.join(TEST_ROOT, 'invalid.json');
    safeWriteFile(
      invalidPath,
      JSON.stringify({ version: '1.0.0', entries: [{ knowledge_path: 'x', resolved: false }] })
    );
    expect(() => loadConfigFallbackRegistryAtPath(invalidPath)).toThrow(
      'Invalid catalog config-fallback-registry'
    );

    const directoryPath = path.join(TEST_ROOT, 'directory.json');
    safeMkdir(directoryPath, { recursive: true });
    expect(() => loadConfigFallbackRegistryAtPath(directoryPath)).toThrow(
      'registry must be a regular file'
    );
  });
});
