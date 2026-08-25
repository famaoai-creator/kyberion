import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';

// Real-fs seam: the loader only touches these two secure-io functions.
vi.mock('./secure-io.js', () => ({
  safeExistsSync: (p: string) => fs.existsSync(p),
  safeReadFile: (p: string, _opts: any) => fs.readFileSync(p, 'utf8'),
  loadJson: (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')),
}));

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  loadRetentionCatalog,
  retentionTtlMsForPath,
  retentionTtlDaysForPath,
  retentionEntryForExactPath,
  reviewRequiredCatalogPaths,
  runtimeRetentionRules,
  coveredRuntimeSubdirs,
  BUILTIN_RETENTION_DEFAULTS,
  RETENTION_DAY_MS,
} from './storage-retention-catalog.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEEDED_CATALOG = path.join(
  REPO_ROOT,
  'knowledge/product/governance/storage-retention-catalog.json'
);
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'knowledge/product/schemas/storage-retention-catalog.schema.json'
);

let tmpDir: string;

function writeCatalog(content: unknown): string {
  const p = path.join(tmpDir, 'storage-retention-catalog.json');
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
}

describe('storage-retention-catalog', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-retention-catalog-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('seeded governance catalog (read-only)', () => {
    it('validates against the JSON schema', () => {
      const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      const catalog = JSON.parse(fs.readFileSync(SEEDED_CATALOG, 'utf8'));
      const ajv = new Ajv({ allErrors: true });
      const validate = ajv.compile(schema);
      const valid = validate(catalog);
      expect(validate.errors ?? []).toEqual([]);
      expect(valid).toBe(true);
    });

    it('loads cleanly and mirrors the pre-catalog constants exactly (behavior-unchanged seed)', () => {
      const loaded = loadRetentionCatalog({ catalogPath: SEEDED_CATALOG });
      expect(loaded.source).toBe('catalog');
      expect(loaded.warnings).toEqual([]);

      // TTLs must match the former in-code constants 1:1. AL-04 added further
      // runtime entries around them, so the seed values are asserted by lookup
      // rather than by whole-list equality.
      expect(retentionTtlMsForPath(loaded, 'active/shared/tmp')).toBe(24 * 60 * 60 * 1000);
      expect(retentionTtlDaysForPath(loaded, 'active/shared/logs')).toBe(30);
      const ttlBySubdir = new Map(
        runtimeRetentionRules(loaded).map((rule) => [rule.subdir, rule.ttlMs])
      );
      expect(ttlBySubdir.get('browser-receipts')).toBe(90 * RETENTION_DAY_MS);
      expect(ttlBySubdir.get('procedure-deltas')).toBe(14 * RETENTION_DAY_MS);
      expect(ttlBySubdir.get('a2a-conversations')).toBe(30 * RETENTION_DAY_MS);
      // data-vault is a note-only (self-expiring) entry: declared but no TTL.
      const vault = loaded.entries.find((e) => e.path === 'active/shared/data-vault');
      expect(vault).toBeDefined();
      expect(vault?.ttl_days).toBeUndefined();
    });

    it('DA-08: the ingest system directories are catalog-governed (janitor never reports them uncovered)', () => {
      const loaded = loadRetentionCatalog({ catalogPath: SEEDED_CATALOG });

      // Dedup registry home: load-bearing state, never TTL-deleted.
      expect(retentionEntryForExactPath(loaded, 'active/shared/runtime/ingest')).toMatchObject({
        artifact_class: 'state',
        action: 'review_required',
      });
      // Sync cursors: load-bearing state, purged per tenant by offboarding only.
      expect(
        retentionEntryForExactPath(loaded, 'active/shared/runtime/ingest-cursors')
      ).toMatchObject({ artifact_class: 'state', action: 'review_required' });
      // Quota counters: daily time series, TTL-deleted after 30d.
      expect(
        retentionEntryForExactPath(loaded, 'active/shared/runtime/ingest/quota')
      ).toMatchObject({ artifact_class: 'log', ttl_days: 30, action: 'delete' });
      const quotaRule = runtimeRetentionRules(loaded).find(
        (rule) => rule.subdir === 'ingest/quota'
      );
      expect(quotaRule?.ttlMs).toBe(30 * RETENTION_DAY_MS);

      // Both top-level ingest dirs count as covered for the janitor's
      // uncovered-runtime report.
      const covered = coveredRuntimeSubdirs(loaded);
      expect(covered.has('ingest')).toBe(true);
      expect(covered.has('ingest-cursors')).toBe(true);

      // Tenant knowledge (incl. the DA-05 _ledger/) is explicitly declared
      // review_required — never auto-deletable, offboarding-only removal.
      expect(retentionEntryForExactPath(loaded, 'knowledge/confidential')).toMatchObject({
        artifact_class: 'evidence',
        action: 'review_required',
      });
      expect(reviewRequiredCatalogPaths(loaded)).toEqual(
        expect.arrayContaining([
          'active/shared/runtime/ingest',
          'active/shared/runtime/ingest-cursors',
          'knowledge/confidential',
        ])
      );
    });

    it('builtin defaults are themselves schema-shaped (same vocabulary)', () => {
      const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      const ajv = new Ajv({ allErrors: true });
      const validate = ajv.compile(schema);
      expect(validate({ version: '1.0.0', entries: [...BUILTIN_RETENTION_DEFAULTS] })).toBe(true);
    });
  });

  describe('loadRetentionCatalog fail-safe fallback', () => {
    it('falls back to builtin defaults when the catalog file is missing', () => {
      const loaded = loadRetentionCatalog({
        catalogPath: path.join(tmpDir, 'does-not-exist.json'),
      });
      expect(loaded.source).toBe('builtin-defaults');
      expect(loaded.entries).toEqual([...BUILTIN_RETENTION_DEFAULTS]);
      expect(loaded.warnings).toHaveLength(1);
      expect(loaded.warnings[0]).toContain('not found');
    });

    it('falls back to builtin defaults on corrupt JSON without throwing', () => {
      const p = writeCatalog('{not json!!');
      const loaded = loadRetentionCatalog({ catalogPath: p });
      expect(loaded.source).toBe('builtin-defaults');
      expect(loaded.entries).toEqual([...BUILTIN_RETENTION_DEFAULTS]);
      expect(loaded.warnings[0]).toContain('corrupt');
    });

    it('falls back when entries is missing or empty', () => {
      const p = writeCatalog({ version: '1.0.0', entries: [] });
      const loaded = loadRetentionCatalog({ catalogPath: p });
      expect(loaded.source).toBe('builtin-defaults');
    });

    it('falls back on an invalid artifact_class', () => {
      const p = writeCatalog({
        version: '1.0.0',
        entries: [
          { path: 'active/shared/tmp', artifact_class: 'garbage', ttl_days: 1, action: 'delete' },
        ],
      });
      const loaded = loadRetentionCatalog({ catalogPath: p });
      expect(loaded.source).toBe('builtin-defaults');
      expect(loaded.warnings[0]).toContain('artifact_class');
    });

    it('falls back on a non-positive ttl_days', () => {
      const p = writeCatalog({
        version: '1.0.0',
        entries: [
          { path: 'active/shared/tmp', artifact_class: 'tmp', ttl_days: 0, action: 'delete' },
        ],
      });
      expect(loadRetentionCatalog({ catalogPath: p }).source).toBe('builtin-defaults');
    });

    it('falls back on duplicate paths', () => {
      const p = writeCatalog({
        version: '1.0.0',
        entries: [
          { path: 'active/shared/tmp', artifact_class: 'tmp', ttl_days: 1, action: 'delete' },
          { path: 'active/shared/tmp', artifact_class: 'tmp', ttl_days: 2, action: 'delete' },
        ],
      });
      const loaded = loadRetentionCatalog({ catalogPath: p });
      expect(loaded.source).toBe('builtin-defaults');
      expect(loaded.warnings[0]).toContain('duplicate');
    });

    it('falls back on path traversal / absolute paths', () => {
      for (const bad of ['/etc', 'active/../secrets', 'active/shared/tmp/']) {
        const p = writeCatalog({
          version: '1.0.0',
          entries: [{ path: bad, artifact_class: 'tmp', ttl_days: 1, action: 'delete' }],
        });
        expect(loadRetentionCatalog({ catalogPath: p }).source).toBe('builtin-defaults');
      }
    });
  });

  describe('valid custom catalog', () => {
    it('is used as-is: TTL overrides and runtime rules derive from it', () => {
      const p = writeCatalog({
        version: '1.0.0',
        entries: [
          { path: 'active/shared/tmp', artifact_class: 'tmp', ttl_days: 3, action: 'delete' },
          { path: 'active/shared/logs', artifact_class: 'log', ttl_days: 7, action: 'delete' },
          {
            path: 'active/shared/runtime/custom-cache',
            artifact_class: 'cache',
            ttl_days: 2,
            action: 'delete',
          },
          {
            path: 'active/shared/runtime/receipts/nested',
            artifact_class: 'evidence',
            action: 'archive',
            audit: true,
            note: 'note-only, no TTL yet',
          },
        ],
      });
      const loaded = loadRetentionCatalog({ catalogPath: p });
      expect(loaded.source).toBe('catalog');
      expect(loaded.warnings).toEqual([]);
      expect(retentionTtlMsForPath(loaded, 'active/shared/tmp')).toBe(3 * RETENTION_DAY_MS);
      expect(retentionTtlDaysForPath(loaded, 'active/shared/logs')).toBe(7);
      expect(retentionTtlMsForPath(loaded, 'active/shared/never-declared')).toBeNull();
      // Only TTL'd runtime entries become scan rules.
      expect(runtimeRetentionRules(loaded).map(({ subdir, ttlMs }) => ({ subdir, ttlMs }))).toEqual(
        [{ subdir: 'custom-cache', ttlMs: 2 * RETENTION_DAY_MS }]
      );
      // Coverage reporting counts top-level runtime subdirs with or without TTL.
      expect([...coveredRuntimeSubdirs(loaded)].sort()).toEqual(['custom-cache', 'receipts']);
    });
  });
});
