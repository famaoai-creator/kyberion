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
    safeUnlinkSync: (p: string) => actual.unlinkSync(p),
    safeRmSync: (p: string, opts: any) => actual.rmSync(p, opts),
    safeExistsSync: (p: string) => actual.existsSync(p),
    safeReadFile: (p: string, opts: any) => actual.readFileSync(p, opts),
    safeMkdir: (p: string, opts: any) => actual.mkdirSync(p, opts),
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

import { scanTmp, rotateLogs, scanRuntime, runJanitor, DEFAULT_TMP_TTL_MS } from './storage-janitor.js';

function writeFile(filePath: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function setMtime(filePath: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(filePath, t, t);
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

  describe('runJanitor', () => {
    it('returns a valid report shape', () => {
      const report = runJanitor({ dryRun: true });
      expect(report).toMatchObject({
        expiredTmp: expect.any(Number),
        deletedTmp: expect.any(Number),
        expiredLogs: expect.any(Number),
        rotatedLogs: expect.any(Number),
        expiredDataVault: expect.any(Number),
        deletedDataVault: expect.any(Number),
        expiredRuntime: expect.any(Number),
        deletedRuntime: expect.any(Number),
        errors: expect.any(Array),
        timestamp: expect.any(String),
        dryRun: true,
      });
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
});
