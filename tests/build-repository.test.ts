import { describe, it, expect, vi } from 'vitest';
import { buildRepository, type BuildDependencies } from '../scripts/build_repository.js';

function dependencies() {
  const stages: string[] = [];
  const snapshot = () => ({
    sourceHash: 'fixture-source-hash',
    configHash: 'fixture-config-hash',
    fileCount: 0,
    takenAt: '2026-10-31T00:00:00.000Z',
  });
  const deps: BuildDependencies = {
    run: vi.fn(async (stage) => {
      stages.push(stage.name);
    }),
    clean: vi.fn(() => {
      stages.push('clean');
    }),
    record: vi.fn(),
    readiness: async () => true,
    lock: async (build) => build(),
    // Real snapshots would walk the live repo and a real publish would write
    // dist/.build-generation.json — fixture deps keep tests hermetic.
    snapshotInputs: vi.fn(async () => snapshot()),
    publishReceipt: vi.fn(),
  };
  return { deps, stages };
}

describe('governed compiler build', () => {
  it('preserves full build order and records one compiler success before poststeps', async () => {
    const { deps, stages } = dependencies();
    await buildRepository('all', deps);
    expect(stages).toEqual([
      'clean',
      'packages',
      'package-scopes',
      'repository',
      'repository-scopes',
      'bundles',
      'knowledge-manifest',
      'ui',
      'source-shadows',
    ]);
    expect(deps.record).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      passed: true,
      restored: true,
    });
  });

  it('counts an actual failed compiler once and stops subsequent stages', async () => {
    const { deps } = dependencies();
    deps.run = vi.fn(async () => {
      throw new Error('tsc failure');
    });
    await expect(buildRepository('packages', deps)).rejects.toThrow('tsc failure');
    expect(deps.record).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      passed: false,
      reason: 'tsc failure',
    });
    expect(deps.clean).not.toHaveBeenCalled();
  });

  it('never counts acquisition failure as a compiler attempt', async () => {
    const { deps } = dependencies();
    deps.lock = async () => {
      throw new Error('lock busy');
    };
    await expect(buildRepository('repo', deps)).rejects.toThrow('lock busy');
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('does not classify a UI failure as a compiler recovery failure', async () => {
    const { deps } = dependencies();
    deps.run = async (stage) => {
      if (stage.name === 'ui') throw new Error('vite failure');
    };
    await expect(buildRepository('all', deps)).rejects.toThrow('vite failure');
    expect(deps.record).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      passed: true,
      restored: true,
    });
  });
  it('records partial readiness without failing an otherwise successful partial build', async () => {
    const { deps } = dependencies();
    deps.readiness = async () => false;
    await buildRepository('packages', deps);
    expect(deps.record).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      passed: true,
      restored: false,
    });
  });

  it('retains the repair budget when the readiness scan fails', async () => {
    const { deps } = dependencies();
    deps.readiness = async () => {
      throw new Error('scan details');
    };
    await buildRepository('repo', deps);
    expect(deps.record).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      passed: true,
      restored: false,
      reason: 'Compiler readiness scan failed after build',
    });
  });
});

// The injected child never launches a process or sends an OS signal.
import { EventEmitter } from 'node:events';
import {
  runBuildStage,
  resolveBuildCommand,
  type BuildStageRuntime,
} from '../scripts/build_repository.js';

function stageRuntime() {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    pid: 424242,
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const handlers = new Map<string, () => void>();
  const runtime: BuildStageRuntime = {
    spawn: vi.fn(() => child) as unknown as BuildStageRuntime['spawn'],
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
    },
    offSignal: (signal) => {
      handlers.delete(signal);
    },
    signalGroup: vi.fn(),
    windows: false,
  };
  return { runtime, child, handlers };
}

describe('compiler stage shutdown', () => {
  it('executes the Windows pnpm JS entrypoint through Node without a shell', async () => {
    const { runtime, child } = stageRuntime();
    runtime.windows = true;
    runtime.packageManagerEntrypoint = 'C:\\setup-pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs';
    const pending = runBuildStage(
      { name: 'ui', command: 'pnpm', args: ['run', 'build:ui'] },
      runtime
    );
    expect(runtime.spawn).toHaveBeenCalledWith(
      process.execPath,
      [runtime.packageManagerEntrypoint, 'run', 'build:ui'],
      expect.objectContaining({ detached: false })
    );
    child.emit('close', 0, null);
    await pending;
  });

  it('executes a standalone Windows pnpm executable directly without a shell', async () => {
    const { runtime, child } = stageRuntime();
    runtime.windows = true;
    runtime.packageManagerEntrypoint = 'C:\\pnpm\\pnpm.exe';
    const pending = runBuildStage(
      { name: 'ui', command: 'pnpm', args: ['run', 'build:ui'] },
      runtime
    );
    expect(runtime.spawn).toHaveBeenCalledWith(
      'C:\\pnpm\\pnpm.exe',
      ['run', 'build:ui'],
      expect.objectContaining({ detached: false })
    );
    child.emit('close', 0, null);
    await pending;
  });

  it('resolves the Windows pnpm command from the lifecycle entrypoint', () => {
    const stage = { name: 'ui', command: 'pnpm', args: ['run', 'build:ui'] };
    for (const entrypoint of [
      'C:\\setup-pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs',
      'C:\\pnpm\\pnpm.mjs',
    ]) {
      expect(resolveBuildCommand(stage, true, entrypoint)).toEqual({
        ...stage,
        command: process.execPath,
        args: [entrypoint, 'run', 'build:ui'],
      });
    }
    expect(resolveBuildCommand(stage, true, 'C:\\pnpm\\pnpm.exe')).toEqual({
      ...stage,
      command: 'C:\\pnpm\\pnpm.exe',
    });
    for (const entry of [undefined, 'pnpm.cjs', 'C:\\pnpm.cmd', 'C:\\pnpm\\pnpm.ps1']) {
      expect(() => resolveBuildCommand(stage, true, entry)).toThrow('run pnpm build');
    }
    expect(resolveBuildCommand(stage, false)).toBe(stage);
  });
  it('forwards termination to the process group, retains the build lock until close, and stops later stages', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, child, handlers } = stageRuntime();
      let locked = false;
      const { deps } = dependencies();
      deps.run = vi.fn((stage) => runBuildStage(stage, runtime));
      deps.lock = async (build) => {
        locked = true;
        try {
          return await build();
        } finally {
          locked = false;
        }
      };
      const pending = buildRepository('repo', deps);
      const rejection = expect(pending).rejects.toThrow('cancelled (SIGTERM)');
      // The input snapshot now precedes stage execution — signal only once
      // the stage (and therefore its child + handlers) actually exists.
      await vi.waitFor(() => expect(deps.run).toHaveBeenCalledTimes(1));
      handlers.get('SIGTERM')!();
      expect(runtime.signalGroup).toHaveBeenCalledWith(424242, 'SIGTERM');
      expect(locked).toBe(true);
      expect(deps.run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(runtime.signalGroup).toHaveBeenCalledWith(424242, 'SIGKILL');
      expect(locked).toBe(true);
      child.emit('close', null, 'SIGTERM');
      await rejection;
      expect(locked).toBe(false);
      expect(deps.run).toHaveBeenCalledTimes(1);
      expect(handlers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans signal handlers and timers on success and spawn failure', async () => {
    vi.useFakeTimers();
    try {
      const successful = stageRuntime();
      const pending = runBuildStage(
        { name: 'test', command: 'node', args: [] },
        successful.runtime
      );
      successful.child.emit('close', 0, null);
      await pending;
      expect(successful.handlers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const failed = stageRuntime();
      Object.assign(failed.child, { pid: undefined });
      const failedPromise = runBuildStage(
        { name: 'test', command: 'node', args: [] },
        failed.runtime
      );
      const rejection = expect(failedPromise).rejects.toThrow('failed to spawn');
      failed.child.emit('error', new Error('spawn failed'));
      await rejection;
      expect(failed.handlers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses direct child termination on Windows', async () => {
    const { runtime, child, handlers } = stageRuntime();
    runtime.windows = true;
    const pending = runBuildStage({ name: 'test', command: 'node', args: [] }, runtime);
    const rejection = expect(pending).rejects.toThrow('cancelled (SIGINT)');
    handlers.get('SIGINT')!();
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    expect(runtime.signalGroup).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGINT');
    await rejection;
  });
});

import { safeSpawn } from '../libs/core/secure-io.js';

describe('compiler stage signal integration', () => {
  // Windows termination has no catchable POSIX SIGTERM; its direct-child
  // cancellation path is exercised by the injected runtime test above.
  it.skipIf(process.platform === 'win32')(
    'keeps the wrapper alive until its signalled child finishes closing',
    async () => {
      const compiler =
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 2100)); console.log('CHILD_READY'); setInterval(() => {}, 1000);";
      const fixture = `
      import { runBuildStage } from './scripts/build_repository.ts';
      await runBuildStage({name:'signal-fixture',command:process.execPath,args:['-e',${JSON.stringify(compiler)}]})
        .catch(() => { process.exitCode = 0; });
    `;
      const wrapper = safeSpawn(process.execPath, [
        '--import',
        './scripts/ts-loader.mjs',
        '--input-type=module',
        '-e',
        fixture,
      ]);
      let signalledAt = 0;
      const result = new Promise<void>((resolve, reject) => {
        let stderr = '';
        const ready = (chunk: Buffer | string) => {
          if (!signalledAt && String(chunk).includes('CHILD_READY')) {
            signalledAt = Date.now();
            wrapper.kill('SIGTERM');
          }
        };
        const deadline = setTimeout(() => reject(new Error('fixture did not close')), 9000);
        wrapper.stderr.on('data', (chunk) => {
          stderr += String(chunk);
          ready(chunk);
        });
        wrapper.stdout.on('data', ready);
        wrapper.once('error', reject);
        wrapper.once('close', (code, signal) => {
          clearTimeout(deadline);
          if (code !== 0 || signal) reject(new Error(`wrapper ${code}/${signal}: ${stderr}`));
          else resolve();
        });
      });
      try {
        await result;
        expect(signalledAt).toBeGreaterThan(0);
        expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(1800);
      } finally {
        if (wrapper.exitCode === null) {
          const closed = new Promise<void>((resolve) => wrapper.once('close', () => resolve()));
          wrapper.kill('SIGTERM');
          await closed;
        }
      }
    },
    15000
  );
});
