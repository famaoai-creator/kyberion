import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { DotActionRecord } from '@agent/core/dot/dot-dispatch';
import type { DotWorkResultRow } from '@agent/core/dot/dot-state-paths';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import type { WorkItem } from '@agent/core/workforce/work-coordination';
import type { FrontDeskConversationWork } from '@agent/core/surface/front-desk-conversation-store';
import type { FrontDeskExecutionMapping } from '@agent/core/surface/front-desk-execution-contract';

const state = vi.hoisted(() => ({
  work: { sessionId: 'session', tasks: [] } as FrontDeskConversationWork,
  entries: [] as ReturnType<
    typeof import('@agent/core/surface/front-desk-conversation-store').listConfiguredFrontDeskExecutions
  >,
  actions: [] as DotActionRecord[],
  results: [] as DotWorkResultRow[],
  approval: undefined as ApprovalRequestRecord | undefined,
  item: undefined as WorkItem | undefined,
  unavailable: false,
}));
vi.mock('@agent/core/dot/dot-dispatch', () => ({ currentDotActions: () => state.actions }));
vi.mock('@agent/core/dot/dot-executor', () => ({ readDotWorkResults: () => state.results }));
vi.mock('@agent/core/governance/approval-store', () => ({
  loadApprovalRequest: () => state.approval,
  isApprovalRequestExpired: (record: ApprovalRequestRecord, now: number) =>
    Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now),
}));
vi.mock('@agent/core/workforce/work-coordination', () => ({ getWorkItem: () => state.item }));
vi.mock('@agent/core/surface/front-desk-execution', () => ({
  frontDeskBindingsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
}));
vi.mock('@agent/core/surface/front-desk-conversation-store', () => ({
  readFrontDeskConversationWork: () => {
    if (state.unavailable) throw Error('PRIVATE_ERROR /private/receipt.json');
    return state.work;
  },
  listConfiguredFrontDeskExecutions: (filter: (mapping: FrontDeskExecutionMapping) => boolean) =>
    state.entries.filter((entry) => filter(entry.mapping)),
}));
import {
  readFirstJobTickStatus,
  summarizeFirstJobTick,
  FIRST_JOB_TICK_OUTCOMES,
} from './onboarding_first_job_tick_status.js';

const charter = {
  dot_id: 'first-job-fixture',
  scope: { tenant_slug: 'fixture', tier: 'public' },
} as DotCharter;
const mapping = {
  id: 'first-job-fixture',
  dotId: charter.dot_id,
  viewer: { principalId: 'human:fixture' },
} as FrontDeskExecutionMapping;
const binding = {
  mapping_id: mapping.id,
  conversation_key: 'key',
  config_digest: 'config',
  request_digest: 'request',
  request_id: 'request-1',
  revision: 1,
  work_item_id: 'item-1',
};
const read = (rows: DotWorkResultRow[] = []) =>
  readFirstJobTickStatus(charter, mapping, 'config', rows);
function itemResult(
  status: DotWorkResultRow['status'],
  mode: DotWorkResultRow['mode'] = 'pipeline'
) {
  state.item = {
    item_id: 'item-1',
    title: 'Synthetic diagnostic item',
    description: 'Synthetic fixture only',
    priority: 'normal',
    source: 'local',
    source_ref: 'fixture',
    project_id: 'default',
    labels: [],
    dependencies: [],
    version: 1,
    created_at: '2026-10-06T00:00:00Z',
    updated_at: '2026-10-06T00:00:00Z',
    status: 'archived',
    current_attempt_id: 'attempt',
    metadata: { action_ref: 'action', dot_id: charter.dot_id, front_desk_execution: binding },
  };
  state.work.tasks[0].workItemId = 'item-1';
  state.results = [
    {
      dot_id: charter.dot_id,
      work_item_id: 'item-1',
      action_ref: 'action',
      attempt_id: 'attempt',
      status,
      mode,
      summary: 'PRIVATE_RESULT /private/path',
      started_at: '',
      completed_at: '',
    },
  ];
}
beforeEach(() => {
  state.unavailable = false;
  state.item = undefined;
  state.results = [];
  state.work = {
    sessionId: 'session',
    tasks: [
      {
        id: binding.request_id,
        title: 'PRIVATE_REQUEST',
        sourceStatus: 'needs_execution',
        createdAt: 1,
        lastRecordedAt: 1,
        turnState: 'settled',
        executionStatus: 'awaiting_approval',
        artifact: {
          requestId: binding.request_id,
          revision: 1,
          format: 'readable',
          verification: 'pending',
          currentness: 'requested_pending',
        },
      },
    ],
  };
  state.entries = [
    {
      mapping,
      binding,
      request: {
        status: 'pending',
        sessionId: 'session',
        revision: 1,
        requestDigest: 'request',
        createdAt: 1,
      },
    },
  ];
  state.actions = [
    {
      action_ref: 'action',
      status: 'parked',
      request_id: 'approval',
      front_desk_execution: binding,
    },
  ] as DotActionRecord[];
  state.approval = {
    status: 'pending',
    requestedBy: 'dot:' + charter.dot_id,
    scope: { tenant_slug: 'fixture', viewer_principal: 'human:fixture', tier: 'public' },
  } as ApprovalRequestRecord;
});

describe('bounded first-job tick readback', () => {
  it('counts a genuinely pending bound approval and identifies the user as next', () => {
    expect(read()).toMatchObject({
      outcome: 'awaiting_approval',
      next_actor: 'user',
      next_action: 'review_approval',
    });
  });
  it.each(['approved', 'applied'] as const)(
    'reports a %s decision still held rather than asking again',
    (status) => {
      state.approval!.status = status;
      expect(read().outcome).toBe('held');
    }
  );
  it('does not invent an approval for an absent action or card', () => {
    state.actions = [];
    state.approval = undefined;
    expect(read().outcome).toBe('held');
  });
  it.each(['refused', 'declined', 'shadow'] as const)(
    'reports %s without copying its reason',
    (status) => {
      state.actions[0].status = status;
      state.actions[0].reason = 'PRIVATE_REASON /secret';
      expect(read().outcome).toBe('refused');
      expect(JSON.stringify(read())).not.toContain('PRIVATE');
    }
  );
  it.each(['rejected', 'cancelled'] as const)('reports the %s decision', (status) => {
    state.approval!.status = status;
    expect(read().outcome).toBe('refused');
  });
  it('reports expired status and live-clock expiry', () => {
    state.approval!.status = 'expired';
    expect(read().outcome).toBe('expired');
    state.approval!.status = 'approved';
    state.approval!.expiresAt = '2000-01-01T00:00:00Z';
    expect(read().outcome).toBe('expired');
  });
  it('rejects a foreign approval scope and a different bound action', () => {
    state.approval!.scope!.tenant_slug = 'neighbor';
    expect(read().outcome).toBe('uncertain');
    state.actions[0].front_desk_execution = { ...binding, request_id: 'neighbor' };
    expect(read().outcome).toBe('held');
  });
  it.each([
    { organization_id: 'other-org' },
    { project_id: 'other-project' },
    { tier: 'confidential' as const },
    { tier: undefined },
  ])('does not call a mismatched approval scope ready for review: %j', (mismatch) => {
    state.approval!.scope = { ...state.approval!.scope, ...mismatch };
    expect(read().outcome).toBe('uncertain');
  });
  it('reports invalidated requests and changed admitted configuration', () => {
    state.entries[0].request.status = 'invalidated';
    expect(read().outcome).toBe('configuration_changed');
    state.entries[0].request.status = 'pending';
    state.entries[0].binding = { ...binding, config_digest: 'changed' };
    expect(read().outcome).toBe('configuration_changed');
  });
  it('does not read a neighboring mapping as this request', () => {
    state.entries[0].mapping = { ...mapping, id: 'neighbor' };
    expect(read().outcome).toBe('uncertain');
  });
  it('never upgrades executor success without readback verification', () => {
    itemResult('done');
    expect(read().outcome).toBe('uncertain');
    state.work.tasks[0].executionStatus = 'work_completed';
    state.work.tasks[0].artifact!.verification = 'unknown';
    expect(read().outcome).toBe('uncertain');
    state.work.tasks[0].artifact!.verification = 'verified';
    expect(read()).toMatchObject({ outcome: 'artifact_verified', next_action: 'view_artifact' });
  });
  it.each([
    ['failed', 'pre_effect_failure', 'failed'],
    ['failed', undefined, 'uncertain'],
    ['blocked', undefined, 'uncertain'],
  ] as const)(
    'foregrounds fresh %s evidence over a still-verified artifact',
    (status, reason_code, expected) => {
      itemResult('done');
      state.work.tasks[0].executionStatus = 'work_completed';
      state.work.tasks[0].artifact!.verification = 'verified';
      const fresh = { ...state.results[0], status, reason_code };
      expect(read([fresh]).outcome).toBe(expected);
      expect(read([{ ...fresh, work_item_id: 'unmatched' }]).outcome).toBe('uncertain');
    }
  );
  it.each([
    { action_ref: 'foreign-action' },
    { attempt_id: 'stale-attempt' },
    { dot_id: 'foreign-dot' },
  ])('refuses a current-pass success with a mismatched binding: %j', (mismatch) => {
    itemResult('done');
    state.work.tasks[0].executionStatus = 'work_completed';
    state.work.tasks[0].artifact!.verification = 'verified';
    expect(read([{ ...state.results[0], ...mismatch }]).outcome).toBe('uncertain');
  });
  it('keeps uncertain pipeline effects quarantined and pre-effect failure distinct', () => {
    itemResult('blocked');
    expect(read().outcome).toBe('uncertain');
    itemResult('failed');
    expect(read().outcome).toBe('uncertain');
    state.results[0].reason_code = 'pre_effect_failure';
    expect(read().outcome).toBe('failed');
  });
  it('reports an existing claim as held without claiming or releasing it', () => {
    itemResult('skipped');
    state.item!.status = 'in_progress';
    state.work.tasks[0].executionStatus = 'running';
    expect(read()).toMatchObject({
      outcome: 'held',
      next_actor: 'operator',
      next_action: 'inspect_execution',
    });
  });
  it('reports expired authority on unstarted work while retaining an existing claim as held', () => {
    itemResult('blocked', 'escalated');
    state.approval!.status = 'expired';
    expect(read().outcome).toBe('expired');
    state.item!.status = 'in_progress';
    expect(read().outcome).toBe('held');
  });
  it('an older verified artifact cannot hide a new approval or unknown revision', () => {
    const old = structuredClone(state.work.tasks[0]);
    old.id = 'old';
    old.executionStatus = 'work_completed';
    old.artifact!.verification = 'verified';
    state.work.tasks.unshift(old);
    state.entries.unshift({ ...state.entries[0], binding: { ...binding, request_id: 'old' } });
    expect(read()).toMatchObject({
      outcome: 'awaiting_approval',
      outcomes: { artifact_verified: 1, awaiting_approval: 1 },
    });
    state.work.tasks[1].executionStatus = 'uncertain';
    expect(read().outcome).toBe('uncertain');
  });
  it.each(['rejected', 'expired'] as const)(
    'a newer verified request supersedes historical %s in the headline',
    (status) => {
      state.approval!.status = status;
      const recent = structuredClone(state.work.tasks[0]);
      recent.id = 'recent';
      recent.createdAt = 2;
      recent.executionStatus = 'work_completed';
      recent.artifact!.verification = 'verified';
      state.work.tasks.push(recent);
      state.entries.push({ ...state.entries[0], binding: { ...binding, request_id: 'recent' } });
      expect(read()).toMatchObject({
        outcome: 'artifact_verified',
        outcomes: { artifact_verified: 1, [status === 'expired' ? 'expired' : 'refused']: 1 },
      });
    }
  );
  it('handles empty and verified-terminal history as noop', () => {
    state.work.tasks[0].executionStatus = 'terminated_unstarted';
    expect(read().outcome).toBe('noop');
    state.work.tasks = [];
    expect(read().outcome).toBe('noop');
  });
  it('reports read errors without disclosing them', () => {
    state.unavailable = true;
    expect(read().outcome).toBe('uncertain');
    expect(JSON.stringify(read())).not.toMatch(/PRIVATE|private|receipt.json/);
  });
  it('prioritizes pass failures and uncertainty over completed work and requires no raw detail', () => {
    expect(summarizeFirstJobTick(['artifact_verified', 'failed']).outcome).toBe('failed');
    expect(summarizeFirstJobTick(['failed', 'uncertain']).outcome).toBe('uncertain');
    for (const outcome of FIRST_JOB_TICK_OUTCOMES) {
      expect(summarizeFirstJobTick([outcome])).toMatchObject({
        outcome,
        outcomes: { [outcome]: 1 },
      });
    }
  });
});
