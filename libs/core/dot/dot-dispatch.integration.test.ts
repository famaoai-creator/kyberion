import { afterEach, describe, expect, it, vi } from 'vitest';

const notifications = vi.hoisted(() => ({ notifyOperatorSync: vi.fn(() => true) }));
vi.mock('../surface/operator-notifications.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../surface/operator-notifications.js')>();
  return {
    ...actual,
    loadNotificationPreferences: () => ({}),
    notifyOperatorSync: notifications.notifyOperatorSync,
  };
});

import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import {
  approvalStoreRoots,
  decideApprovalRequest,
  loadApprovalRequest,
} from '../governance/approval-store.js';
import type { CreateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import type { DotCharter } from './dot-charter.js';
import {
  dispatchDotProposals,
  settleDotParkedActions,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import { learnedDotDecisionFloor } from './dot-feedback.js';

const TEST_ROOT = 'active/shared/tmp/dot-dispatch-integration-tests';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'org-ops',
  version: '1.0.0',
  title: 'Org ops',
  purpose: 'Keep the organization loop moving.',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'No overdue operations.' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] },
  authority: { authority_role: 'organization_operator' },
  decisions: { default_decision: 'notify', veto_window_minutes: 60 },
  notification: { deliver_to: { surface: 'slack', channel: 'C-EXEC' } },
  runtime: { heartbeat_id: 'dot-org-ops' },
};

function deps(items: CreateWorkItemInput[]): DotDispatchDeps {
  return {
    rootDir: TEST_ROOT,
    createWorkItem: (input) => {
      items.push(input);
      return { item_id: `witem-${items.length}` } as WorkItem;
    },
    countOpenWorkItems: () => 0,
    listCharters: () => [CHARTER],
    audit: () => {},
    feedback: { onRejection: () => {} },
  };
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
  notifications.notifyOperatorSync.mockClear();
  withExecutionContext('infrastructure_sentinel', () => {
    for (const root of Object.values(approvalStoreRoots())) {
      const dir = pathResolver.rootResolve(`${root}/${AUTONOMY_APPROVAL_CHANNEL}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dot dispatch through the real gate and approval store', () => {
  it('parks a dot proposal as a veto card on the charter route, then learns from the rejection', () => {
    const items: CreateWorkItemInput[] = [];
    const { records } = dispatchDotProposals(
      CHARTER,
      [
        {
          action_id: 'dot_delegate_work',
          title: 'Tick overdue operations',
          objective: 'Run the overdue operation tick.',
          work_shape: 'task_session',
        },
      ],
      deps(items)
    );
    // dot_delegate_work scores notify; the charter veto window makes it a veto card.
    expect(records[0]).toMatchObject({ status: 'parked', decision: 'notify' });
    const request = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, records[0].request_id!);
    expect(request).toMatchObject({ status: 'pending', requestedBy: 'dot:org-ops' });
    expect(request?.veto?.windowMinutes).toBe(60);
    // Default delivery_mode keeps the card in the local inbox.
    expect(request?.decisionCard?.deliveredVia).toEqual({
      surface: 'inbox',
      target: 'dot:org-ops',
    });
    expect(items).toHaveLength(0);

    decideApprovalRequest('infrastructure_sentinel', {
      channel: request!.channel,
      storageChannel: AUTONOMY_APPROVAL_CHANNEL,
      requestId: request!.id,
      decision: 'rejected',
      decidedBy: 'user:owner',
      decidedByType: 'human',
      authenticated: true,
    });
    const settled = settleDotParkedActions(CHARTER, deps(items));
    expect(settled[0].status).toBe('declined');
    expect(items).toHaveLength(0);
    expect(learnedDotDecisionFloor('org-ops', { rootDir: TEST_ROOT })).toBe('approve');
  });

  it('forces approve when a proposal touches a high-risk path', () => {
    const items: CreateWorkItemInput[] = [];
    const { records } = dispatchDotProposals(
      { ...CHARTER, decisions: undefined },
      [
        {
          action_id: 'dot_delegate_work',
          title: 'Edit the governance policy',
          objective: 'Loosen a threshold.',
          work_shape: 'task_session',
          changed_paths: ['knowledge/product/governance/autonomous-ops-policy.json'],
        },
      ],
      deps(items)
    );
    expect(records[0]).toMatchObject({ status: 'parked', decision: 'approve' });
    const request = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, records[0].request_id!);
    expect(request?.accountability?.finalDecision).toBe('human_only');
  });

  it('parks a notify action as a veto card even when the charter sets no veto window', () => {
    const items: CreateWorkItemInput[] = [];
    const { records } = dispatchDotProposals(
      { ...CHARTER, decisions: undefined },
      [
        {
          action_id: 'dot_delegate_work',
          title: 'Tick overdue operations',
          objective: 'Run the overdue operation tick.',
          work_shape: 'task_session',
        },
      ],
      deps(items)
    );
    expect(records[0]).toMatchObject({ status: 'parked', decision: 'notify' });
    const request = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, records[0].request_id!);
    expect(request?.veto?.windowMinutes).toBe(60);
    expect(items).toHaveLength(0);
  });
});
