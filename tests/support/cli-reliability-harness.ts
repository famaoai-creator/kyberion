/**
 * R14 — hermetic process-smoke harness for the 26 CLI reliability probes.
 *
 * Each case runs the REAL CLI entry (`node scripts/kyberion_cli_entry.mjs` or
 * a documented `pnpm` script) as a child process against a dedicated fixture
 * root — never the operator's HOME, tenant ledgers, credentials, network or
 * native providers. The fixture root is a content clone of the checkout's
 * governed surface (package.json scripts, scripts/, libs/, dist/, the public
 * knowledge tiers and product governance docs) minus all operator state, so
 * the in-process dispatcher, module children and nested `pnpm run` children
 * all behave exactly as they do on a real checkout while every read/write is
 * scoped to the clone.
 *
 * Isolation mechanics (verified against libs/core/secure-io.ts):
 *  - KYBERION_ROOT is honoured by the direct child but is NOT in the
 *    safeExec env allowlist, so module/pnpm grandchildren re-derive the
 *    project root by walking up from cwd. The fixture therefore carries real
 *    repo markers (package.json + AGENTS.md + libs/actuators + knowledge/)
 *    so grandchildren resolve the fixture as root and never reach the live
 *    checkout that contains it.
 *  - A `pnpm-workspace.yaml` at the fixture root stops pnpm's workspace-root
 *    walk from reaching the real package.json `packageManager` pin (which
 *    otherwise self-provisions pnpm recursively).
 *  - `assertSafeRepositoryPath` rejects symlink traversal and secure-io
 *    refuses hard links, so mirrored dirs are content copies — APFS clones
 *    (`cp -c`, copy-on-write, nlink=1) where supported, plain copies
 *    otherwise. `node_modules`/`dist` are only ever resolved by Node's
 *    module loader, never through the repository boundary, so
 *    `node_modules` is a symlink; `dist` is cloned on demand for probes
 *    whose contract includes build readiness or bundled script entries.
 *  - The child env is a whitelist (PATH, HOME, TMPDIR, KYBERION_* envs,
 *    NO_COLOR): no API keys, no agent-session markers, no user scope.
 */

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CHECKOUT_ROOT = path.resolve(__dirname, '..', '..');
export const SMOKE_ROOT = path.join(
  CHECKOUT_ROOT,
  'active',
  'shared',
  'tmp',
  `cli-reliability-smoke-${process.pid}`
);

export interface SmokeFixtureSpec {
  /** Seed `active/shared/runtime/scope.env` with the fixture tenant scope. */
  persistedScope?: boolean;
  /** Extra files (repo-relative path -> content) seeded into the clone. */
  files?: Record<string, string | Buffer>;
  /** Clone `dist/` too — needed for build-readiness probes and run_built children. */
  mirrorDist?: boolean;
  /** Extra env for this case (e.g. a synthetic KYBERION_STT_COMMAND backend). */
  env?: Record<string, string>;
}

export interface SmokeCaseResult {
  exit: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Paths created/changed/deleted relative to the case root during the run. */
  sideEffects: { created: string[]; changed: string[]; deleted: string[] };
}

/** The fixture tenant scope — sentinel values, never a real tenant. */
export const FIXTURE_SCOPE_ENV = [
  'KYBERION_TIER=confidential',
  'KYBERION_TENANT=fixture-tenant-a',
  'KYBERION_ORGANIZATION_ID=fixture-org-a',
  'KYBERION_PROJECT_ID=PRJ-FIXTURE-RELIABILITY',
  '',
].join('\n');

/**
 * Copy a directory tree as content copies. Prefers APFS/BTRFS copy-on-write
 * clones (`cp -c` on macOS: real inodes, nlink=1, no hard-link refusal from
 * secure-io); falls back to a plain recursive copy elsewhere. Hard links are
 * never used — secure-io refuses nlink>1, and a write through one would
 * corrupt the checkout.
 */
export function cloneTree(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    execFileSync('cp', ['-Rc', source, target], { stdio: 'ignore' });
  } catch {
    fs.cpSync(source, target, { recursive: true, dereference: false });
  }
}

/**
 * Build a per-case fixture root. Content clones keep `assertSafeRepositoryPath`
 * happy (no symlink traversal, no hard links); `node_modules` is a symlink
 * because only Node's resolver ever follows it.
 */
export function seedCaseRoot(caseId: string, spec: SmokeFixtureSpec = {}): string {
  const root = path.join(SMOKE_ROOT, caseId);
  const src = CHECKOUT_ROOT;
  fs.mkdirSync(root, { recursive: true });

  // Root markers — grandchildren re-derive the project root from cwd and
  // must land here, not on the live checkout one level up.
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
    imports?: Record<string, string>;
  };
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'kyberion-cli-smoke-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        // `#…` subpath imports are part of the runtime contract (e.g.
        // capability_discovery_entry.mjs -> #ajv-build-free); the mirror must
        // carry them or Node fails with ERR_PACKAGE_IMPORT_NOT_DEFINED.
        imports: pkg.imports ?? {},
        scripts: pkg.scripts ?? {},
      },
      null,
      1
    )}\n`
  );
  // Own workspace root: pnpm must not walk up to the real packageManager pin
  // (recursive self-provisioning) or run install-time deps checks against the
  // symlinked node_modules (a modules purge is never wanted in a fixture).
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages: []\nverifyDepsBeforeRun: false\n'
  );
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    '# Fixture checkout — cli-reliability smoke (sentinel content only)\n'
  );

  // Governed surface mirrored as content copies. Tenant/personal tiers stay
  // empty — nothing from the operator's knowledge tree is cloned.
  cloneTree(path.join(src, 'scripts'), path.join(root, 'scripts'));
  cloneTree(path.join(src, 'libs'), path.join(root, 'libs'));
  cloneTree(path.join(src, 'knowledge', 'product'), path.join(root, 'knowledge', 'product'));
  cloneTree(path.join(src, 'knowledge', 'public'), path.join(root, 'knowledge', 'public'));
  for (const file of ['_index.md', '_integrity-manifest.json', 'README.md', 'Ecosystem_Map.md']) {
    const from = path.join(src, 'knowledge', file);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.join(root, 'knowledge'), { recursive: true });
      fs.copyFileSync(from, path.join(root, 'knowledge', file));
    }
  }
  fs.mkdirSync(path.join(root, 'knowledge', 'confidential'), { recursive: true });
  fs.mkdirSync(path.join(root, 'knowledge', 'personal'), { recursive: true });
  if (spec.mirrorDist) cloneTree(path.join(src, 'dist'), path.join(root, 'dist'));

  // Bare-specifier resolution only — never traversed by the repo boundary.
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    fs.symlinkSync(path.join(src, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  }

  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'active', 'shared', 'tmp'), { recursive: true });
  if (spec.persistedScope) {
    const scopeDir = path.join(root, 'active', 'shared', 'runtime');
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(path.join(scopeDir, 'scope.env'), FIXTURE_SCOPE_ENV);
  }
  for (const [relative, content] of Object.entries(spec.files ?? {})) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

/** Whitelisted child environment — no inherited secrets or session markers. */
export function caseEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    USER: 'cli-smoke-fixture',
    NO_COLOR: '1',
    KYBERION_ROOT: root,
    KYBERION_REASONING_BACKEND: 'stub',
    ...extra,
  };
}

type FileStamp = { size: number; mtimeMs: number };

/** Snapshot every real file under the case root (the node_modules symlink is skipped). */
export function snapshotTree(root: string): Map<string, FileStamp> {
  const stamps = new Map<string, FileStamp>();
  const skipDirs = new Set(['node_modules']);
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        stamps.set(path.relative(root, full).split(path.sep).join('/'), {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  walk(root);
  return stamps;
}

export function diffTrees(
  root: string,
  before: Map<string, FileStamp>
): SmokeCaseResult['sideEffects'] {
  const after = snapshotTree(root);
  const created: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [file, stamp] of after) {
    const previous = before.get(file);
    if (!previous) created.push(file);
    else if (previous.size !== stamp.size || previous.mtimeMs !== stamp.mtimeMs) changed.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) deleted.push(file);
  return { created, changed, deleted };
}

/**
 * Run one CLI case as a real child process. `launcher`:
 *   'direct'      — `node scripts/kyberion_cli_entry.mjs <argv>` (argv[0] is
 *                   dropped: 'kyberion', 'doctor', … are all forwarded as-is)
 *   'pnpm-script' — `pnpm <argv>` with cwd = fixture root (documented pnpm
 *                   variants such as `mission list`)
 *   'script-entry'— `node <argv[0]> <argv[1..]>` — a built script entry run
 *                   directly (stderr JSON envelope surface; argv[0] is a
 *                   repo-relative dist path resolved inside the fixture)
 * The process group is killed on timeout so nested pnpm/module children
 * cannot leak past the harness.
 */
export async function runCliCase(
  root: string,
  launcher: 'direct' | 'pnpm-script' | 'script-entry',
  argv: string[],
  options: { timeoutMs: number; env?: Record<string, string> }
): Promise<SmokeCaseResult> {
  const before = snapshotTree(root);
  const startedAt = Date.now();
  const command = launcher === 'pnpm-script' ? 'pnpm' : process.execPath;
  const args =
    launcher === 'direct'
      ? [path.join(CHECKOUT_ROOT, 'scripts', 'kyberion_cli_entry.mjs'), ...argv.slice(1)]
      : launcher === 'script-entry'
        ? argv.map((arg, index) => (index === 0 ? path.join(CHECKOUT_ROOT, arg) : arg))
        : argv;
  const child = spawn(command, args, {
    cwd: launcher === 'direct' ? CHECKOUT_ROOT : root,
    env: caseEnv(root, options.env),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const outcome = await new Promise<{
    exit: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // detached: kill the whole group — entry, dist CLI, nested pnpm.
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs);
    child.on('exit', (exit, signal) => {
      clearTimeout(timer);
      resolve({ exit, signal, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exit: null, signal: null, timedOut });
    });
  });
  return {
    ...outcome,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    sideEffects: diffTrees(root, before),
  };
}

/** Try to find a host binary without consulting user config (ffmpeg check for P25). */
export function hostBinaryAvailable(name: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, name);
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** Minimal valid RIFF/WAVE — a real container signature for perception input tests. */
export function syntheticWavBuffer(seconds = 0.5, sampleRate = 8000): Buffer {
  const frames = Math.floor(seconds * sampleRate);
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000),
      44 + i * 2
    );
  }
  return buffer;
}
