import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDelegationNotificationLines,
  buildDispatchCarryover,
} from './mission-orchestration-worker.js';
import { renderCarryoverBlock } from './worker-context-compaction.js';
import {
  completeDelegatedTaskTrace,
  startDelegatedTaskTrace,
} from './delegated-task-observability.js';
import {
  delegationNotificationsPath,
  enqueueDelegationNotification,
} from './delegation-notifications.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';

const STORE_OVERRIDE = `active/shared/tmp/kc06-tests/worker-delegations-${process.pid}`;
const TRACE_OVERRIDE = `active/shared/tmp/kc06-tests/worker-delegations-trace-${process.pid}.jsonl`;
const QUEUE_OVERRIDE = `active/shared/tmp/kc06-tests/worker-notifications-${process.pid}.jsonl`;

function makeTasks() {
  const allTasks = [
    { task_id: 'T1', status: 'completed', deliverable: 'report-draft.md' },
    { task_id: 'T2', status: 'planned', description: 'Assemble final deliverable' },
  ];
  return { task: allTasks[1], allTasks };
}

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

describe('KC-06 mission worker delegation hardening', () => {
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

  it('carries still-running delegations into the dispatch compaction carryover', () => {
    const running = startDelegatedTaskTrace({
      owner: 'mission-worker',
      instruction: 'Long-running background audit of the evidence pack.',
      background: true,
    });
    const finished = startDelegatedTaskTrace({ owner: 'mission-worker', instruction: 'done one' });
    completeDelegatedTaskTrace(finished, { resultSummary: 'ok' });

    const { task, allTasks } = makeTasks();
    const carryover = buildDispatchCarryover({
      task,
      allTasks,
      missionGoalLines: ['Deliver the governance evidence pack'],
    });
    expect(carryover.active_background_tasks).toHaveLength(1);
    expect(carryover.active_background_tasks?.[0]?.delegation_id).toBe(running.trace_id);
    expect(carryover.active_background_tasks?.[0]?.instruction_excerpt).toContain(
      'background audit'
    );
    // The rendered carryover block a post-compaction worker sees mentions the task.
    const block = renderCarryoverBlock(carryover);
    expect(block).toContain('active_background_tasks:');
    expect(block).toContain(running.trace_id);
  });

  it('omits the snapshot field when nothing is running', () => {
    const { task, allTasks } = makeTasks();
    const carryover = buildDispatchCarryover({
      task,
      allTasks,
      missionGoalLines: ['goal'],
    });
    expect(carryover.active_background_tasks).toBeUndefined();
  });

  it('claims at most 4 completion notifications into the dispatch prompt section', () => {
    for (let i = 1; i <= 5; i++) {
      enqueueDelegationNotification({
        delegationId: `DLG-W${i}`,
        owner: 'mission-worker',
        status: 'completed',
        instruction: `background task ${i}`,
        result: `result ${i}`,
      });
    }
    const first = buildDelegationNotificationLines();
    const firstText = first.join('\n');
    expect(firstText).toContain('Background delegation updates');
    for (const id of ['DLG-W1', 'DLG-W2', 'DLG-W3', 'DLG-W4']) {
      expect(firstText).toContain(id);
    }
    expect(firstText).not.toContain('DLG-W5');

    const second = buildDelegationNotificationLines();
    expect(second.join('\n')).toContain('DLG-W5');
    // Everything delivered — nothing re-injected on later dispatches.
    expect(buildDelegationNotificationLines()).toEqual([]);
  });
});
