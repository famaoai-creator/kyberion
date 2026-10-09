import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
// Install the full identity resolver (MISSION_ROLE / persona) the production
// write path uses, instead of the bootstrap fallback.
import './authority.js';
import {
  safeAppendFileSync,
  safeCopyFileSync,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeSymlinkSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';

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
