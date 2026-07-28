// DA-04 acceptance (3): re-submitting the same document does not register a
// new entry, and a same-source different-hash re-ingest surfaces a
// supersedes_candidate (for DA-05's supersede flow). Hermetic: the registry
// path is overridden to a fixture under active/shared/tmp.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from '@agent/core';
import { dedupContent } from './dedup.js';

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
  });
});
