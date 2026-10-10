import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
// Install the full identity resolver (MISSION_ROLE / persona) the production
// write path uses, instead of the bootstrap fallback.
import './authority.js';
import {
  safeAppendFileSync,
  safeChmodSync,
  safeCopyFileSync,
  safeExec,
  safeFsyncFile,
  safeMkdir,
  safeMoveSync,
  safeOpenAppendFile,
  safeFileAgeMs,
  safeReadFile,
  safeReadFileRange,
  safeReadFileSnapshot,
  safeReadFileTail,
  safeReaddir,
  safeRmSync,
  safeSpawn,
  safeStat,
  safeSymlinkSync,
  safeUnlinkSync,
  safeWriteFile,
  validateFileSize,
} from './secure-io.js';
import {
  assertNotForeignHardLink,
  assertTempInCheckedDir,
  captureCheckedDir,
  registerSensitivePathMediationProbe,
} from './secure-io-path-guard.js';

// Denials emit best-effort audit events; keep them off the real audit chain.
vi.mock('./governance/audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));

/*
 * Reproduces the reviewer's finding against main: a data-only persona
 * (worker / finance_controller) may write only active/shared/tmp/ (and its
 * finance knowledge), yet could plant a symlink in tmp/ pointing at a path it
 * may only READ and then write through it. The fixtures are created with raw
 * node:fs (as an operator / another process would) so each case starts from
 * the attacker's position; only the attacked operation runs through secure-io.
 */

const ROOT = pathResolver.rootDir();
const RUN = `${process.pid}-${Date.now()}`;
const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_CUSTOMER',
] as const;

// Writable for the data-only persona (default_allow + finance allow_write).
const scratchRel = `active/shared/tmp/tests/secure-io-symlink-${RUN}`;
// Readable but NOT writable for worker/finance_controller: not a default_allow
// prefix, not in the persona or role allow_write lists. Stands in for
// scripts/ (code) without touching tracked files.
const protectedRel = `active/shared/coordination/vitest-secure-io-symlink-${RUN}`;
// Higher tier the persona may not read.
const personalRel = `knowledge/personal/vitest-secure-io-symlink-${RUN}`;

const abs = (rel: string) => path.join(ROOT, rel);

function asDataOnlyPersona(): void {
  process.env.KYBERION_PERSONA = 'worker';
  process.env.MISSION_ROLE = 'finance_controller';
}

/** Child process that keeps re-pointing symlink `sw` at each of `targets` in turn. */
function startFlipper(sw: string, targets: string[], ms = 9000) {
  const flipper = `
    const fs = require('node:fs');
    const [sw, ...targets] = process.argv.slice(1);
    const end = Date.now() + ${ms};
    let i = 0;
    while (Date.now() < end) {
      const tmp = sw + '.tmp';
      try { fs.rmSync(tmp, { force: true }); fs.symlinkSync(targets[i++ % targets.length], tmp); fs.renameSync(tmp, sw); } catch {}
    }`;
  return safeSpawn(process.execPath, ['-e', flipper, sw, ...targets], { stdio: 'ignore' });
}

/** Run `op` for `ms`, yielding now and then; returns how many calls ran. */
async function hammer(ms: number, op: () => void): Promise<number> {
  let tries = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    tries += 1;
    try {
      op();
    } catch {
      // refused or raced
    }
    if (tries % 50 === 0) await new Promise((r) => setImmediate(r));
  }
  return tries;
}

describe('secure-io symlink canonicalization (data-only persona)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  // Rebuilt per test so a case that (on vulnerable code) mutates the target
  // cannot change the starting state of the next one.
  function resetFixtures(): void {
    fs.rmSync(abs(protectedRel), { recursive: true, force: true });
    fs.mkdirSync(abs(protectedRel), { recursive: true });
    fs.writeFileSync(path.join(abs(protectedRel), 'existing.txt'), 'protected');
    fs.mkdirSync(abs(personalRel), { recursive: true });
    fs.writeFileSync(path.join(abs(personalRel), 'secret.txt'), 'personal-tier secret');
  }

  afterAll(() => {
    fs.rmSync(abs(protectedRel), { recursive: true, force: true });
    fs.rmSync(abs(personalRel), { recursive: true, force: true });
    fs.rmSync(abs(scratchRel), { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    fs.rmSync(abs(scratchRel), { recursive: true, force: true });
    fs.mkdirSync(abs(scratchRel), { recursive: true });
    resetFixtures();
    asDataOnlyPersona();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('sanity: the persona may read but not write the protected directory', () => {
    expect(safeReadFile(`${protectedRel}/existing.txt`)).toBe('protected');
    expect(() => safeWriteFile(`${protectedRel}/direct.txt`, 'x')).toThrow(/NOT authorized/);
  });

  it('refuses to create a symlink to a target the persona may only read', () => {
    expect(() => safeSymlinkSync(protectedRel, `${scratchRel}/link`, 'dir')).toThrow(
      /outside the caller's write scope/
    );
    expect(fs.existsSync(abs(`${scratchRel}/link`))).toBe(false);
  });

  it('refuses writes, appends, mkdir and exclusive creates through a planted symlink', () => {
    fs.symlinkSync(abs(protectedRel), abs(`${scratchRel}/link`), 'dir');

    expect(() => safeWriteFile(`${scratchRel}/link/payload.ts`, 'pwned')).toThrow(
      /Write through symbolic link denied/
    );
    expect(() => safeAppendFileSync(`${scratchRel}/link/existing.txt`, 'pwned')).toThrow(
      /Write through symbolic link denied/
    );
    expect(() => safeMkdir(`${scratchRel}/link/newdir`)).toThrow(
      /Write through symbolic link denied/
    );

    expect(fs.existsSync(path.join(abs(protectedRel), 'payload.ts'))).toBe(false);
    expect(fs.existsSync(path.join(abs(protectedRel), 'newdir'))).toBe(false);
    expect(fs.readFileSync(path.join(abs(protectedRel), 'existing.txt'), 'utf8')).toBe('protected');
  });

  it('refuses a write through a dangling symlink whose target would be created', () => {
    fs.symlinkSync(abs(`${protectedRel}/not-yet`), abs(`${scratchRel}/dangling`), 'dir');
    expect(() => safeWriteFile(`${scratchRel}/dangling/payload.ts`, 'pwned')).toThrow(
      /Write through symbolic link denied/
    );
    expect(fs.existsSync(abs(`${protectedRel}/not-yet`))).toBe(false);
  });

  it('refuses copy and move whose destination parent is a symlink into the protected directory', () => {
    fs.symlinkSync(abs(protectedRel), abs(`${scratchRel}/link`), 'dir');
    fs.writeFileSync(abs(`${scratchRel}/src.txt`), 'payload');

    expect(() => safeCopyFileSync(`${scratchRel}/src.txt`, `${scratchRel}/link/copied.ts`)).toThrow(
      /Write through symbolic link denied/
    );
    expect(() => safeMoveSync(`${scratchRel}/src.txt`, `${scratchRel}/link/moved.ts`)).toThrow(
      /Write through symbolic link denied/
    );

    expect(fs.existsSync(path.join(abs(protectedRel), 'copied.ts'))).toBe(false);
    expect(fs.existsSync(path.join(abs(protectedRel), 'moved.ts'))).toBe(false);
    expect(fs.existsSync(abs(`${scratchRel}/src.txt`))).toBe(true);
  });

  it('refuses to move a protected file out through a symlinked source parent', () => {
    fs.symlinkSync(abs(protectedRel), abs(`${scratchRel}/link`), 'dir');
    expect(() =>
      safeMoveSync(`${scratchRel}/link/existing.txt`, `${scratchRel}/stolen.txt`)
    ).toThrow(/Write through symbolic link denied/);
    expect(fs.existsSync(path.join(abs(protectedRel), 'existing.txt'))).toBe(true);
  });

  it('refuses rm and unlink through a symlinked parent', () => {
    fs.symlinkSync(abs(protectedRel), abs(`${scratchRel}/link`), 'dir');
    expect(() => safeUnlinkSync(`${scratchRel}/link/existing.txt`)).toThrow(
      /Write through symbolic link denied/
    );
    expect(() => safeRmSync(`${scratchRel}/link/existing.txt`)).toThrow(
      /Write through symbolic link denied/
    );
    expect(fs.existsSync(path.join(abs(protectedRel), 'existing.txt'))).toBe(true);
  });

  it('still removes the link itself (rm never follows the leaf)', () => {
    fs.symlinkSync(abs(protectedRel), abs(`${scratchRel}/link`), 'dir');
    safeRmSync(`${scratchRel}/link`);
    expect(fs.existsSync(abs(`${scratchRel}/link`))).toBe(false);
    expect(fs.existsSync(path.join(abs(protectedRel), 'existing.txt'))).toBe(true);
  });

  it('refuses reads into a higher tier through a symlink placed in a readable location', () => {
    expect(() => safeReadFile(`${personalRel}/secret.txt`)).toThrow(/Read access denied/);
    fs.symlinkSync(abs(personalRel), abs(`${scratchRel}/personal-link`), 'dir');
    fs.symlinkSync(
      abs(`${personalRel}/secret.txt`),
      abs(`${scratchRel}/secret-file-link.txt`),
      'file'
    );

    expect(() => safeReadFile(`${scratchRel}/personal-link/secret.txt`)).toThrow(
      /Read through symbolic link denied/
    );
    expect(() => safeReadFile(`${scratchRel}/secret-file-link.txt`)).toThrow(
      /Read through symbolic link denied/
    );
    expect(() => safeReaddir(`${scratchRel}/personal-link`)).toThrow(
      /Read through symbolic link denied/
    );
    expect(() =>
      safeCopyFileSync(`${scratchRel}/secret-file-link.txt`, `${scratchRel}/exfil.txt`)
    ).toThrow(/Read through symbolic link denied/);
    expect(fs.existsSync(abs(`${scratchRel}/exfil.txt`))).toBe(false);
  });

  it('refuses junction links and symlinks that resolve outside the repository', () => {
    expect(() =>
      safeSymlinkSync(`${scratchRel}/real`, `${scratchRel}/j`, 'junction' as never)
    ).toThrow(/refuses link type 'junction'/);
    // A link whose target leaves the checkout, reached via a planted link.
    fs.symlinkSync(path.dirname(ROOT), abs(`${scratchRel}/escape`), 'dir');
    expect(() => safeSymlinkSync(`${scratchRel}/escape`, `${scratchRel}/second`, 'dir')).toThrow(
      /outside the repository|Read through symbolic link denied|Read access denied/
    );
  });

  it('does not reuse a cached directory resolution after the directory is swapped for a link', () => {
    // Warm the per-process directory cache with a real directory...
    safeMkdir(`${scratchRel}/swap`);
    safeWriteFile(`${scratchRel}/swap/first.txt`, 'ok');
    // ...then replace it, outside secure-io, with a link into the protected dir.
    fs.rmSync(abs(`${scratchRel}/swap`), { recursive: true, force: true });
    fs.symlinkSync(abs(protectedRel), abs(`${scratchRel}/swap`), 'dir');
    expect(() => safeWriteFile(`${scratchRel}/swap/second.ts`, 'pwned')).toThrow(
      /Write through symbolic link denied/
    );
    expect(fs.existsSync(path.join(abs(protectedRel), 'second.ts'))).toBe(false);
  });

  it('does not reuse a cached resolution after the directory is renamed away and replaced', () => {
    safeMkdir(`${scratchRel}/moved`);
    safeWriteFile(`${scratchRel}/moved/first.txt`, 'ok');
    // Same inode, new path: rename the real directory into the protected tree
    // (as a privileged actor would) and leave a link at the old path.
    fs.renameSync(abs(`${scratchRel}/moved`), path.join(abs(protectedRel), 'moved'));
    fs.symlinkSync(path.join(abs(protectedRel), 'moved'), abs(`${scratchRel}/moved`), 'dir');
    expect(() => safeWriteFile(`${scratchRel}/moved/second.ts`, 'pwned')).toThrow(
      /Write through symbolic link denied/
    );
    expect(fs.existsSync(path.join(abs(protectedRel), 'moved', 'second.ts'))).toBe(false);
  });

  it('does not trust an earlier resolution after an ancestor is renamed into a protected tree', () => {
    // Resolve (and, before this fix, cache) tmp/anc/sub ...
    safeMkdir(`${scratchRel}/anc/sub`);
    safeWriteFile(`${scratchRel}/anc/sub/1.txt`, 'ok');
    // ... then, outside secure-io, move the ANCESTOR into the protected tree
    // and leave a link at its old path. The sub directory keeps its inode.
    fs.renameSync(abs(`${scratchRel}/anc`), path.join(abs(protectedRel), 'anc'));
    fs.symlinkSync(path.join(abs(protectedRel), 'anc'), abs(`${scratchRel}/anc`), 'dir');
    expect(() => safeWriteFile(`${scratchRel}/anc/sub/2.txt`, 'pwned')).toThrow(
      /Write through symbolic link denied/
    );
    expect(fs.existsSync(path.join(abs(protectedRel), 'anc', 'sub', '2.txt'))).toBe(false);
  });

  it('refuses in-place writes through a hard link to a protected file', () => {
    const victim = path.join(abs(protectedRel), 'existing.txt');
    fs.linkSync(victim, abs(`${scratchRel}/hl.txt`));
    const hl = `${scratchRel}/hl.txt`;
    expect(() => safeAppendFileSync(hl, 'pwned')).toThrow(/hard link/);
    expect(() => safeOpenAppendFile(hl)).toThrow(/hard link/);
    expect(() => safeChmodSync(hl, 0o777)).toThrow(/hard link/);
    expect(() => safeFsyncFile(hl)).toThrow(/hard link/);
    const modeBefore = fs.statSync(victim).mode;
    // A copy replaces the destination entry; the protected inode is untouched.
    fs.writeFileSync(abs(`${scratchRel}/src.txt`), 'copied');
    safeCopyFileSync(`${scratchRel}/src.txt`, hl);
    expect(fs.readFileSync(abs(hl), 'utf8')).toBe('copied');
    expect(fs.readFileSync(victim, 'utf8')).toBe('protected');
    expect(fs.statSync(victim).mode).toBe(modeBefore);
    expect(fs.statSync(victim).nlink).toBe(1);
  });

  it('allows only the tomb side of a lock recovery pair, probe-only, in the locks directory', () => {
    const locks = `active/shared/runtime/locks/vitest-secure-io-${RUN}`;
    try {
      fs.mkdirSync(abs(locks), { recursive: true });
      fs.writeFileSync(abs(`${locks}/res.lock`), '{"pid":1}');
      fs.linkSync(abs(`${locks}/res.lock`), abs(`${locks}/res.lock.stale-1-2-3`));
      // The tomb names its base: one lstat decides, no directory listing.
      expect(safeReadFile(`${locks}/res.lock.stale-1-2-3`)).toBe('{"pid":1}');
      safeFsyncFile(`${locks}/res.lock.stale-1-2-3`);
      // The base side would need a listing to find its tomb: refused
      // (lock inspection treats an unreadable record as live).
      expect(() => safeReadFile(`${locks}/res.lock`)).toThrow(/hard link/);
      // A tomb may move within its locks directory, never elsewhere.
      expect(() =>
        safeMoveSync(`${locks}/res.lock.stale-1-2-3`, `${scratchRel}/MEMORY.md`)
      ).toThrow(/only move within its locks directory/);
      expect(fs.existsSync(abs(`${scratchRel}/MEMORY.md`))).toBe(false);
      safeMoveSync(`${locks}/res.lock.stale-1-2-3`, `${locks}/res.lock.stale-4-5-6`);
      // Any other name for the inode is refused, even in the locks directory.
      fs.linkSync(abs(`${locks}/res.lock`), abs(`${locks}/other.json`));
      expect(() => safeReadFile(`${locks}/res.lock.stale-4-5-6`)).toThrow(/hard link/);
    } finally {
      fs.rmSync(abs(locks), { recursive: true, force: true });
    }
    // The same pair outside the locks directory gets no exception.
    fs.writeFileSync(abs(`${scratchRel}/res.lock`), 'x');
    fs.linkSync(abs(`${scratchRel}/res.lock`), abs(`${scratchRel}/res.lock.stale-1-2-3`));
    expect(() => safeAppendFileSync(`${scratchRel}/res.lock.stale-1-2-3`, 'y')).toThrow(
      /hard link/
    );
  });

  it('refuses metadata and snapshots of a higher-tier file through a hard link', () => {
    fs.linkSync(path.join(abs(personalRel), 'secret.txt'), abs(`${scratchRel}/hl-meta.txt`));
    expect(() => safeStat(`${scratchRel}/hl-meta.txt`)).toThrow(/hard link/);
    expect(() => safeFileAgeMs(`${scratchRel}/hl-meta.txt`)).toThrow(/hard link/);
    expect(() => safeReadFileSnapshot(`${scratchRel}/hl-meta.txt`, 64)).toThrow(/hard link/);
  });

  it('refuses to move a hard link to a protected file under a writable name', () => {
    fs.linkSync(path.join(abs(protectedRel), 'existing.txt'), abs(`${scratchRel}/hl`));
    expect(() => safeMoveSync(`${scratchRel}/hl`, `${scratchRel}/MEMORY.md`)).toThrow(/hard link/);
    expect(fs.existsSync(abs(`${scratchRel}/MEMORY.md`))).toBe(false);
  });

  it('never truncates through a hard link (append accepts only append flags)', () => {
    fs.linkSync(path.join(abs(protectedRel), 'existing.txt'), abs(`${scratchRel}/hl`));
    expect(() => safeAppendFileSync(`${scratchRel}/hl`, '', { flag: 'w' })).toThrow(/only appends/);
    expect(() => safeAppendFileSync(`${scratchRel}/hl`, '', { flag: 'r+' })).toThrow(
      /only appends/
    );
    expect(fs.readFileSync(path.join(abs(protectedRel), 'existing.txt'), 'utf8')).toBe('protected');
  });

  it('gives no node_modules exemption through a workspace link into a role-writable tree', () => {
    // node_modules/@actuator/service -> libs/actuators/service-actuator (pnpm
    // workspace link); software_developer may write libs/actuators/.
    const alias = 'node_modules/@actuator/service';
    const pkgDir = 'libs/actuators/service-actuator';
    expect(fs.realpathSync(abs(alias))).toBe(fs.realpathSync(abs(pkgDir)));
    const plantRel = `${pkgDir}/vitest-secure-io-${RUN}`;
    process.env.MISSION_ROLE = 'software_developer';
    try {
      fs.mkdirSync(abs(plantRel), { recursive: true });
      fs.linkSync(path.join(abs(personalRel), 'secret.txt'), abs(`${plantRel}/x.txt`));
      expect(() => safeReadFile(`${plantRel}/x.txt`)).toThrow(/hard link/);
      expect(() => safeReadFile(`${alias}/vitest-secure-io-${RUN}/x.txt`)).toThrow(/hard link/);
    } finally {
      fs.rmSync(abs(plantRel), { recursive: true, force: true });
    }
  });

  it('grants a hard-link exemption only to the inode the caller holds', () => {
    // The state a symlink swap between open and check produces: the caller
    // holds the planted inode, while the path now resolves into the pnpm store.
    const planted = abs(`${scratchRel}/planted`);
    fs.linkSync(path.join(abs(personalRel), 'secret.txt'), planted);
    const pnpmFile = fs.realpathSync(abs('node_modules/vitest/package.json'));
    fs.symlinkSync(pnpmFile, abs(`${scratchRel}/sw`));
    expect(() =>
      assertNotForeignHardLink(fs.statSync(planted), abs(`${scratchRel}/sw`), 'sw', 'read')
    ).toThrow(/hard link/);
    // ... and an existing outside-repository file is no exemption either (a
    // file we create: /etc/hostname does not exist on macOS runners).
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-io-outside-'));
    try {
      const outside = path.join(outsideDir, 'hostname');
      fs.writeFileSync(outside, 'host');
      fs.rmSync(abs(`${scratchRel}/sw`));
      fs.symlinkSync(outside, abs(`${scratchRel}/sw`));
      expect(() =>
        assertNotForeignHardLink(fs.statSync(planted), abs(`${scratchRel}/sw`), 'sw', 'read')
      ).toThrow(/hard link/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('never chmods a protected file or directory through a flipped symlink', async () => {
    const pubdir = abs(`${scratchRel}/pubdir`);
    fs.mkdirSync(pubdir);
    fs.writeFileSync(abs(`${scratchRel}/pub.txt`), 'pub');
    const pdir = path.join(abs(personalRel), 'zz-dir');
    fs.mkdirSync(pdir, { recursive: true });
    fs.chmodSync(pdir, 0o755);
    const secretPath = path.join(abs(personalRel), 'secret.txt');
    fs.chmodSync(secretPath, 0o644);
    const sw = abs(`${scratchRel}/sw`);
    fs.symlinkSync(pubdir, sw);
    const child = startFlipper(sw, [pubdir, pdir, abs(`${scratchRel}/pub.txt`), secretPath]);
    let tries = 0;
    try {
      tries = await hammer(2500, () => safeChmodSync(`${scratchRel}/sw`, 0o700));
    } finally {
      child.kill('SIGKILL');
    }
    expect(tries).toBeGreaterThan(50);
    expect(fs.statSync(pdir).mode & 0o777).toBe(0o755);
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o644);
  }, 20000);

  it('never creates a file through a dangling symlink flipped into a protected tree', async () => {
    const real = abs(`${scratchRel}/real.log`);
    fs.writeFileSync(real, '');
    const sw = abs(`${scratchRel}/sw`);
    fs.symlinkSync(real, sw);
    const targets = [real];
    for (let i = 0; i < 4; i += 1) targets.push(path.join(abs(personalRel), `created-by-${i}.txt`));
    const child = startFlipper(sw, targets);
    let tries = 0;
    try {
      tries = await hammer(2500, () => safeAppendFileSync(`${scratchRel}/sw`, 'x'));
    } finally {
      child.kill('SIGKILL');
    }
    expect(tries).toBeGreaterThan(50);
    expect(fs.readdirSync(abs(personalRel)).filter((n) => n.startsWith('created-by-'))).toEqual([]);
  }, 20000);

  it('never lists a protected directory through a flipped symlink', async () => {
    const pubdir = abs(`${scratchRel}/pubdir`);
    fs.mkdirSync(pubdir);
    fs.writeFileSync(path.join(pubdir, 'visible.txt'), 'v');
    const sw = abs(`${scratchRel}/sw`);
    fs.symlinkSync(pubdir, sw);
    const child = startFlipper(sw, [pubdir, abs(personalRel)]);
    let leaked = 0;
    let listed = 0;
    let tries = 0;
    try {
      tries = await hammer(2500, () => {
        const names = safeReaddir(`${scratchRel}/sw`);
        listed += 1;
        if (names.includes('secret.txt')) leaked += 1;
      });
    } finally {
      child.kill('SIGKILL');
    }
    expect(tries).toBeGreaterThan(50);
    expect(listed).toBeGreaterThan(0);
    expect(leaked).toBe(0);
  }, 20000);

  it('never hangs on a FIFO (reads open non-blocking and refuse non-regular files)', () => {
    const fifo = abs(`${scratchRel}/pipe`);
    process.env.MISSION_ROLE = 'mission_controller';
    safeExec('mkfifo', [fifo]);
    process.env.MISSION_ROLE = 'finance_controller';
    expect(() => safeReadFile(`${scratchRel}/pipe`)).toThrow(/Not a regular file/);
    expect(() => safeReadFileTail(`${scratchRel}/pipe`, 16)).toThrow(/Not a regular file/);
    expect(() => safeReadFileRange(`${scratchRel}/pipe`, 0, 16)).toThrow(/Not a regular file/);
    expect(() => safeCopyFileSync(`${scratchRel}/pipe`, `${scratchRel}/out.txt`)).toThrow(
      /Not a regular file/
    );
    expect(() => safeChmodSync(`${scratchRel}/pipe`, 0o600)).toThrow(/not a file or directory/);
  }, 5000);

  it('does not reveal the protected location in a denial message', () => {
    fs.symlinkSync(path.join(abs(personalRel), 'secret.txt'), abs(`${scratchRel}/to-secret`));
    let message = '';
    try {
      safeReadFile(`${scratchRel}/to-secret`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('vitest-secure-io-symlink');
  });

  it('never leaks through a symlink flipped between check and open (read, range, tail, stat, size)', async () => {
    // No hard link: `sw` flips between a readable file, a regular file and a
    // symlink straight to the personal-tier secret (nlink 1).
    const secretPath = path.join(abs(personalRel), 'secret.txt');
    const secret = fs.statSync(secretPath);
    const readable = abs(`${scratchRel}/readable.txt`);
    fs.writeFileSync(readable, 'readable file, a different length');
    const plain = abs(`${scratchRel}/plain.txt`);
    fs.writeFileSync(plain, 'plain regular file contents');
    const sw = abs(`${scratchRel}/sw`);
    fs.symlinkSync(readable, sw);
    const flipper = `
      const fs = require('node:fs');
      const [sw, readable, plain, secret] = process.argv.slice(1);
      const end = Date.now() + 9000;
      let i = 0;
      while (Date.now() < end) {
        const tmp = sw + '.tmp';
        try {
          fs.rmSync(tmp, { force: true });
          const k = i++ % 3;
          if (k === 0) fs.symlinkSync(readable, tmp);
          else if (k === 1) fs.copyFileSync(plain, tmp);
          else fs.symlinkSync(secret, tmp);
          fs.renameSync(tmp, sw);
        } catch {}
      }`;
    const child = safeSpawn(process.execPath, ['-e', flipper, sw, readable, plain, secretPath], {
      stdio: 'ignore',
    });
    const leaks: Record<string, number> = { read: 0, range: 0, tail: 0, stat: 0, size: 0 };
    const tries: Record<string, number> = { read: 0, range: 0, tail: 0, stat: 0, size: 0 };
    const rel = `${scratchRel}/sw`;
    const ops: Record<string, () => boolean> = {
      read: () => String(safeReadFile(rel)).includes('personal-tier secret'),
      range: () => safeReadFileRange(rel, 0, 64).toString().includes('personal-tier secret'),
      tail: () => safeReadFileTail(rel, 64).buffer.toString().includes('personal-tier secret'),
      stat: () => safeStat(rel).ino === secret.ino,
      size: () => validateFileSize(rel) === secret.size,
    };
    try {
      for (const [name, op] of Object.entries(ops)) {
        const end = Date.now() + 1500;
        while (Date.now() < end) {
          tries[name] += 1;
          try {
            if (op()) leaks[name] += 1;
          } catch {
            // refused or raced: never a leak
          }
          if (tries[name] % 50 === 0) await new Promise((r) => setImmediate(r));
        }
      }
    } finally {
      child.kill('SIGKILL');
    }
    for (const name of Object.keys(ops)) expect(tries[name]).toBeGreaterThan(50);
    expect(leaks).toEqual({ read: 0, range: 0, tail: 0, stat: 0, size: 0 });
  }, 30000);

  it('never leaks a hard-linked secret while a symlink flips into the pnpm store (bounded race)', async () => {
    const planted = abs(`${scratchRel}/planted`);
    fs.linkSync(path.join(abs(personalRel), 'secret.txt'), planted);
    const pnpmFile = fs.realpathSync(abs('node_modules/vitest/package.json'));
    const sw = abs(`${scratchRel}/sw`);
    fs.symlinkSync(planted, sw);
    const flipper = `
      const fs = require('node:fs');
      const [sw, a, b] = process.argv.slice(1);
      const end = Date.now() + 4000;
      let i = 0;
      while (Date.now() < end) {
        const tmp = sw + '.tmp';
        try { fs.rmSync(tmp, { force: true }); fs.symlinkSync(i++ % 2 ? a : b, tmp); fs.renameSync(tmp, sw); } catch {}
      }`;
    const child = safeSpawn(process.execPath, ['-e', flipper, sw, planted, pnpmFile], {
      stdio: 'ignore',
    });
    let leaked = 0;
    let tries = 0;
    let sawStore = 0; // proves the flipper ran: the store side is readable
    try {
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        tries += 1;
        try {
          const text = String(safeReadFile(`${scratchRel}/sw`));
          if (text.includes('personal-tier secret')) leaked += 1;
          if (text.includes('"name": "vitest"')) sawStore += 1;
        } catch {
          // refused or raced: never a leak
        }
        if (tries % 50 === 0) await new Promise((r) => setImmediate(r));
      }
    } finally {
      child.kill('SIGKILL');
    }
    expect(tries).toBeGreaterThan(100);
    expect(sawStore).toBeGreaterThan(0);
    expect(leaked).toBe(0);
  }, 20000);

  it('reports a missing file with code ENOENT', () => {
    let code: unknown;
    try {
      safeReadFile(`${scratchRel}/does-not-exist.json`);
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('ENOENT');
  });

  it('lets SUDO read pnpm store files (the store is exempt for every caller)', () => {
    process.env.KYBERION_SUDO = 'true';
    expect(() => safeReadFile('node_modules/vitest/package.json')).not.toThrow();
  });

  it('gives no node_modules exemption to a node_modules directory in a writable tree', () => {
    fs.mkdirSync(abs(`${scratchRel}/node_modules/pkg`), { recursive: true });
    fs.linkSync(
      path.join(abs(personalRel), 'secret.txt'),
      abs(`${scratchRel}/node_modules/pkg/index.js`)
    );
    expect(() => safeReadFile(`${scratchRel}/node_modules/pkg/index.js`)).toThrow(/hard link/);
    expect(() => validateFileSize(`${scratchRel}/node_modules/pkg/index.js`)).toThrow(/hard link/);
  });

  it('refuses reads of a higher-tier file through a hard link', () => {
    fs.linkSync(path.join(abs(personalRel), 'secret.txt'), abs(`${scratchRel}/hl-secret.txt`));
    expect(() => safeReadFile(`${scratchRel}/hl-secret.txt`)).toThrow(/hard link/);
    expect(() =>
      safeCopyFileSync(`${scratchRel}/hl-secret.txt`, `${scratchRel}/exfil2.txt`)
    ).toThrow(/hard link/);
    expect(fs.existsSync(abs(`${scratchRel}/exfil2.txt`))).toBe(false);
  });

  it('applies the tier read guard to validateFileSize', () => {
    expect(() => validateFileSize(`${personalRel}/secret.txt`)).toThrow(/Read access denied/);
  });

  it('keeps legitimate symlinks inside the caller write scope working', () => {
    safeMkdir(`${scratchRel}/real`);
    safeSymlinkSync(`${scratchRel}/real`, `${scratchRel}/alias`, 'dir');
    safeWriteFile(`${scratchRel}/alias/note.txt`, 'hello');
    safeAppendFileSync(`${scratchRel}/alias/note.txt`, ' world');
    expect(safeReadFile(`${scratchRel}/alias/note.txt`)).toBe('hello world');
    expect(fs.readFileSync(abs(`${scratchRel}/real/note.txt`), 'utf8')).toBe('hello world');
    safeCopyFileSync(`${scratchRel}/alias/note.txt`, `${scratchRel}/alias/copy.txt`);
    safeMoveSync(`${scratchRel}/alias/copy.txt`, `${scratchRel}/alias/moved.txt`);
    expect(safeReaddir(`${scratchRel}/alias`).sort()).toEqual(['moved.txt', 'note.txt']);
    // The link is stored relative, so it keeps pointing inside the checkout.
    expect(path.isAbsolute(fs.readlinkSync(abs(`${scratchRel}/alias`)))).toBe(false);
  });
});

describe('secure-io symlink canonicalization keeps the Vitest live-subtree remap', () => {
  const liveRel = `active/shared/runtime/peer-messaging/vitest-secure-io-symlink-${RUN}`;
  const scratchRel2 = `active/shared/tmp/tests/secure-io-symlink-remap-${RUN}`;

  afterAll(() => {
    fs.rmSync(pathResolver.resolve(liveRel), { recursive: true, force: true });
    fs.rmSync(abs(scratchRel2), { recursive: true, force: true });
  });

  it('writes a live-subtree path into the per-pool sandbox and reads it back', () => {
    const sandboxed = pathResolver.resolve(`${liveRel}/state.json`);
    expect(sandboxed).toContain(pathResolver.VITEST_LIVE_SANDBOX_ROOT);
    safeWriteFile(`${liveRel}/state.json`, '{"ok":true}');
    expect(fs.existsSync(sandboxed)).toBe(true);
    expect(fs.existsSync(abs(`${liveRel}/state.json`))).toBe(false);
    expect(safeReadFile(`${liveRel}/state.json`)).toBe('{"ok":true}');
  });

  it('still reads through a registered vault mount outside the repository, and never writes', async () => {
    const os = await import('node:os');
    const { mountToVault, unmountFromVault } = await import('./secret/vault-mount.js');
    const host = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-io-vault-'));
    const name = `vitest-secure-io-${RUN}`;
    fs.writeFileSync(path.join(host, 'doc.txt'), 'mounted');
    try {
      mountToVault(host, name);
      expect(safeReadFile(`vault/mounts/${name}/doc.txt`)).toBe('mounted');
      expect(() => safeWriteFile(`vault/mounts/${name}/new.txt`, 'x')).toThrow();
      expect(fs.existsSync(path.join(host, 'new.txt'))).toBe(false);
    } finally {
      unmountFromVault(name);
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  it('judges a link into the sandbox by the sandbox location, and allows it', () => {
    safeMkdir(scratchRel2);
    safeSymlinkSync(liveRel, `${scratchRel2}/live-link`, 'dir');
    // The link was created to the remapped (sandbox) target.
    expect(fs.realpathSync(abs(`${scratchRel2}/live-link`))).toBe(
      fs.realpathSync(pathResolver.resolve(liveRel))
    );
    safeWriteFile(`${scratchRel2}/live-link/through.json`, '{}');
    expect(fs.existsSync(path.join(pathResolver.resolve(liveRel), 'through.json'))).toBe(true);
  });
});

describe('secure-io guard internals', () => {
  const dirRel = `active/shared/tmp/tests/secure-io-guard-${RUN}`;

  afterAll(() => {
    fs.rmSync(abs(dirRel), { recursive: true, force: true });
    fs.rmSync(abs(`${dirRel}-moved`), { recursive: true, force: true });
  });

  it('detects a checked directory replaced between the check and the temp open', () => {
    fs.mkdirSync(abs(dirRel), { recursive: true });
    const checked = captureCheckedDir(abs(dirRel));
    fs.renameSync(abs(dirRel), abs(`${dirRel}-moved`));
    fs.mkdirSync(abs(dirRel));
    const temp = path.join(abs(dirRel), 'x.tmp');
    const fd = fs.openSync(temp, 'wx');
    try {
      expect(() => assertTempInCheckedDir(checked, temp, fd)).toThrow(/changed between/);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('keeps the first sensitive-path mediation probe registered', () => {
    registerSensitivePathMediationProbe(() => true);
    expect(() => safeReadFile('knowledge/personal/connections/slack.json')).toThrow(
      '[SENSITIVE_PATH_DENIED]'
    );
  });

  it('reads pnpm store files under node_modules despite their link count', () => {
    const pkg = 'node_modules/vitest/package.json';
    expect(() => safeReadFile(pkg)).not.toThrow();
  });
});
