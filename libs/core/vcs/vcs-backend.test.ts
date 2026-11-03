// Step-4 distributed-runtime acceptance: the vcs-backend seam resolves the
// governed default (local-git), explicit selectors win, typed verbs run
// hermetically on an injected memory backend — and governance (verb allowlist,
// flag hygiene) is enforced ABOVE the backend, so a swapped backend can never
// widen the accepted command surface.
import { describe, expect, it } from 'vitest';
import { rootDir } from '../path-resolver.js';
import { safeExecResult } from '../secure-io.js';
import {
  LOCAL_GIT_BACKEND_ID,
  getVcsBackend,
  registerVcsBackend,
  resetVcsBackends,
  resolveVcsBackend,
} from './vcs-backend.js';
import './local-git-backend.js';
import { MEMORY_VCS_BACKEND_ID, createMemoryVcsBackend } from './memory-vcs-backend.js';
import { gitDiff, gitDiffChangedPaths, gitLog, gitRun, gitStatus } from './git.js';

const ROOT = rootDir();

describe('vcs-backend seam', () => {
  it('resolves the governed default to local-git', () => {
    expect(resolveVcsBackend().id).toBe(LOCAL_GIT_BACKEND_ID);
  });

  it('local-git delegates to the governed safeExecResult boundary', () => {
    expect(resolveVcsBackend(LOCAL_GIT_BACKEND_ID).run).toBe(safeExecResult);
  });

  it('resolves an explicit selector over the default', () => {
    expect(resolveVcsBackend(MEMORY_VCS_BACKEND_ID).id).toBe(MEMORY_VCS_BACKEND_ID);
  });

  it('throws for an unknown selector', () => {
    expect(() => resolveVcsBackend('no-such-backend')).toThrow(/unknown backend 'no-such-backend'/);
  });

  it('keeps memory out of the default chain (registered but never auto-selected)', () => {
    expect(getVcsBackend(MEMORY_VCS_BACKEND_ID)).toBeDefined();
    expect(resolveVcsBackend().id).toBe(LOCAL_GIT_BACKEND_ID);
  });

  it('resolves a caller-registered backend by selector', () => {
    const calls: string[][] = [];
    const unregister = registerVcsBackend(
      {
        id: 'fixture-remote',
        run: (_command, args) => {
          calls.push(args);
          return { stdout: 'ok', stderr: '', status: 0 };
        },
      },
      { provenance: 'plugin', source: 'vcs-backend.test' }
    );
    try {
      const backend = resolveVcsBackend('fixture-remote');
      expect(backend.run('git', ['status'], { cwd: ROOT }).stdout).toBe('ok');
      expect(calls).toEqual([['status']]);
    } finally {
      unregister();
    }
  });
});

describe('typed verbs on a memory backend', () => {
  it('runs gitStatus hermetically and records argv + cwd', () => {
    const backend = createMemoryVcsBackend();
    backend.respond('status', { stdout: ' M file.ts\n', stderr: '', status: 0 });
    const result = gitStatus(ROOT, { short: true }, backend.run);
    expect(result.stdout).toBe(' M file.ts\n');
    expect(backend.invocations).toEqual([
      {
        command: 'git',
        args: ['status', '--short'],
        options: { cwd: ROOT },
      },
    ]);
  });

  it('parses NUL-separated diff paths from the fixture result', () => {
    const backend = createMemoryVcsBackend();
    backend.respond('diff', {
      stdout: 'src/a.ts\0src/b.ts\0',
      stderr: '',
      status: 0,
    });
    const { paths, result } = gitDiffChangedPaths(ROOT, { cached: true }, backend.run);
    expect(result.status).toBe(0);
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns backend non-zero exits as results, not throws', () => {
    const backend = createMemoryVcsBackend();
    backend.respond('log', { stdout: '', stderr: 'fatal: bad revision', status: 128 });
    const result = gitLog(ROOT, { limit: 1 }, backend.run);
    expect(result.status).toBe(128);
    expect(result.stderr).toContain('bad revision');
  });

  it('consumes each queued response once, then falls back', () => {
    const backend = createMemoryVcsBackend();
    backend.respond('status', { stdout: 'first', stderr: '', status: 0 });
    expect(gitStatus(ROOT, {}, backend.run).stdout).toBe('first');
    expect(gitStatus(ROOT, {}, backend.run).stdout).toBe('');
  });
});

describe('governance stays above the backend', () => {
  it('rejects non-allowlisted verbs before the backend is invoked', () => {
    const backend = createMemoryVcsBackend();
    expect(() => gitRun(['push', 'origin', 'main'], ROOT, backend.run)).toThrow(
      /VCS_TYPED_VERB_REQUIRED/
    );
    expect(backend.invocations).toHaveLength(0);
  });

  it('rejects flag-shaped refs before the backend is invoked', () => {
    const backend = createMemoryVcsBackend();
    expect(() => gitDiff(ROOT, { ref: '--exec' }, backend.run)).toThrow(/VCS_GIT_INVALID/);
    expect(backend.invocations).toHaveLength(0);
  });

  it('seam reset clears registered providers', () => {
    resetVcsBackends();
    expect(() => resolveVcsBackend()).toThrow(/no backend registered/);
  });
});
