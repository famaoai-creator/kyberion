import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';
import {
  completeDelegatedTaskTrace,
  delegatedTaskStoreDir,
  listActiveDelegatedTaskRecords,
  loadDelegatedTaskRecord,
  resumeDelegatedTask,
  startDelegatedTaskTrace,
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
    expect(delegatedTaskStoreDir()).toContain('kc06-tests');
  });

  it('lists only still-running delegations, newest first and bounded', () => {
    const running = startDelegatedTaskTrace({ owner: 'o', instruction: 'still running' });
    const done = startDelegatedTaskTrace({ owner: 'o', instruction: 'already done' });
    completeDelegatedTaskTrace(done, { resultSummary: 'done' });

    const active = listActiveDelegatedTaskRecords(8);
    expect(active.map((record) => record.delegation_id)).toEqual([running.trace_id]);
    expect(listActiveDelegatedTaskRecords(0)).toEqual([]);
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
});
