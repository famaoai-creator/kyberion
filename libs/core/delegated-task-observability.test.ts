import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  buildDelegatedTaskWorkerProcessSpec,
  completeDelegatedTaskTrace,
  claimDelegatedTaskActivation,
  consumeDelegatedTaskInbox,
  delegatedTaskStoreDir,
  enqueueDelegatedTaskInbox,
  hasPendingDelegatedTaskInbox,
  listActiveDelegatedTaskRecords,
  loadDelegatedTaskRecord,
  resumeDelegatedTask,
  registerDelegatedTaskWorker,
  spawnDelegatedTaskWorkerProcess,
  startDelegatedTaskTrace,
  wakeDelegatedTaskWorker,
} from './delegated-task-observability.js';
import {
  delegationNotificationsPath,
  listDelegationNotifications,
} from './delegation-notifications.js';

const STORE_OVERRIDE = `active/shared/tmp/kc06-tests/delegations-${process.pid}`;
const TRACE_OVERRIDE = `active/shared/tmp/kc06-tests/delegations-trace-${process.pid}.jsonl`;
const QUEUE_OVERRIDE = `active/shared/tmp/kc06-tests/observability-notifications-${process.pid}.jsonl`;

function cleanup(): void {
  const dir = pathResolver.rootResolve(STORE_OVERRIDE);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
  const tracePath = pathResolver.rootResolve(TRACE_OVERRIDE);
  if (safeExistsSync(tracePath)) safeRmSync(tracePath);
  if (safeExistsSync(delegationNotificationsPath())) safeRmSync(delegationNotificationsPath());
}

function setOverrides(): void {
  process.env.KYBERION_DELEGATION_STORE_DIR = STORE_OVERRIDE;
  process.env.KYBERION_DELEGATION_TRACE_PATH = TRACE_OVERRIDE;
  process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH = QUEUE_OVERRIDE;
}

describe('KC-06 delegated-task-observability store', () => {
  beforeEach(() => {
    setOverrides();
    cleanup();
  });

  afterAll(() => {
    setOverrides();
    cleanup();
    delete process.env.KYBERION_DELEGATION_STORE_DIR;
    delete process.env.KYBERION_DELEGATION_TRACE_PATH;
    delete process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH;
  });

  it('persists a per-delegation record across start and completion', () => {
    const trace = startDelegatedTaskTrace({
      owner: 'test-owner',
      instruction: 'Analyze the corpus and report findings.',
      context: 'kc06-store-test',
    });
    const started = loadDelegatedTaskRecord(trace.trace_id);
    expect(started?.status).toBe('started');
    expect(started?.instruction).toBe('Analyze the corpus and report findings.');
    expect(started?.context).toBe('kc06-store-test');

    completeDelegatedTaskTrace(trace, { resultSummary: 'Findings written to report.md' });
    const completed = loadDelegatedTaskRecord(trace.trace_id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result_summary).toBe('Findings written to report.md');
    expect(completed?.completed_at).toBeTruthy();
    expect(completed?.child_report).toMatchObject({
      source: 'child',
      delegation_id: trace.trace_id,
    });
    expect(completed?.settlement).toMatchObject({ source: 'owner', status: 'completed' });
    expect(delegatedTaskStoreDir()).toContain('kc06-tests');
  });

  it('persists the canonical schema payload for resumable snapshots', () => {
    const trace = startDelegatedTaskTrace({
      owner: 'canonical-owner',
      instruction: 'Persist only the governed snapshot shape.',
    });
    const traceWithSchema = {
      ...trace,
      $schema: 'https://example.invalid/delegated-task.json',
    } as typeof trace & { $schema: string };

    completeDelegatedTaskTrace(traceWithSchema, { resultSummary: 'snapshot ready' });

    const persistedPath = pathResolver.rootResolve(
      path.join(STORE_OVERRIDE, `${trace.trace_id}.json`)
    );
    const persisted = JSON.parse(String(safeReadFile(persistedPath, { encoding: 'utf8' })));
    expect(persisted.$schema).toBeUndefined();
    expect(loadDelegatedTaskRecord(trace.trace_id)?.status).toBe('completed');
  });

  it('fails closed for schema-invalid and non-regular records', () => {
    const trace = startDelegatedTaskTrace({
      owner: 'test-owner',
      instruction: 'Validate the persisted record boundary.',
    });
    const persistedPath = pathResolver.rootResolve(
      path.join(STORE_OVERRIDE, `${trace.trace_id}.json`)
    );
    safeWriteFile(persistedPath, JSON.stringify({ delegation_id: trace.trace_id }), {
      encoding: 'utf8',
    });
    expect(loadDelegatedTaskRecord(trace.trace_id)).toBeNull();

    safeRmSync(persistedPath, { recursive: true, force: true });
    safeMkdir(persistedPath, { recursive: true });
    expect(loadDelegatedTaskRecord(trace.trace_id)).toBeNull();
  });

  it('builds a runtime-supervised worker spec without putting inbox text in argv', () => {
    const trace = startDelegatedTaskTrace({
      owner: 'process-spec-owner',
      instruction: 'Resume through the managed worker.',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'checkpoint ready' });

    const spec = buildDelegatedTaskWorkerProcessSpec(trace.trace_id, 'process-spec-owner');

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toContain('--delegation-id');
    expect(spec.args).toContain(trace.trace_id);
    expect(spec.args).toContain('--owner');
    expect(spec.args).toContain('process-spec-owner');
    expect(spec.args).not.toContain('Resume through the managed worker.');
    expect(spec.metadata).toMatchObject({
      childSessionId: trace.child_session_id,
      owner: 'process-spec-owner',
      workerKind: 'continuable-delegation',
    });
  });

  it('lists only still-running delegations, newest first and bounded', () => {
    const running = startDelegatedTaskTrace({ owner: 'o', instruction: 'still running' });
    const done = startDelegatedTaskTrace({ owner: 'o', instruction: 'already done' });
    completeDelegatedTaskTrace(done, { resultSummary: 'done' });

    const active = listActiveDelegatedTaskRecords(8);
    expect(active.map((record) => record.delegation_id)).toEqual([running.trace_id]);
    expect(listActiveDelegatedTaskRecords(0)).toEqual([]);
  });

  it('rejects an observability trace override outside the repository', () => {
    const originalTrace = process.env.KYBERION_DELEGATION_TRACE_PATH;
    process.env.KYBERION_DELEGATION_TRACE_PATH = '/tmp/delegations-external.jsonl';
    try {
      expect(() =>
        startDelegatedTaskTrace({ owner: 'path-owner', instruction: 'must not write outside' })
      ).toThrow('[RESOURCE_PATH_SCOPE]');
    } finally {
      process.env.KYBERION_DELEGATION_TRACE_PATH = originalTrace;
    }
  });

  it('rejects an observability store override traversing a symbolic link', () => {
    const targetPath = pathResolver.sharedTmp(`delegations-target-${process.pid}`);
    const linkPath = pathResolver.sharedTmp(`delegations-link-${process.pid}`);
    safeWriteFile(`${targetPath}/placeholder.json`, '{}');
    safeSymlinkSync(targetPath, linkPath, 'dir');
    const originalStore = process.env.KYBERION_DELEGATION_STORE_DIR;
    process.env.KYBERION_DELEGATION_STORE_DIR = linkPath;
    try {
      expect(() => delegatedTaskStoreDir()).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      process.env.KYBERION_DELEGATION_STORE_DIR = originalStore;
      safeUnlinkSync(linkPath);
      safeRmSync(targetPath, { recursive: true, force: true });
    }
  });

  it('enqueues a claim-based notification when a background delegation completes', () => {
    const trace = startDelegatedTaskTrace({
      owner: 'background-owner',
      instruction: 'Run the long background audit.',
      background: true,
      missionId: 'M1',
      taskId: 'T1',
    });
    expect(listDelegationNotifications()).toHaveLength(0);
    completeDelegatedTaskTrace(trace, { resultSummary: 'Audit finished; 0 findings.' });

    const notifications = listDelegationNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.delegation_id).toBe(trace.trace_id);
    expect(notifications[0]?.status).toBe('completed');
    expect(notifications[0]?.result_excerpt).toContain('Audit finished');
    expect(notifications[0]?.mission_id).toBe('M1');
    expect(notifications[0]?.task_id).toBe('T1');
    expect(notifications[0]?.claimed).toBe(false);
    expect(notifications[0]?.report_provenance.source).toBe('child');
  });

  it('does not notify for foreground delegations', () => {
    const trace = startDelegatedTaskTrace({ owner: 'fg', instruction: 'foreground work' });
    completeDelegatedTaskTrace(trace, { resultSummary: 'ok' });
    expect(listDelegationNotifications()).toHaveLength(0);
  });

  it('resumes a delegation by id, embedding the stored instruction and result', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'resume-owner',
      instruction: 'Draft the governance summary.',
      context: 'kc06-resume-test',
    });
    completeDelegatedTaskTrace(trace, {
      resultSummary: 'Draft saved to active/shared/tmp/governance-summary.md',
    });

    const prompts: Array<{ instruction: string; context?: string }> = [];
    const { result, trace: resumeTrace } = await resumeDelegatedTask(
      trace.trace_id,
      'Add a risk section to the summary.',
      {
        backend: {
          delegateTask: async (instruction, context) => {
            prompts.push({ instruction, context });
            return 'Risk section appended.';
          },
        },
      }
    );

    expect(result).toBe('Risk section appended.');
    expect(prompts).toHaveLength(1);
    // The composed prompt restores the stored context (acceptance criterion 2).
    expect(prompts[0]?.instruction).toContain('Draft the governance summary.');
    expect(prompts[0]?.instruction).toContain(
      'Draft saved to active/shared/tmp/governance-summary.md'
    );
    expect(prompts[0]?.instruction).toContain('Add a risk section to the summary.');
    expect(prompts[0]?.context).toBe('kc06-resume-test');

    // The resume run is itself a persisted, resumable delegation.
    expect(resumeTrace.status).toBe('completed');
    expect(resumeTrace.resumed_from).toBe(trace.trace_id);
    expect(loadDelegatedTaskRecord(resumeTrace.trace_id)?.result_summary).toBe(
      'Risk section appended.'
    );
  });

  it('throws a recoverable error when the delegation id is unknown', async () => {
    await expect(resumeDelegatedTask('missing-id', 'follow up')).rejects.toThrow(
      /record not found/
    );
  });

  // KD-05 acceptance criterion 3: resume of a delegation id owned by another
  // worker or still running is rejected.
  it('rejects resume of a still-running (status: started) delegation', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'worker-a',
      instruction: 'Long-running audit, not finished yet.',
    });

    await expect(
      resumeDelegatedTask(trace.trace_id, 'follow up', {
        backend: { delegateTask: vi.fn(async () => 'should not run') },
      })
    ).rejects.toThrow(/still running/);
  });

  it('rejects resume when requestedBy does not match the delegation owner', async () => {
    const trace = startDelegatedTaskTrace({ owner: 'worker-a', instruction: 'Draft the report.' });
    completeDelegatedTaskTrace(trace, { resultSummary: 'Report drafted.' });

    await expect(
      resumeDelegatedTask(trace.trace_id, 'follow up', {
        requestedBy: 'worker-b',
        backend: { delegateTask: vi.fn(async () => 'should not run') },
      })
    ).rejects.toThrow(/owned by "worker-a"/);
  });

  it('allows resume when requestedBy matches the owning worker of a completed delegation', async () => {
    const trace = startDelegatedTaskTrace({ owner: 'worker-a', instruction: 'Draft the report.' });
    completeDelegatedTaskTrace(trace, { resultSummary: 'Report drafted.' });

    const { result } = await resumeDelegatedTask(trace.trace_id, 'Add a summary.', {
      requestedBy: 'worker-a',
      backend: { delegateTask: vi.fn(async () => 'Summary appended.') },
    });
    expect(result).toBe('Summary appended.');
  });

  it('persists a child session and atomically limits cold resume to one activation', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'child-owner',
      instruction: 'Maintain a durable child task.',
      continuable: true,
    });
    expect(trace.child_session_id).toMatch(/^child-/u);
    expect(loadDelegatedTaskRecord(trace.trace_id)).toMatchObject({
      continuable: true,
      child_session_id: trace.child_session_id,
      activation_count: 0,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'checkpoint saved' });

    const claimed = claimDelegatedTaskActivation(trace.trace_id, 'child-owner');
    expect(claimed.activation_count).toBe(1);
    expect(claimed.activation_id).toBeTruthy();
    expect(loadDelegatedTaskRecord(trace.trace_id)?.activation_count).toBe(1);
    expect(() => claimDelegatedTaskActivation(trace.trace_id, 'child-owner')).toThrow(
      /one-shot activation/
    );
  });

  it('claims the continuable activation before cold-resume dispatch', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'cold-owner',
      instruction: 'Build a resumable child result.',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'initial result' });
    const backend = { delegateTask: vi.fn(async () => 'resumed result') };
    const resumed = await resumeDelegatedTask(trace.trace_id, 'continue from checkpoint', {
      requestedBy: 'cold-owner',
      backend,
    });
    expect(resumed.record.activation_count).toBe(1);
    expect(resumed.record.activation_status).toBe('completed');
    expect(resumed.record.activation_result_delegation_id).toBe(resumed.trace.trace_id);
    expect(backend.delegateTask).toHaveBeenCalledTimes(1);
    await expect(
      resumeDelegatedTask(trace.trace_id, 'try duplicate activation', {
        requestedBy: 'cold-owner',
        backend,
      })
    ).rejects.toThrow(/one-shot activation/);
  });

  it('durably records a failed activation and never retries it', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'activation-owner',
      instruction: 'Run the child session once.',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'checkpoint ready' });
    const backend = {
      delegateTask: vi.fn(async () => {
        throw new Error('provider unavailable');
      }),
    };

    await expect(
      resumeDelegatedTask(trace.trace_id, 'continue after checkpoint', {
        requestedBy: 'activation-owner',
        backend,
      })
    ).rejects.toThrow('provider unavailable');

    const failed = loadDelegatedTaskRecord(trace.trace_id);
    expect(failed).toMatchObject({
      activation_count: 1,
      activation_status: 'failed',
      activation_failure: {
        source: 'owner',
      },
    });
    expect(failed?.activation_failure?.activation_id).toBe(failed?.activation_id);
    expect(failed?.activation_failure?.error).toBe('provider unavailable');
    expect(backend.delegateTask).toHaveBeenCalledTimes(1);

    await expect(
      resumeDelegatedTask(trace.trace_id, 'retry must be rejected', {
        requestedBy: 'activation-owner',
        backend,
      })
    ).rejects.toThrow(/one-shot activation/);
    expect(backend.delegateTask).toHaveBeenCalledTimes(1);
  });

  it('uses a child-session durable inbox as the sole cold-resume input queue', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'inbox-owner',
      instruction: 'Maintain the child checkpoint.',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'checkpoint saved' });

    const queued = await enqueueDelegatedTaskInbox(trace.trace_id, {
      text: 'operator follow-up',
      requestedBy: 'inbox-owner',
    });
    expect(queued.delivery).toBe('next_run');
    expect(await hasPendingDelegatedTaskInbox(trace.trace_id, 'inbox-owner')).toBe(true);
    expect(
      (await consumeDelegatedTaskInbox(trace.trace_id, { requestedBy: 'inbox-owner' })).map(
        (entry) => entry.text
      )
    ).toEqual(['operator follow-up']);
    expect(await consumeDelegatedTaskInbox(trace.trace_id, { requestedBy: 'inbox-owner' })).toEqual(
      []
    );
    expect(await hasPendingDelegatedTaskInbox(trace.trace_id, 'inbox-owner')).toBe(false);
  });

  it('routes the resume follow-up through the child inbox before provider dispatch', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'resume-inbox-owner',
      instruction: 'Resume from the durable child checkpoint.',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'ready' });
    let dispatchedPrompt = '';
    await resumeDelegatedTask(trace.trace_id, 'continue only through the inbox', {
      requestedBy: 'resume-inbox-owner',
      backend: {
        delegateTask: async (prompt) => {
          dispatchedPrompt = prompt;
          return 'done';
        },
      },
    });
    expect(dispatchedPrompt).toContain('continue only through the inbox');
    expect(
      await consumeDelegatedTaskInbox(trace.trace_id, { requestedBy: 'resume-inbox-owner' })
    ).toEqual([]);
  });

  it('wakes a registered child worker and resumes only from its durable inbox', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'worker-runtime-owner',
      instruction: 'Run as a dedicated child worker.',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'checkpoint ready' });
    const dispatchedPrompts: string[] = [];
    let wakeCount = 0;
    const dispose = registerDelegatedTaskWorker(trace.trace_id, {
      owner: 'worker-runtime-owner',
      handler: async (wake) => {
        wakeCount += 1;
        expect(wake).toMatchObject({
          delegationId: trace.trace_id,
          childSessionId: trace.child_session_id,
          reason: 'next_run',
        });
        await resumeDelegatedTask(trace.trace_id, '', {
          requestedBy: 'worker-runtime-owner',
          fromInbox: true,
          backend: {
            delegateTask: async (prompt) => {
              dispatchedPrompts.push(prompt);
              return 'worker completed';
            },
          },
        });
      },
    });

    await enqueueDelegatedTaskInbox(trace.trace_id, {
      text: 'execute the queued child follow-up',
      requestedBy: 'worker-runtime-owner',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wakeCount).toBe(1);
    expect(await wakeDelegatedTaskWorker(trace.trace_id, 'worker-runtime-owner')).toBe(false);
    expect(dispatchedPrompts[0]).toContain('execute the queued child follow-up');
    expect(
      await consumeDelegatedTaskInbox(trace.trace_id, { requestedBy: 'worker-runtime-owner' })
    ).toEqual([]);
    expect(loadDelegatedTaskRecord(trace.trace_id)?.activation_count).toBe(1);
    expect(loadDelegatedTaskRecord(trace.trace_id)?.activation_status).toBe('completed');
    dispose();
  });

  it('replays pending inbox data when a child worker registers after restart', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'restart-owner',
      instruction: 'Resume after worker restart.',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'restart checkpoint' });
    await enqueueDelegatedTaskInbox(trace.trace_id, {
      text: 'resume from the persisted queue',
      requestedBy: 'restart-owner',
      wake: false,
    });
    let resumed = false;
    const dispose = registerDelegatedTaskWorker(trace.trace_id, {
      owner: 'restart-owner',
      handler: async () => {
        resumed = true;
        await resumeDelegatedTask(trace.trace_id, '', {
          requestedBy: 'restart-owner',
          fromInbox: true,
          backend: { delegateTask: async () => 'replayed' },
        });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resumed).toBe(true);
    expect(loadDelegatedTaskRecord(trace.trace_id)?.activation_count).toBe(1);
    dispose();
  });

  it('consumes a durable inbox through the real supervised worker process', async () => {
    const trace = startDelegatedTaskTrace({
      owner: 'process-e2e-owner',
      instruction: 'Resume through a real one-shot worker process.',
      continuable: true,
    });
    completeDelegatedTaskTrace(trace, { resultSummary: 'process checkpoint ready' });
    await enqueueDelegatedTaskInbox(trace.trace_id, {
      text: 'consume this from the child process',
      requestedBy: 'process-e2e-owner',
      wake: false,
    });

    const previousBackend = process.env.KYBERION_REASONING_BACKEND;
    process.env.KYBERION_REASONING_BACKEND = 'stub';
    const handle = spawnDelegatedTaskWorkerProcess(trace.trace_id, 'process-e2e-owner');
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            handle.child.kill();
            reject(new Error('delegated worker process did not exit in time'));
          }, 30_000);
          handle.child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
          });
          handle.child.once('error', reject);
        }
      );
      expect(exit.code).toBe(0);
    } finally {
      if (previousBackend === undefined) delete process.env.KYBERION_REASONING_BACKEND;
      else process.env.KYBERION_REASONING_BACKEND = previousBackend;
    }

    const settled = loadDelegatedTaskRecord(trace.trace_id);
    expect(settled).toMatchObject({
      activation_count: 1,
      activation_status: 'completed',
      activation_result_delegation_id: expect.any(String),
    });
    expect(
      await consumeDelegatedTaskInbox(trace.trace_id, { requestedBy: 'process-e2e-owner' })
    ).toEqual([]);
  }, 45_000);
});
