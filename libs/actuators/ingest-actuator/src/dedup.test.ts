// DA-04 acceptance (3): re-submitting the same document does not register a
// new entry, and a same-source different-hash re-ingest surfaces a
// supersedes_candidate (for DA-05's supersede flow). Hermetic: the registry
// path is overridden to a fixture under active/shared/tmp.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { dedupContent, parseIngestRegistryRecord } from './dedup.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = '2026-07-28T00:00:00.000Z';

describe('ingest:dedup (DA-04 acceptance 3)', () => {
  let fixtureDir = '';
  let registryPath = '';

  beforeAll(() => {
    fixtureDir = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `ingest-dedup-da04-${randomUUID()}`
    );
    safeMkdir(fixtureDir, { recursive: true });
    registryPath = path.join(fixtureDir, 'content-hash-registry.jsonl');
  });

  afterAll(() => {
    if (fixtureDir) safeRmSync(fixtureDir, { recursive: true, force: true });
  });

  function readRegistryLines(): string[] {
    if (!safeExistsSync(registryPath)) return [];
    return String(safeReadFile(registryPath, { encoding: 'utf8' }))
      .split('\n')
      .filter((line) => line.trim().length > 0);
  }

  it('registers a first-seen document', () => {
    const result = dedupContent({
      content_sha256: HASH_A,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      target_path: 'knowledge/confidential/acme-corp/reports/q1.md',
      registry_path: registryPath,
      now: NOW,
    });
    expect(result).toEqual({ duplicate: false, registered: true });
    expect(readRegistryLines()).toHaveLength(1);
    expect(JSON.parse(readRegistryLines()[0])).toEqual({
      content_sha256: HASH_A,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      first_seen: NOW,
      target_path: 'knowledge/confidential/acme-corp/reports/q1.md',
    });
  });

  it('re-submitting the same document is a duplicate and does NOT register again', () => {
    const result = dedupContent({
      content_sha256: HASH_A,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      registry_path: registryPath,
      now: '2026-07-29T00:00:00.000Z',
    });
    expect(result.duplicate).toBe(true);
    expect(result.registered).toBe(false);
    expect(result.existing).toEqual({
      content_sha256: HASH_A,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      first_seen: NOW,
      target_path: 'knowledge/confidential/acme-corp/reports/q1.md',
    });
    expect(readRegistryLines()).toHaveLength(1);
  });

  it('same source_id with a different hash is an update: supersedes_candidate, not duplicate', () => {
    const result = dedupContent({
      content_sha256: HASH_B,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      registry_path: registryPath,
      now: '2026-07-30T00:00:00.000Z',
    });
    expect(result.duplicate).toBe(false);
    expect(result.registered).toBe(true);
    expect(result.supersedes_candidate).toEqual({
      content_sha256: HASH_A,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      first_seen: NOW,
      target_path: 'knowledge/confidential/acme-corp/reports/q1.md',
    });
    expect(readRegistryLines()).toHaveLength(2);
  });

  it('check-only mode (register: false) never appends', () => {
    const before = readRegistryLines().length;
    const result = dedupContent({
      content_sha256: 'c'.repeat(64),
      registry_path: registryPath,
      register: false,
    });
    expect(result).toEqual({ duplicate: false, registered: false });
    expect(readRegistryLines()).toHaveLength(before);
  });

  it('requires content_sha256', () => {
    expect(() => dedupContent({ content_sha256: '' })).toThrow(/content_sha256 is required/);
    expect(() => dedupContent({ content_sha256: 'not-a-sha256' })).toThrow(
      /content_sha256 is required/
    );
  });

  it('ignores malformed registry rows during duplicate detection', () => {
    const valid = JSON.stringify({
      content_sha256: HASH_A,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      first_seen: NOW,
    });
    safeWriteFile(
      registryPath,
      `${valid}\n${JSON.stringify({ content_sha256: HASH_A, first_seen: 42 })}\n[]\n`,
      { encoding: 'utf8' }
    );
    const result = dedupContent({
      content_sha256: HASH_A,
      registry_path: registryPath,
      register: false,
    });
    expect(result.existing).toEqual(JSON.parse(valid));
    expect(parseIngestRegistryRecord({ content_sha256: 'bad', first_seen: NOW })).toBeUndefined();
  });

  it('ignores registry rows containing dangerous keys', () => {
    safeWriteFile(
      registryPath,
      `{"content_sha256":"${HASH_A}","first_seen":"${NOW}","__proto__":{"polluted":true}}\n`,
      { encoding: 'utf8' }
    );
    expect(
      dedupContent({ content_sha256: HASH_A, registry_path: registryPath, register: false })
    ).toEqual({ duplicate: false, registered: false });
  });

  it('rejects registry paths outside the repository and through symlinks', () => {
    expect(() =>
      dedupContent({
        content_sha256: 'd'.repeat(64),
        registry_path: '/tmp/kyberion-outside-registry.jsonl',
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');

    const linkedDir = path.join(fixtureDir, 'linked-registry');
    const targetDir = path.join(fixtureDir, 'registry-target');
    safeMkdir(targetDir, { recursive: true });
    safeSymlinkSync(targetDir, linkedDir, 'dir');
    try {
      expect(() =>
        dedupContent({
          content_sha256: 'e'.repeat(64),
          registry_path: path.join(linkedDir, 'content-hash-registry.jsonl'),
        })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(linkedDir, { force: true });
      safeRmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('rejects an absolute target_path before registering a hash', () => {
    expect(() =>
      dedupContent({
        content_sha256: 'f'.repeat(64),
        registry_path: registryPath,
        target_path: '/tmp/outside-card.md',
      })
    ).toThrow('target_path must be repository-relative');
  });
});
