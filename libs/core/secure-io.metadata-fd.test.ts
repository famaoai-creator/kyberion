import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { runInResourceAccessScope } from './foundation/resource-access-scope.js';
import {
  safeLinkExclusiveSync,
  safeMkdir,
  safeReadFile,
  safeReadFileRange,
  safeReadFileSnapshot,
  safeReadFileTail,
  safeReaddir,
  safeRmSync,
  safeStat,
  safeSymlinkSync,
  safeWriteFile,
  validateFileSize,
} from './secure-io.js';
import { statVetted } from './secure-io-path-guard.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readlinkSync: vi.fn(actual.readlinkSync),
    statSync: vi.fn(actual.statSync),
  };
});
vi.mock('./governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true }) },
}));

let native: typeof import('node:fs');
let base: string;
let file: string;
let alias: string;
let foreign: string;
const relative = (target: string) =>
  path.relative(pathResolver.rootDir(), target).split(path.sep).join('/');
function metadata<T>(targets: string[], callback: () => T): T {
  return runInResourceAccessScope(
    {
      tenantSlug: 'metadata-fd-test',
      metadataExact: targets.map(relative),
      readExact: [],
      writeExact: [],
      mkdirExact: [],
    },
    callback
  );
}
beforeEach(async () => {
  native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.openSync).mockImplementation(native.openSync);
  vi.mocked(fs.readlinkSync).mockImplementation(native.readlinkSync);
  vi.mocked(fs.statSync).mockImplementation(native.statSync);
  for (const key of [
    'SYSTEM_ROLE',
    'MISSION_ROLE',
    'KYBERION_PERSONA',
    'KYBERION_SUDO',
    'KYBERION_TENANT',
    'KYBERION_DELEGATED_ROLE',
  ])
    vi.stubEnv(key, '');
  base = path.join(pathResolver.rootDir(), 'active/shared/tmp/metadata-fd-' + crypto.randomUUID());
  file = path.join(base, 'allowed');
  alias = path.join(base, 'alias');
  foreign = path.join(base, 'foreign');
  safeMkdir(base);
  safeWriteFile(file, 'allowed metadata');
  safeWriteFile(foreign, 'foreign content');
  safeSymlinkSync(file, alias);
});
afterEach(() => {
  vi.mocked(fs.openSync).mockImplementation(native.openSync);
  vi.mocked(fs.readlinkSync).mockImplementation(native.readlinkSync);
  vi.mocked(fs.statSync).mockImplementation(native.statSync);
  safeRmSync(base, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('metadata capabilities preserve opened-descriptor pinning', () => {
  it('stats exact files and directories without granting any content-reading operation', () => {
    metadata([file, base], () => {
      expect(safeStat(file).isFile()).toBe(true);
      expect(safeStat(base).isDirectory()).toBe(true);
      for (const read of [
        () => safeReadFile(file),
        () => safeReadFileRange(file, 0, 4),
        () => safeReadFileTail(file, 4),
        () => safeReadFileSnapshot(file, 4),
        () => validateFileSize(file),
        () => safeReaddir(base),
      ])
        expect(read).toThrow(/RESOURCE_SCOPE/);
    });
  });

  it.each([false, true])(
    'rejects a foreign fd opened after alias authorization (fallback=%s)',
    (fallback) => {
      // Simulate the OS opening the swapped alias after literal/canonical checks.
      // Only the fault-injection wrapper calls native open; fixture I/O remains secure-io.
      vi.mocked(fs.openSync).mockImplementation((target, flags, mode) =>
        native.openSync(String(target) === alias ? foreign : target, flags, mode)
      );
      if (fallback) {
        vi.mocked(fs.readlinkSync).mockImplementation((target, options) => {
          if (String(target).startsWith('/proc/self/fd/')) throw new Error('proc unavailable');
          return native.readlinkSync(target, options);
        });
      }
      metadata([file, alias], () => {
        expect(() => safeStat(alias)).toThrow(/RESOURCE_SCOPE|changed between/);
      });
    }
  );

  it('keeps nonregular stat fallback metadata-only and reauthorizes its canonical target', () => {
    const allowedStat = safeStat(file);
    const foreignStat = safeStat(foreign);
    const special = (stat: fs.Stats): fs.Stats => {
      const value = Object.create(stat) as fs.Stats;
      value.isFile = () => false;
      value.isDirectory = () => false;
      return value;
    };
    vi.mocked(fs.statSync).mockImplementation((target, options) => {
      if (String(target) === file) return special(allowedStat);
      if (String(target) === foreign) return special(foreignStat);
      return native.statSync(target, options);
    });
    metadata([file], () => {
      expect(safeStat(file).ino).toBe(allowedStat.ino);
      expect(() => statVetted(file, file)).toThrow(/RESOURCE_SCOPE/);
      expect(() => statVetted(foreign, foreign, 'metadata')).toThrow(/RESOURCE_SCOPE/);
    });
  });

  it('does not turn metadata permission into a foreign-hardlink exemption', () => {
    const hardlink = path.join(base, 'hardlink');
    safeLinkExclusiveSync(foreign, hardlink);
    metadata([hardlink], () => {
      expect(() => safeStat(hardlink)).toThrow(/hard link/);
    });
  });
});
