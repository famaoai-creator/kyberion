import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// Stub secure-io to use real temp fs so we can test file operations
vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeReaddir: (dir: string) => actual.readdirSync(dir),
    safeStat: (p: string) => actual.statSync(p),
    safeLstat: (p: string) => actual.lstatSync(p),
    safeUnlinkSync: (p: string) => actual.unlinkSync(p),
    safeRmSync: (p: string, opts: any) => actual.rmSync(p, opts),
    safeExistsSync: (p: string) => actual.existsSync(p),
    safeReadFile: (p: string, opts: any) => actual.readFileSync(p, opts),
    loadJson: (p: string) => JSON.parse(actual.readFileSync(p, 'utf8')),
    safeMkdir: (p: string, opts: any) => actual.mkdirSync(p, opts),
    safeWriteFile: (p: string, data: string) => {
      actual.mkdirSync(path.dirname(p), { recursive: true });
      actual.writeFileSync(p, data);
    },
    // AL-04: soft-delete moves + deletion audit appends.
    safeAppendFileSync: (p: string, data: string) => {
      actual.mkdirSync(path.dirname(p), { recursive: true });
      actual.appendFileSync(p, data);
    },
    safeMoveSync: (src: string, dest: string) => {
      actual.mkdirSync(path.dirname(dest), { recursive: true });
      actual.renameSync(src, dest);
    },
  };
});

vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')),
    loadJsonIfPresent: (p: string) => {
      if (!fs.existsSync(p)) return null;
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        return null;
      }
    },
    appendFile: (p: string, data: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, data);
    },
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, 'utf8'),
    stat: (p: string) => fs.statSync(p),
    writeFile: (p: string, data: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    },
  }),
  registerFoundationIo: vi.fn(),
}));

// Override path-resolver to point at our temp dirs
let tmpDir: string;
let logsDir: string;
let dataVaultDir: string;

vi.mock('./path-resolver.js', () => ({
  sharedTmp: (sub = '') => path.join(tmpDir, sub),
  shared: (sub = '') => {
    const base = path.dirname(tmpDir); // active/shared
    return path.join(base, sub);
  },
  sharedLogsAudit: (sub = '') => path.join(path.dirname(tmpDir), 'logs', 'audit', sub),
  // Repo root of the temp fixture: tmpDir is <root>/active/shared/tmp, so
  // repo-relative paths ('active/shared/...', 'active/archive/.trash/...')
  // resolve exactly as they do in the real tree.
  rootDir: () => testRootDir(),
}));

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  scanTmp,
  rotateLogs,
  scanRuntime,
  sweepDelegationChildren,
  sweepTrash,
  restoreFromTrash,
  listReviewRequiredDirs,
  runJanitor,
  runJanitorIfStale,
  readJanitorLastRunMs,
  listUncoveredRuntimeDirs,
  DEFAULT_TMP_TTL_MS,
  DEFAULT_TRASH_GRACE_DAYS,
  TRASH_REPO_SUBPATH,
  type DelegationChildRecord,
} from './storage-janitor.js';
import {
  RETENTION_CATALOG_REPO_PATH,
  RETENTION_DAY_MS,
  STORAGE_RETENTION_AUDIT_FILENAME,
} from './storage-retention-catalog.js';

function writeFile(filePath: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function setMtime(filePath: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(filePath, t, t);
}

/** Repo root of the temp fixture — tmpDir is `<root>/active/shared/tmp`. */
function testRootDir(): string {
  return path.dirname(path.dirname(path.dirname(tmpDir)));
}

/**
 * AL-01: default catalog location under the mocked rootDir (see the
 * path-resolver mock above). The base tests never write this file, so they
 * exercise the builtin-defaults fallback — which mirrors the former
 * constants exactly.
 */
function catalogFilePath(): string {
  return path.join(testRootDir(), ...RETENTION_CATALOG_REPO_PATH.split('/'));
}

/** AL-04: absolute path of a repo-relative path inside the trash tree. */
function trashPathOf(repoRelative: string): string {
  return path.join(testRootDir(), ...TRASH_REPO_SUBPATH.split('/'), ...repoRelative.split('/'));
}

/** AL-04: parsed deletion-audit records written this test. */
function readRetentionAudit(): Array<Record<string, any>> {
  const auditPath = path.join(
    path.dirname(tmpDir),
    'logs',
    'audit',
    STORAGE_RETENTION_AUDIT_FILENAME
  );
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function writeCatalogFile(content: unknown): void {
  writeFile(
    catalogFilePath(),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  );
}

describe('storage-janitor', () => {
  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-janitor-test-'));
    tmpDir = path.join(base, 'active', 'shared', 'tmp');
    logsDir = path.join(base, 'active', 'shared', 'logs');
    dataVaultDir = path.join(base, 'active', 'shared', 'data-vault');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testRootDir(), { recursive: true, force: true });
  });

  describe('scanTmp', () => {
    it('returns empty arrays when tmp/ is empty', () => {
      const result = scanTmp({ dryRun: true });
      expect(result.expired).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);
    });

    it('identifies files older than TTL as expired', () => {
      const oldFile = path.join(tmpDir, 'old-file.json');
      writeFile(oldFile);
      setMtime(oldFile, DEFAULT_TMP_TTL_MS + 1000);

      const result = scanTmp({ dryRun: true });
      expect(result.expired).toContain(oldFile);
      expect(result.deleted).toHaveLength(0); // dry-run — no deletion
    });

    it('does not flag files within TTL', () => {
      const freshFile = path.join(tmpDir, 'fresh-file.json');
      writeFile(freshFile);
      // mtime is now — within TTL

      const result = scanTmp({ dryRun: true, ttlMs: DEFAULT_TMP_TTL_MS });
      expect(result.expired).not.toContain(freshFile);
    });

    it('deletes expired files when dryRun=false', () => {
      const oldFile = path.join(tmpDir, 'delete-me.json');
      writeFile(oldFile);
      setMtime(oldFile, DEFAULT_TMP_TTL_MS + 1000);

      const result = scanTmp({ dryRun: false });
      expect(result.deleted).toContain(oldFile);
      expect(fs.existsSync(oldFile)).toBe(false);
    });

    it('handles nested directories', () => {
      const nested = path.join(tmpDir, 'subdir', 'nested.txt');
      writeFile(nested);
      setMtime(nested, DEFAULT_TMP_TTL_MS + 1000);

      const result = scanTmp({ dryRun: true });
      expect(result.expired).toContain(nested);
    });

    it('does not recurse into symlinked directories', () => {
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-janitor-external-'));
      const externalFile = path.join(externalDir, 'outside.txt');
      const linkedDir = path.join(tmpDir, 'linked-node_modules');
      writeFile(externalFile);
      setMtime(externalFile, DEFAULT_TMP_TTL_MS + 1000);
      fs.symlinkSync(externalDir, linkedDir, 'dir');

      const result = scanTmp({ dryRun: false });

      expect(result.expired).not.toContain(externalFile);
      expect(result.deleted).not.toContain(externalFile);
      expect(fs.existsSync(externalFile)).toBe(true);
      expect(fs.lstatSync(linkedDir).isSymbolicLink()).toBe(true);
    });

    it('respects custom ttlMs', () => {
      const file = path.join(tmpDir, 'borderline.txt');
      writeFile(file);
      setMtime(file, 500); // 0.5 seconds old

      // With 1ms TTL everything is expired
      const result = scanTmp({ dryRun: true, ttlMs: 1 });
      expect(result.expired).toContain(file);

      // With 1 hour TTL the file is fresh
      const result2 = scanTmp({ dryRun: true, ttlMs: 60 * 60 * 1000 });
      expect(result2.expired).not.toContain(file);
    });
  });

  describe('rotateLogs', () => {
    it('returns empty arrays when logs/ is empty', () => {
      const result = rotateLogs({ dryRun: true });
      expect(result.expired).toHaveLength(0);
    });

    it('identifies log files older than retention period', () => {
      const oldLog = path.join(logsDir, 'audit', 'audit-2025-01-01.jsonl');
      writeFile(oldLog);
      setMtime(oldLog, 31 * 24 * 60 * 60 * 1000); // 31 days old

      const result = rotateLogs({ dryRun: true, retentionDays: 30 });
      expect(result.expired).toContain(oldLog);
    });

    it('does not flag recent log files', () => {
      const recentLog = path.join(logsDir, 'traces', 'traces-today.jsonl');
      writeFile(recentLog);
      // mtime = now

      const result = rotateLogs({ dryRun: true, retentionDays: 30 });
      expect(result.expired).not.toContain(recentLog);
    });

    it('deletes expired logs when dryRun=false', () => {
      const oldLog = path.join(logsDir, 'surfaces', 'old-surface.log');
      writeFile(oldLog);
      setMtime(oldLog, 35 * 24 * 60 * 60 * 1000);

      const result = rotateLogs({ dryRun: false, retentionDays: 30 });
      expect(result.rotated).toContain(oldLog);
      expect(fs.existsSync(oldLog)).toBe(false);
    });
  });

  describe('scanRuntime', () => {
    it('expires browser-receipts older than 90 days but keeps fresh ones', () => {
      const dir = path.join(path.dirname(tmpDir), 'runtime', 'browser-receipts');
      const oldReceipt = path.join(dir, 'RCP-old.json');
      const freshReceipt = path.join(dir, 'RCP-fresh.json');
      writeFile(oldReceipt);
      writeFile(freshReceipt);
      setMtime(oldReceipt, 91 * 24 * 60 * 60 * 1000);

      const result = scanRuntime({ dryRun: true });
      expect(result.expired).toContain(oldReceipt);
      expect(result.expired).not.toContain(freshReceipt);
    });

    it('expires procedure-deltas older than 14 days', () => {
      const dir = path.join(path.dirname(tmpDir), 'runtime', 'procedure-deltas', 'proc-1');
      const oldDelta = path.join(dir, 'delta-old.json');
      writeFile(oldDelta);
      setMtime(oldDelta, 15 * 24 * 60 * 60 * 1000);

      const result = scanRuntime({ dryRun: false });
      expect(result.deleted).toContain(oldDelta);
      expect(fs.existsSync(oldDelta)).toBe(false);
    });
  });

  /** XP-06 zombie sweep — orphaned delegation-child PID reaping. */
  describe('sweepDelegationChildren', () => {
    function registryPath(): string {
      return path.join(path.dirname(tmpDir), 'runtime', 'delegation-children.json');
    }
    function writeRegistry(records: DelegationChildRecord[]): void {
      writeFile(registryPath(), JSON.stringify(records));
    }
    function readRegistryRaw(): DelegationChildRecord[] {
      return JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    }

    const staleRecord: DelegationChildRecord = {
      id: 'claude-1',
      provider: 'claude',
      pid: 12345,
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      deadlineAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // past — stale
      budgetMs: 600000,
      pidStartedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    };
    const freshRecord: DelegationChildRecord = {
      id: 'codex-1',
      provider: 'codex',
      pid: 22222,
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // future — not stale
      budgetMs: 600000,
      pidStartedAt: new Date().toISOString(),
    };
    const processStartTimeFn = (pid: number): string | undefined =>
      pid === staleRecord.pid
        ? staleRecord.pidStartedAt
        : pid === freshRecord.pid
          ? freshRecord.pidStartedAt
          : undefined;

    it('returns an empty result when the registry file does not exist', () => {
      const result = sweepDelegationChildren({ dryRun: true, killFn: vi.fn() });
      expect(result).toEqual({ stale: [], killed: [], errors: [] });
    });

    it('dry-run reports stale entries without killing anything or mutating the registry', () => {
      writeRegistry([staleRecord, freshRecord]);
      const killFn = vi.fn();

      const result = sweepDelegationChildren({ dryRun: true, killFn, processStartTimeFn });

      expect(result.stale.map((r) => r.id)).toEqual(['claude-1']);
      expect(result.killed).toHaveLength(0);
      expect(killFn).not.toHaveBeenCalled();
      expect(readRegistryRaw()).toHaveLength(2); // untouched
    });

    it('real mode kills stale PIDs via the injected killFn and removes them from the registry', () => {
      writeRegistry([staleRecord, freshRecord]);
      const killFn = vi.fn();

      const result = sweepDelegationChildren({ dryRun: false, killFn, processStartTimeFn });

      expect(result.killed.map((r) => r.id)).toEqual(['claude-1']);
      expect(killFn).toHaveBeenCalledTimes(1);
      expect(killFn).toHaveBeenCalledWith(12345, 'SIGKILL');
      // process.kill was never touched — only the injected seam was.
      const remaining = readRegistryRaw();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('codex-1');
    });

    it('keeps fresh (non-stale) records untouched in real mode', () => {
      writeRegistry([freshRecord]);
      const killFn = vi.fn();

      const result = sweepDelegationChildren({ dryRun: false, killFn, processStartTimeFn });

      expect(result.stale).toHaveLength(0);
      expect(killFn).not.toHaveBeenCalled();
      expect(readRegistryRaw()).toHaveLength(1);
    });

    it('removes the stale record and reports the error even when killFn throws (e.g. process already gone)', () => {
      writeRegistry([staleRecord]);
      const killFn = vi.fn(() => {
        throw new Error('ESRCH: no such process');
      });

      const result = sweepDelegationChildren({ dryRun: false, killFn, processStartTimeFn });

      expect(result.killed).toHaveLength(0);
      expect(result.errors[0]).toContain('ESRCH');
      expect(readRegistryRaw()).toHaveLength(0);
    });

    it('skips records with no numeric pid (nothing to kill) but still drops them once stale', () => {
      const noPidRecord: DelegationChildRecord = { ...staleRecord, id: 'no-pid', pid: undefined };
      writeRegistry([noPidRecord]);
      const killFn = vi.fn();

      const result = sweepDelegationChildren({ dryRun: false, killFn, processStartTimeFn });

      expect(killFn).not.toHaveBeenCalled();
      expect(result.stale.map((r) => r.id)).toEqual(['no-pid']);
      expect(readRegistryRaw()).toHaveLength(0);
    });

    it('refuses to kill when the PID is reused or its start identity is unavailable', () => {
      writeRegistry([staleRecord]);
      const killFn = vi.fn();

      const result = sweepDelegationChildren({
        dryRun: false,
        killFn,
        processStartTimeFn: () => new Date().toISOString(),
      });

      expect(killFn).not.toHaveBeenCalled();
      expect(result.killed).toHaveLength(0);
      expect(result.errors.join('\n')).toContain('process identity unavailable or changed');
      expect(readRegistryRaw()).toHaveLength(0);
    });

    it('refuses zero, fractional, and non-finite PIDs', () => {
      const killFn = vi.fn();
      const records = [0, 1.5, Number.NaN].map((pid, index) => ({
        ...staleRecord,
        id: `invalid-pid-${index}`,
        pid,
      }));
      writeRegistry(records);

      const result = sweepDelegationChildren({
        dryRun: false,
        killFn,
        processStartTimeFn: () => staleRecord.pidStartedAt,
      });

      expect(killFn).not.toHaveBeenCalled();
      expect(result.killed).toHaveLength(0);
      expect(result.errors).toHaveLength(3);
      expect(readRegistryRaw()).toHaveLength(0);
    });
  });

  /** AL-01: catalog-driven TTLs, fail-safe fallback, uncovered-dir reporting. */
  describe('retention catalog integration', () => {
    it('respects a catalog-declared tmp TTL override (longer than the builtin 24h)', () => {
      writeCatalogFile({
        version: '1.0.0',
        entries: [
          { path: 'active/shared/tmp', artifact_class: 'tmp', ttl_days: 3, action: 'delete' },
        ],
      });
      const twoDaysOld = path.join(tmpDir, 'two-days-old.json');
      writeFile(twoDaysOld);
      setMtime(twoDaysOld, 2 * RETENTION_DAY_MS);
      const fourDaysOld = path.join(tmpDir, 'four-days-old.json');
      writeFile(fourDaysOld);
      setMtime(fourDaysOld, 4 * RETENTION_DAY_MS);

      const result = scanTmp({ dryRun: true });
      // 2d < catalog 3d TTL: kept (would have expired under the builtin 24h).
      expect(result.expired).not.toContain(twoDaysOld);
      expect(result.expired).toContain(fourDaysOld);
    });

    it('derives runtime scan rules from the catalog (custom subdir honored)', () => {
      writeCatalogFile({
        version: '1.0.0',
        entries: [
          {
            path: 'active/shared/runtime/custom-cache',
            artifact_class: 'cache',
            ttl_days: 1,
            action: 'delete',
          },
        ],
      });
      const dir = path.join(path.dirname(tmpDir), 'runtime', 'custom-cache');
      const oldFile = path.join(dir, 'stale.bin');
      writeFile(oldFile);
      setMtime(oldFile, 2 * RETENTION_DAY_MS);

      const result = scanRuntime({ dryRun: false });
      expect(result.deleted).toContain(oldFile);
      expect(fs.existsSync(oldFile)).toBe(false);
    });

    it('falls back to builtin defaults on a corrupt catalog — janitor never dies', () => {
      writeCatalogFile('{broken json!!');
      const oldFile = path.join(tmpDir, 'stale-under-default-ttl.json');
      writeFile(oldFile);
      setMtime(oldFile, DEFAULT_TMP_TTL_MS + 60_000);

      const report = runJanitor({ dryRun: true });
      expect(report.retentionCatalogSource).toBe('builtin-defaults');
      expect(report.retentionCatalogWarnings.length).toBeGreaterThanOrEqual(1);
      expect(report.retentionCatalogWarnings[0]).toContain('corrupt');
      // Builtin 24h tmp TTL still enforced.
      expect(report.expiredTmp).toBeGreaterThanOrEqual(1);
      expect(report.errors).toEqual([]);
    });

    it('reports runtime subdirs with no covering rule as uncovered — and never deletes them', () => {
      const runtimeRoot = path.join(path.dirname(tmpDir), 'runtime');
      const mysteryFile = path.join(runtimeRoot, 'mystery-dir', 'ancient.json');
      writeFile(mysteryFile);
      setMtime(mysteryFile, 365 * RETENTION_DAY_MS);
      // A covered dir (builtin defaults) for contrast.
      writeFile(path.join(runtimeRoot, 'browser-receipts', 'fresh.json'));

      const report = runJanitor({ dryRun: false });
      expect(report.uncoveredRuntimeDirs).toContain('active/shared/runtime/mystery-dir');
      expect(report.uncoveredRuntimeDirs).not.toContain('active/shared/runtime/browser-receipts');
      expect(fs.existsSync(mysteryFile)).toBe(true); // reported, not deleted
    });

    it('listUncoveredRuntimeDirs honors catalog coverage including note-only entries', () => {
      writeCatalogFile({
        version: '1.0.0',
        entries: [
          {
            path: 'active/shared/runtime/declared-no-ttl',
            artifact_class: 'report',
            action: 'delete',
            note: 'declared without TTL — covered for reporting purposes',
          },
        ],
      });
      const runtimeRoot = path.join(path.dirname(tmpDir), 'runtime');
      writeFile(path.join(runtimeRoot, 'declared-no-ttl', 'a.json'));
      writeFile(path.join(runtimeRoot, 'undeclared', 'b.json'));

      const uncovered = listUncoveredRuntimeDirs();
      expect(uncovered).toContain('active/shared/runtime/undeclared');
      expect(uncovered).not.toContain('active/shared/runtime/declared-no-ttl');
    });
  });

  /** AL-04: deletion audit, soft-delete grace + restore, review_required. */
  describe('soft-delete, trash sweep and review_required (AL-04)', () => {
    function writeAl04Catalog(): void {
      writeCatalogFile({
        version: '1.1.0',
        entries: [
          {
            path: 'active/shared/runtime/reports',
            artifact_class: 'report',
            ttl_days: 90,
            action: 'delete',
            audit: true,
            soft_delete_days: 14,
          },
          {
            path: 'active/shared/runtime/cache-hard',
            artifact_class: 'cache',
            ttl_days: 1,
            action: 'delete',
            audit: true,
          },
          {
            path: 'active/shared/runtime/locks',
            artifact_class: 'state',
            action: 'review_required',
            note: 'load-bearing state — never auto-deleted',
          },
          { path: 'active/archive/.trash', artifact_class: 'tmp', action: 'delete' },
        ],
      });
    }

    it('moves an expired file to the trash instead of unlinking it and audits the move', () => {
      writeAl04Catalog();
      const runtimeRoot = path.join(path.dirname(tmpDir), 'runtime');
      const expiredReport = path.join(runtimeRoot, 'reports', 'janitor-2026-01-01.json');
      writeFile(expiredReport);
      setMtime(expiredReport, 100 * RETENTION_DAY_MS);

      const result = scanRuntime({ dryRun: false });
      expect(result.softDeleted).toContain(expiredReport);
      expect(result.deleted).not.toContain(expiredReport);
      expect(fs.existsSync(expiredReport)).toBe(false);

      const repoRelative = 'active/shared/runtime/reports/janitor-2026-01-01.json';
      expect(fs.existsSync(trashPathOf(repoRelative))).toBe(true);

      const audit = readRetentionAudit();
      const record = audit.find((entry) => entry.event === 'RETENTION_SOFT_DELETE');
      expect(record).toMatchObject({
        path: repoRelative,
        trash_path: `${TRASH_REPO_SUBPATH}/${repoRelative}`,
        soft_delete_days: 14,
        artifact_class: 'report',
        policy_ref: RETENTION_CATALOG_REPO_PATH,
      });
      expect(typeof record?.reason).toBe('string');
    });

    it('hard-deletes (and audits) when the covering entry declares no grace', () => {
      writeAl04Catalog();
      const stale = path.join(path.dirname(tmpDir), 'runtime', 'cache-hard', 'blob.bin');
      writeFile(stale);
      setMtime(stale, 3 * RETENTION_DAY_MS);

      const result = scanRuntime({ dryRun: false });
      expect(result.deleted).toContain(stale);
      expect(result.softDeleted).toHaveLength(0);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(trashPathOf('active/shared/runtime/cache-hard/blob.bin'))).toBe(false);
      expect(readRetentionAudit().map((entry) => entry.event)).toContain('RETENTION_DELETE');
    });

    it('restores a soft-deleted file to its original location within the grace period', () => {
      writeAl04Catalog();
      const runtimeRoot = path.join(path.dirname(tmpDir), 'runtime');
      const expiredReport = path.join(runtimeRoot, 'reports', 'recoverable.json');
      writeFile(expiredReport, 'important');
      setMtime(expiredReport, 100 * RETENTION_DAY_MS);
      scanRuntime({ dryRun: false });
      expect(fs.existsSync(expiredReport)).toBe(false);

      const repoRelative = 'active/shared/runtime/reports/recoverable.json';
      const restored = restoreFromTrash(repoRelative);
      expect(restored.restored).toBe(true);
      expect(fs.readFileSync(expiredReport, 'utf8')).toBe('important');
      expect(fs.existsSync(trashPathOf(repoRelative))).toBe(false);
      expect(readRetentionAudit().map((entry) => entry.event)).toContain('RETENTION_RESTORED');

      // Restoring again is a structured no-op, never an error.
      expect(restoreFromTrash(repoRelative).restored).toBe(false);
    });

    it('purges trash only after the covering entry grace, then audits the purge', () => {
      writeAl04Catalog();
      const repoRelative = 'active/shared/runtime/reports/aged.json';
      const fresh = trashPathOf(repoRelative);
      writeFile(fresh);
      setMtime(fresh, 10 * RETENTION_DAY_MS); // < 14d grace

      expect(sweepTrash({ dryRun: false }).purged).toHaveLength(0);
      expect(fs.existsSync(fresh)).toBe(true);

      setMtime(fresh, 20 * RETENTION_DAY_MS); // > 14d grace
      const swept = sweepTrash({ dryRun: false });
      expect(swept.purged).toContain(fresh);
      expect(fs.existsSync(fresh)).toBe(false);
      const purgeAudit = readRetentionAudit().find(
        (entry) => entry.event === 'RETENTION_TRASH_PURGED'
      );
      expect(purgeAudit).toMatchObject({ original_path: repoRelative, soft_delete_days: 14 });
    });

    it('counts the grace from the trash time, not the mtime a move preserves', () => {
      writeAl04Catalog();
      const expiredReport = path.join(path.dirname(tmpDir), 'runtime', 'reports', 'just-aged.json');
      writeFile(expiredReport);
      setMtime(expiredReport, 400 * RETENTION_DAY_MS); // far past every grace

      scanRuntime({ dryRun: false });
      const repoRelative = 'active/shared/runtime/reports/just-aged.json';
      expect(fs.existsSync(trashPathOf(repoRelative))).toBe(true);

      // The sweep right behind the soft-delete must NOT purge it: the file
      // entered the trash now, however old its content is.
      const swept = sweepTrash({ dryRun: false });
      expect(swept.expired).toHaveLength(0);
      expect(swept.purged).toHaveLength(0);
      expect(fs.existsSync(trashPathOf(repoRelative))).toBe(true);
      expect(restoreFromTrash(repoRelative).restored).toBe(true);
    });

    it('falls back to the default grace for a trashed path with no covering entry', () => {
      writeAl04Catalog();
      const orphan = trashPathOf('active/shared/runtime/gone-dir/orphan.json');
      writeFile(orphan);
      setMtime(orphan, (DEFAULT_TRASH_GRACE_DAYS - 1) * RETENTION_DAY_MS);
      expect(sweepTrash({ dryRun: true }).expired).toHaveLength(0);

      setMtime(orphan, (DEFAULT_TRASH_GRACE_DAYS + 1) * RETENTION_DAY_MS);
      expect(sweepTrash({ dryRun: true }).expired).toContain(orphan);
      expect(fs.existsSync(orphan)).toBe(true); // dry run never purges
    });

    it('never deletes a review_required directory and surfaces it in the report', () => {
      writeAl04Catalog();
      const lock = path.join(path.dirname(tmpDir), 'runtime', 'locks', 'resource.lock');
      writeFile(lock);
      setMtime(lock, 400 * RETENTION_DAY_MS);

      const report = runJanitor({ dryRun: false });
      expect(report.reviewRequiredDirs).toContain('active/shared/runtime/locks');
      // Declared → not reported as uncovered, and never deleted.
      expect(report.uncoveredRuntimeDirs).not.toContain('active/shared/runtime/locks');
      expect(fs.existsSync(lock)).toBe(true);
    });

    it('review_required is honored even when the entry carries a ttl_days', () => {
      writeCatalogFile({
        version: '1.1.0',
        entries: [
          {
            path: 'active/shared/runtime/oauth',
            artifact_class: 'state',
            ttl_days: 1,
            action: 'review_required',
          },
        ],
      });
      const token = path.join(path.dirname(tmpDir), 'runtime', 'oauth', 'token.json');
      writeFile(token);
      setMtime(token, 30 * RETENTION_DAY_MS);

      const result = scanRuntime({ dryRun: false });
      expect(result.expired).toHaveLength(0);
      expect(fs.existsSync(token)).toBe(true);
    });

    it('runJanitor counts soft-deletes and trash outcomes in its report', () => {
      writeAl04Catalog();
      const runtimeRoot = path.join(path.dirname(tmpDir), 'runtime');
      const expiredReport = path.join(runtimeRoot, 'reports', 'counted.json');
      writeFile(expiredReport);
      setMtime(expiredReport, 100 * RETENTION_DAY_MS);
      const agedTrash = trashPathOf('active/shared/runtime/reports/already-trashed.json');
      writeFile(agedTrash);
      setMtime(agedTrash, 40 * RETENTION_DAY_MS);

      const report = runJanitor({ dryRun: false });
      expect(report.softDeleted).toBe(1);
      expect(report.expiredTrash).toBe(1);
      expect(report.purgedTrash).toBe(1);
      expect(report.errors).toEqual([]);
    });

    it('listReviewRequiredDirs reports only declared directories that exist on disk', () => {
      writeAl04Catalog();
      writeFile(path.join(path.dirname(tmpDir), 'runtime', 'locks', 'a.lock'));
      const declared = listReviewRequiredDirs();
      expect(declared).toEqual(['active/shared/runtime/locks']);
    });
  });

  describe('runJanitor', () => {
    it('returns a valid report shape', () => {
      const report = runJanitor({ dryRun: true });
      expect(report).toMatchObject({
        uncoveredRuntimeDirs: expect.any(Array),
        reviewRequiredDirs: expect.any(Array),
        softDeleted: expect.any(Number),
        expiredTrash: expect.any(Number),
        purgedTrash: expect.any(Number),
        retentionCatalogSource: 'builtin-defaults',
        retentionCatalogWarnings: expect.any(Array),
        expiredTmp: expect.any(Number),
        deletedTmp: expect.any(Number),
        expiredLogs: expect.any(Number),
        rotatedLogs: expect.any(Number),
        expiredDataVault: expect.any(Number),
        deletedDataVault: expect.any(Number),
        expiredRuntime: expect.any(Number),
        deletedRuntime: expect.any(Number),
        staleDelegationChildren: expect.any(Number),
        killedDelegationChildren: expect.any(Number),
        errors: expect.any(Array),
        timestamp: expect.any(String),
        dryRun: true,
      });
    });

    it('surfaces delegation-children staleness in dry-run without killing (runJanitor never injects a killFn, so only dry-run is safe to exercise here)', () => {
      const staleRecord: DelegationChildRecord = {
        id: 'claude-1',
        provider: 'claude',
        pid: 999999999, // never a real pid; dry-run never calls killFn/process.kill regardless
        startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        deadlineAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        budgetMs: 600000,
      };
      writeFile(
        path.join(path.dirname(tmpDir), 'runtime', 'delegation-children.json'),
        JSON.stringify([staleRecord])
      );

      const report = runJanitor({ dryRun: true });
      expect(report.staleDelegationChildren).toBeGreaterThanOrEqual(1);
      expect(report.killedDelegationChildren).toBe(0);
    });

    it('reports expired tmp files in dry-run', () => {
      const oldFile = path.join(tmpDir, 'stale.json');
      writeFile(oldFile);
      setMtime(oldFile, DEFAULT_TMP_TTL_MS + 5000);

      const report = runJanitor({ dryRun: true });
      expect(report.expiredTmp).toBeGreaterThanOrEqual(1);
      expect(report.deletedTmp).toBe(0);
    });

    it('deletes and counts correctly when dryRun=false', () => {
      const oldFile = path.join(tmpDir, 'delete-via-janitor.json');
      writeFile(oldFile);
      setMtime(oldFile, DEFAULT_TMP_TTL_MS + 5000);

      const report = runJanitor({ dryRun: false });
      expect(report.deletedTmp).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(oldFile)).toBe(false);
    });
  });

  describe('runJanitorIfStale', () => {
    it('runs when no last-run marker exists, then records the marker', () => {
      expect(readJanitorLastRunMs()).toBeNull();

      const report = runJanitorIfStale();
      expect(report).not.toBeNull();
      expect(readJanitorLastRunMs()).not.toBeNull();
    });

    it('skips when the last run is within maxAgeMs', () => {
      const first = runJanitorIfStale();
      expect(first).not.toBeNull();

      const second = runJanitorIfStale();
      expect(second).toBeNull();
    });

    it('runs again once the marker is older than maxAgeMs', () => {
      runJanitorIfStale();
      const markerPath = path.join(
        path.dirname(tmpDir),
        'runtime',
        'state',
        'janitor-last-run.json'
      );
      const stale = new Date(Date.now() - DEFAULT_TMP_TTL_MS - 60_000).toISOString();
      fs.writeFileSync(markerPath, JSON.stringify({ completed_at: stale, errors: 0 }));

      const report = runJanitorIfStale();
      expect(report).not.toBeNull();
    });

    it('dry-run does not record a marker', () => {
      const report = runJanitorIfStale({ dryRun: true });
      expect(report).not.toBeNull();
      expect(readJanitorLastRunMs()).toBeNull();
    });
  });
});
