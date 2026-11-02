import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadPipelineRunJournal: vi.fn(),
  spawnManagedProcess: vi.fn(),
  readdir: vi.fn(() => [] as string[]),
  existsSync: vi.fn(() => true),
  lstat: vi.fn(),
  rootResolve: vi.fn(() => '/repo/dist/scripts/run_pipeline.js'),
  rootDir: vi.fn(() => '/repo'),
  shared: vi.fn(() => '/repo/active/shared/runtime/pipeline-runs'),
  assertSafeRepositoryPath: vi.fn((value: string) => value),
}));

vi.mock('../managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));
vi.mock('./pipeline-run-journal.js', () => ({
  loadPipelineRunJournal: mocks.loadPipelineRunJournal,
}));
vi.mock('../path-resolver.js', () => ({
  pathResolver: { rootResolve: mocks.rootResolve, rootDir: mocks.rootDir },
  rootDir: mocks.rootDir,
  shared: mocks.shared,
}));
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  safeExistsSync: mocks.existsSync,
  safeLstat: mocks.lstat,
  safeReaddir: mocks.readdir,
}));
vi.mock('../owner-scope.js', () => ({
  missionTierScanDirs: vi.fn((root: string) => [root]),
}));

import { resetAwaitResumeState, sweepAwaitStateRuns } from './pipeline-await-resume.js';

function suspendedState(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run-1',
    path: '/repo/active/shared/runtime/pipeline-runs/run-1.jsonl',
    events: [],
    started: { pipeline_id: 'p', input_path: 'pipelines/p.json', step_ids: ['s1'] },
    suspended: {
      step_id: 's1',
      approval_request_id: 'await-state:run-1:s1',
      storage_channel: 'pipeline-await-state',
      on_timeout: 'abort',
      await_kind: 'state',
      state_probe: { type: 'file', path: 'marker.txt', expect: 'exists' },
      ...overrides,
    },
    finished: undefined,
  };
}

describe('sweepAwaitStateRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAwaitResumeState();
    mocks.readdir.mockImplementation((dir: string) =>
      dir === '/repo/active/shared/runtime/pipeline-runs' ? ['run-1.jsonl'] : []
    );
    mocks.lstat.mockReturnValue({ isFile: () => true });
    mocks.spawnManagedProcess.mockReturnValue({ child: { once: vi.fn() } });
  });

  it('resumes a suspended state-await whose probe is satisfied', async () => {
    mocks.loadPipelineRunJournal.mockReturnValue(suspendedState());
    const serviceCall = vi.fn();
    const outcomes = await sweepAwaitStateRuns({ serviceCall });
    // file probe on 'marker.txt' — satisfied? lstat mocked isFile → exists → matched.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('resumed');
    expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'pipeline-await-resume:run-1',
        args: ['/repo/dist/scripts/run_pipeline.js', '--resume', 'run-1'],
      })
    );
  });

  it('keeps waiting while the probe is unsatisfied', async () => {
    mocks.loadPipelineRunJournal.mockReturnValue(suspendedState());
    mocks.lstat.mockImplementation((p: string) => {
      if (String(p).includes('marker.txt')) throw new Error('missing');
      return { isFile: () => true, mtimeMs: 1, size: 1 };
    });
    const outcomes = await sweepAwaitStateRuns({});
    expect(outcomes[0].status).toBe('waiting');
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
  });

  it('resumes on timeout so the step can apply on_timeout', async () => {
    mocks.loadPipelineRunJournal.mockReturnValue(
      suspendedState({ timeout_at: '2000-01-01T00:00:00Z' })
    );
    mocks.lstat.mockImplementation((p: string) => {
      if (String(p).includes('marker.txt')) throw new Error('missing');
      return { isFile: () => true, mtimeMs: 1, size: 1 };
    });
    const outcomes = await sweepAwaitStateRuns({});
    expect(outcomes[0].status).toBe('resumed');
    expect(outcomes[0].reason).toMatch(/timeout/);
  });

  it('skips approval suspensions and finished runs', async () => {
    mocks.loadPipelineRunJournal.mockReturnValue(suspendedState({ await_kind: 'approval' }));
    expect(await sweepAwaitStateRuns({})).toHaveLength(0);
    resetAwaitResumeState(); // the settled-run memo would otherwise skip the re-read
    mocks.loadPipelineRunJournal.mockReturnValue({
      ...suspendedState(),
      finished: { status: 'succeeded' },
    });
    expect(await sweepAwaitStateRuns({})).toHaveLength(0);
  });

  it('reports journal load failures per run without throwing', async () => {
    mocks.loadPipelineRunJournal.mockImplementation(() => {
      throw new Error('corrupt journal');
    });
    const outcomes = await sweepAwaitStateRuns({});
    expect(outcomes[0].status).toBe('error');
    expect(outcomes[0].reason).toMatch(/corrupt journal/);
  });

  it('does not re-read a settled journal until its file changes', async () => {
    let size = 10;
    mocks.lstat.mockImplementation(() => ({ isFile: () => true, size, mtimeMs: 5 }));
    mocks.loadPipelineRunJournal.mockReturnValue({
      ...suspendedState(),
      finished: { status: 'succeeded' },
    });
    await sweepAwaitStateRuns({});
    await sweepAwaitStateRuns({});
    expect(mocks.loadPipelineRunJournal).toHaveBeenCalledTimes(1);

    // An append (resume, new suspension) changes the size: the run is re-read.
    size = 20;
    mocks.loadPipelineRunJournal.mockReturnValue(suspendedState());
    const outcomes = await sweepAwaitStateRuns({});
    expect(mocks.loadPipelineRunJournal).toHaveBeenCalledTimes(2);
    expect(outcomes[0].status).toBe('resumed');
  });

  it('re-reads a state-suspended run every sweep and never memoises load errors', async () => {
    mocks.lstat.mockImplementation((p: string) =>
      p.endsWith('marker.txt')
        ? (() => {
            throw new Error('ENOENT');
          })()
        : { isFile: () => true, size: 1, mtimeMs: 1 }
    );
    mocks.existsSync.mockImplementation((p: string) => !String(p).endsWith('marker.txt'));
    mocks.loadPipelineRunJournal.mockReturnValue(suspendedState());
    await sweepAwaitStateRuns({});
    await sweepAwaitStateRuns({});
    expect(mocks.loadPipelineRunJournal).toHaveBeenCalledTimes(2);

    mocks.loadPipelineRunJournal.mockImplementation(() => {
      throw new Error('corrupt journal');
    });
    expect((await sweepAwaitStateRuns({}))[0].status).toBe('error');
    expect((await sweepAwaitStateRuns({}))[0].status).toBe('error');
    expect(mocks.loadPipelineRunJournal).toHaveBeenCalledTimes(4);
  });

  it('treats a run id with journals in two places as changed when either file changes', async () => {
    let missionSize = 1;
    mocks.readdir.mockImplementation((dir: string) => {
      if (dir === '/repo/active/shared/runtime/pipeline-runs') return ['run-1.jsonl'];
      if (dir === '/repo/active/missions/public') return ['MSN-A'];
      if (dir === '/repo/active/missions/public/MSN-A/coordination/pipeline-runs')
        return ['run-1.jsonl'];
      return [];
    });
    mocks.lstat.mockImplementation((p: string) => ({
      isFile: () => true,
      size: p.includes('MSN-A') ? missionSize : 1,
      mtimeMs: 1,
    }));
    mocks.loadPipelineRunJournal.mockReturnValue({
      ...suspendedState(),
      finished: { status: 'succeeded' },
    });
    await sweepAwaitStateRuns({});
    await sweepAwaitStateRuns({});
    expect(mocks.loadPipelineRunJournal).toHaveBeenCalledTimes(1);
    missionSize = 2;
    await sweepAwaitStateRuns({});
    expect(mocks.loadPipelineRunJournal).toHaveBeenCalledTimes(2);
  });

  it('yields to the event loop during a long sweep so heartbeat timers can fire', async () => {
    mocks.readdir.mockImplementation((dir: string) =>
      dir === '/repo/active/shared/runtime/pipeline-runs'
        ? ['run-1.jsonl', 'run-2.jsonl', 'run-3.jsonl']
        : []
    );
    mocks.lstat.mockReturnValue({ isFile: () => true, size: 1, mtimeMs: 1 });
    let timerFired = false;
    const firedBeforeLoad: boolean[] = [];
    mocks.loadPipelineRunJournal.mockImplementation(() => {
      firedBeforeLoad.push(timerFired);
      const until = Date.now() + 40; // each synchronous read outlasts the yield budget
      while (Date.now() < until) {
        /* busy */
      }
      return { ...suspendedState(), finished: { status: 'succeeded' } };
    });
    setImmediate(() => {
      timerFired = true;
    });
    await sweepAwaitStateRuns({});
    expect(firedBeforeLoad).toEqual([false, true, true]);
  });
});
