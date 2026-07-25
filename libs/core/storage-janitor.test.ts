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
    safeMkdir: (p: string, opts: any) => actual.mkdirSync(p, opts),
    safeWriteFile: (p: string, data: string) => {
      actual.mkdirSync(path.dirname(p), { recursive: true });
      actual.writeFileSync(p, data);
    },
  };
});

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
  rootDir: () => path.dirname(path.dirname(tmpDir)),
}));

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  scanTmp,
  rotateLogs,
  scanRuntime,
  sweepDelegationChildren,
  runJanitor,
  runJanitorIfStale,
  readJanitorLastRunMs,
  listUncoveredRuntimeDirs,
  DEFAULT_TMP_TTL_MS,
  type DelegationChildRecord,
} from './storage-janitor.js';
import { RETENTION_CATALOG_REPO_PATH, RETENTION_DAY_MS } from './storage-retention-catalog.js';

function writeFile(filePath: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function setMtime(filePath: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(filePath, t, t);
}

/**
 * AL-01: default catalog location under the mocked rootDir (see the
 * path-resolver mock above — rootDir() is dirname(dirname(tmpDir))).
 * The base tests never write this file, so they exercise the
 * builtin-defaults fallback — which mirrors the former constants exactly.
 */
function catalogFilePath(): string {
  return path.join(path.dirname(path.dirname(tmpDir)), ...RETENTION_CATALOG_REPO_PATH.split('/'));
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
    const base = path.dirname(path.dirname(tmpDir));
    fs.rmSync(base, { recursive: true, force: true });
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
    };
    const freshRecord: DelegationChildRecord = {
      id: 'codex-1',
      provider: 'codex',
      pid: 22222,
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // future — not stale
      budgetMs: 600000,
    };

    it('returns an empty result when the registry file does not exist', () => {
      const result = sweepDelegationChildren({ dryRun: true, killFn: vi.fn() });
      expect(result).toEqual({ stale: [], killed: [], errors: [] });
    });

    it('dry-run reports stale entries without killing anything or mutating the registry', () => {
      writeRegistry([staleRecord, freshRecord]);
      const killFn = vi.fn();

      const result = sweepDelegationChildren({ dryRun: true, killFn });

      expect(result.stale.map((r) => r.id)).toEqual(['claude-1']);
      expect(result.killed).toHaveLength(0);
      expect(killFn).not.toHaveBeenCalled();
      expect(readRegistryRaw()).toHaveLength(2); // untouched
    });

    it('real mode kills stale PIDs via the injected killFn and removes them from the registry', () => {
      writeRegistry([staleRecord, freshRecord]);
      const killFn = vi.fn();

      const result = sweepDelegationChildren({ dryRun: false, killFn });

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

      const result = sweepDelegationChildren({ dryRun: false, killFn });

      expect(result.stale).toHaveLength(0);
      expect(killFn).not.toHaveBeenCalled();
      expect(readRegistryRaw()).toHaveLength(1);
    });

    it('removes the stale record and reports the error even when killFn throws (e.g. process already gone)', () => {
      writeRegistry([staleRecord]);
      const killFn = vi.fn(() => {
        throw new Error('ESRCH: no such process');
      });

      const result = sweepDelegationChildren({ dryRun: false, killFn });

      expect(result.killed).toHaveLength(0);
      expect(result.errors[0]).toContain('ESRCH');
      expect(readRegistryRaw()).toHaveLength(0);
    });

    it('skips records with no numeric pid (nothing to kill) but still drops them once stale', () => {
      const noPidRecord: DelegationChildRecord = { ...staleRecord, id: 'no-pid', pid: undefined };
      writeRegistry([noPidRecord]);
      const killFn = vi.fn();

      const result = sweepDelegationChildren({ dryRun: false, killFn });

      expect(killFn).not.toHaveBeenCalled();
      expect(result.stale.map((r) => r.id)).toEqual(['no-pid']);
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

  describe('runJanitor', () => {
    it('returns a valid report shape', () => {
      const report = runJanitor({ dryRun: true });
      expect(report).toMatchObject({
        uncoveredRuntimeDirs: expect.any(Array),
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
