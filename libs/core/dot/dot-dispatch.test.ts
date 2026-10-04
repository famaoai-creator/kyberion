import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type {
  AutonomousOpsGateInput,
  AutonomousOpsGateResult,
} from '../governance/autonomous-ops-gate.js';
import { resolveInterventionLevel } from '../governance/approval-decision-card.js';
import type {
  RouteAutonomousDecisionInput,
  RoutedDecision,
} from '../governance/approval-decision-routing.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { VETO_WINDOW_DECIDER } from '../governance/approval-veto-window.js';
import type { CreateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import type { DotCharter } from './dot-charter.js';
import {
  composeDotDigest,
  currentDotActions,
  dispatchDotProposals,
  dotBoundsPromptLines,
  dotNotificationRoute,
  maybeSendDotDigest,
  runDotHousekeeping,
  settleDotParkedActions,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import {
  learnedDotDecisionFloor,
  measureDotSuccessSignals,
  readDotFeedback,
  recordDotFeedback,
} from './dot-feedback.js';
import { appendDotInboxEntry } from './dot-inbox.js';
import { evaluateDotTriggersDue } from './dot-runtime.js';
import type { DotProposal } from './dot-proposals.js';

const TEST_ROOT = 'active/shared/tmp/dot-dispatch-tests';
const RANK = { auto: 0, notify: 1, approve: 2 } as const;

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'org-ops',
  version: '1.0.0',
  title: 'Org ops',
  purpose: 'Keep the organization loop moving.',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'acme-team' },
  goal: { statement: 'No overdue operations.' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] },
  authority: {
    authority_role: 'organization_operator',
    allowed_work_shapes: ['task_session', 'pipeline'],
    max_concurrent_delegations: 2,
  },
  notification: { deliver_to: { surface: 'slack', channel: 'C-EXEC' } },
  runtime: { heartbeat_id: 'dot-org-ops' },
};

const PROPOSAL: DotProposal = {
  action_id: 'dot_delegate_work',
  title: 'Tick overdue operations',
  objective: 'Run the overdue operation tick.',
  work_shape: 'task_session',
};

function gateResult(
  input: AutonomousOpsGateInput,
  base: AutonomousOpsGateResult['decision'],
  extra: Partial<AutonomousOpsGateResult> = {}
): AutonomousOpsGateResult {
  const requested = input.requestedDecision;
  const decision = requested && RANK[requested] > RANK[base] ? requested : base;
  return {
    actionId: input.actionId,
    decision,
    allowed: true,
    score: 0,
    maxScore: 6,
    policyVersion: 'test',
    executionMode: 'apply',
    reason: 'test gate',
    axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
    shadow: false,
    escalations: [],
    highRiskPathMatches: [],
    ...extra,
  };
}

interface Harness {
  deps: DotDispatchDeps;
  gateInputs: AutonomousOpsGateInput[];
  routed: RouteAutonomousDecisionInput[];
  items: CreateWorkItemInput[];
  notes: Array<{ event: string; title: string; route?: unknown }>;
  audits: Array<{ agentId: string; operation: string; result: string }>;
  inbox: unknown[];
  approvals: Map<string, ApprovalRequestRecord>;
}

function harness(
  base: AutonomousOpsGateResult['decision'] = 'auto',
  overrides: Partial<DotDispatchDeps> = {},
  gateExtra: Partial<AutonomousOpsGateResult> = {}
): Harness {
  const h: Harness = {
    gateInputs: [],
    routed: [],
    items: [],
    notes: [],
    audits: [],
    inbox: [],
    approvals: new Map(),
    deps: {},
  };
  let requestSeq = 0;
  h.deps = {
    rootDir: TEST_ROOT,
    now: () => new Date('2026-10-04T09:00:10Z'),
    gate: (input) => {
      h.gateInputs.push(input);
      return gateResult(input, base, gateExtra);
    },
    route: (input): RoutedDecision => {
      h.routed.push(input);
      const level = resolveInterventionLevel(input.gate);
      if (level === 'none' || level === 'fyi') {
        return {
          level,
          timing: 'digest',
          proceed: true,
          parked: false,
          shadow: false,
          notified: false,
        };
      }
      requestSeq += 1;
      return {
        level,
        timing: 'immediate',
        proceed: false,
        parked: true,
        shadow: false,
        requestId: `req-${requestSeq}`,
        notified: true,
      };
    },
    createWorkItem: (input) => {
      h.items.push(input);
      return { item_id: `witem-${h.items.length}` } as WorkItem;
    },
    countOpenWorkItems: () => 0,
    listCharters: () => [CHARTER],
    appendInbox: (input) => void h.inbox.push(input),
    notify: (event, payload, options) => {
      h.notes.push({ event, title: payload.title, route: options.route });
      return true;
    },
    audit: (entry) => void h.audits.push(entry),
    loadApproval: (id) => h.approvals.get(id) ?? null,
    feedback: { onRejection: () => {} },
    ...overrides,
  };
  return h;
}

function approval(
  status: ApprovalRequestRecord['status'],
  decidedBy = 'user:owner',
  decidedByType: ApprovalRequestRecord['decidedByType'] = 'human'
): ApprovalRequestRecord {
  return { status, decidedBy, decidedByType } as ApprovalRequestRecord;
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dispatchDotProposals — decision and delegation', () => {
  it('delegates an auto action as a WorkItem stamped with the dot actor id', () => {
    const h = harness('auto');
    const { records } = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(records[0].status).toBe('dispatched');
    expect(h.items[0].metadata).toMatchObject({
      dot_id: 'org-ops',
      actor_id: 'dot:org-ops',
      authority_role: 'organization_operator',
    });
    expect(h.items[0].context).toMatchObject({ tenant_slug: 'acme', organization_id: 'acme-team' });
    expect(h.routed[0].requestedBy).toBe('dot:org-ops');
    expect(h.audits.at(-1)).toMatchObject({ agentId: 'dot:org-ops', result: 'completed' });
    expect(h.notes).toHaveLength(0);
  });

  it('raises the gate to the charter default_decision floor', () => {
    const h = harness('auto');
    const charter = { ...CHARTER, decisions: { default_decision: 'notify' as const } };
    const { records } = dispatchDotProposals(charter, [PROPOSAL], h.deps);
    expect(h.gateInputs[0].requestedDecision).toBe('notify');
    // notify without a veto window = fyi: proceeds and tells the operator now.
    expect(records[0].status).toBe('dispatched');
    expect(h.notes[0]).toMatchObject({ event: 'deliverable_ready' });
    expect(h.notes[0].title).toMatch(/^\[dot:org-ops\] started:/);
  });

  it('parks a notify action when the charter declares a veto window', () => {
    const h = harness('auto');
    const charter = {
      ...CHARTER,
      decisions: { default_decision: 'notify' as const, veto_window_minutes: 60 },
    };
    const { records } = dispatchDotProposals(charter, [PROPOSAL], h.deps);
    expect(h.routed[0].gate.vetoWindowMinutes).toBe(60);
    expect(records[0]).toMatchObject({ status: 'parked', request_id: 'req-1' });
    expect(h.items).toHaveLength(0);
  });

  it('never lets a charter shorten the policy veto window', () => {
    const h = harness('notify', {}, { vetoWindowMinutes: 120 });
    const charter = { ...CHARTER, decisions: { veto_window_minutes: 0 } };
    dispatchDotProposals(charter, [PROPOSAL], h.deps);
    expect(h.routed[0].gate.vetoWindowMinutes).toBe(120);
  });

  it('routes notifications to the local inbox unless the charter opts into live delivery', () => {
    expect(dotNotificationRoute(CHARTER)).toEqual({ surface: 'inbox', target: 'dot:org-ops' });
    const live = {
      ...CHARTER,
      notification: { ...CHARTER.notification, delivery_mode: 'live' as const },
    };
    expect(dotNotificationRoute(live)).toEqual({ surface: 'slack', target: 'C-EXEC' });
    const h = harness('approve');
    dispatchDotProposals(live, [PROPOSAL], h.deps);
    expect(h.routed[0].notificationRoute).toEqual({ surface: 'slack', target: 'C-EXEC' });
  });

  it('does not re-dispatch the same proposal within the dedupe window', () => {
    const h = harness('auto');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    const second = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(second.records).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    expect(h.items).toHaveLength(1);
  });
});

describe('dispatchDotProposals — charter bounds', () => {
  it('refuses a work shape outside allowed_work_shapes before the gate runs', () => {
    const h = harness('auto');
    const { records } = dispatchDotProposals(
      CHARTER,
      [{ ...PROPOSAL, work_shape: 'mission' }],
      h.deps
    );
    expect(records[0].status).toBe('refused');
    expect(records[0].reason).toMatch(/allowed_work_shapes/);
    expect(h.gateInputs).toHaveLength(0);
    expect(h.audits[0]).toMatchObject({ result: 'denied' });
  });

  it('defaults to task_session/direct_reply when the charter declares no shapes', () => {
    const h = harness('auto');
    const charter = {
      ...CHARTER,
      authority: { authority_role: 'organization_operator' },
    };
    const { records } = dispatchDotProposals(
      charter,
      [{ ...PROPOSAL, work_shape: 'pipeline' }],
      h.deps
    );
    expect(records[0].status).toBe('refused');
  });

  it('counts open WorkItems and parked decisions against max_concurrent_delegations', () => {
    const h = harness('approve', { countOpenWorkItems: () => 1 });
    const first = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(first.records[0].status).toBe('parked');
    const second = dispatchDotProposals(CHARTER, [{ ...PROPOSAL, title: 'Another task' }], h.deps);
    expect(second.records[0].status).toBe('refused');
    expect(second.records[0].reason).toMatch(/max_concurrent_delegations 2/);
  });
});

describe('dot handoff (team coordination)', () => {
  const TARGET: DotCharter = {
    ...CHARTER,
    dot_id: 'repo-guardian',
    title: 'Repo guardian',
    attention: { triggers: [{ kind: 'cron', cron: '0 0 1 1 *', timezone: 'UTC' }] },
    team: { accepts_handoffs_from: ['org-ops'] },
    runtime: { heartbeat_id: 'dot-repo-guardian' },
  };

  it('refuses a handoff to a dot that does not accept it', () => {
    const h = harness('auto', {
      listCharters: () => [CHARTER, { ...TARGET, team: {} }],
    });
    const { records } = dispatchDotProposals(
      CHARTER,
      [{ ...PROPOSAL, action_id: 'dot_handoff', handoff_to: 'repo-guardian' }],
      h.deps
    );
    expect(records[0].status).toBe('refused');
    expect(records[0].reason).toMatch(/does not accept handoffs/);
  });

  it('hands work over and wakes the receiving dot through the inbox', () => {
    const h = harness('auto', {
      listCharters: () => [CHARTER, TARGET],
      appendInbox: (input) => void appendDotInboxEntry(input, { rootDir: TEST_ROOT }),
    });
    const { records } = dispatchDotProposals(
      CHARTER,
      [{ ...PROPOSAL, action_id: 'dot_handoff', handoff_to: 'repo-guardian' }],
      h.deps
    );
    expect(records[0]).toMatchObject({ status: 'dispatched', handoff_to: 'repo-guardian' });
    expect(h.items[0].metadata).toMatchObject({ handoff_to: 'repo-guardian' });
    // The target declares no wake channel, yet an accepted handoff wakes it.
    const due = evaluateDotTriggersDue(TARGET, { rootDir: TEST_ROOT });
    expect(due).toHaveLength(1);
    expect(due[0].key).toMatch(/^wake:/);
    // A dot that does not accept the sender is not woken by the same row.
    const stranger = { ...TARGET, team: { accepts_handoffs_from: ['someone-else'] } };
    expect(evaluateDotTriggersDue(stranger, { rootDir: TEST_ROOT })).toHaveLength(0);
  });
});

describe('dotBoundsPromptLines', () => {
  it('tells the dot its shapes, free slots, and handoff partners', () => {
    const partner = {
      ...CHARTER,
      dot_id: 'repo-guardian',
      team: { accepts_handoffs_from: ['org-ops'] },
    };
    const lines = dotBoundsPromptLines(
      {
        ...CHARTER,
        authority: {
          ...CHARTER.authority,
          allowed_work_shapes: ['task_session'],
          max_concurrent_delegations: 2,
        },
      },
      { rootDir: TEST_ROOT, countOpenWorkItems: () => 1, listCharters: () => [CHARTER, partner] }
    );
    expect(lines.join('\n')).toContain('Allowed work_shape values: task_session.');
    expect(lines.join('\n')).toContain('Delegation slots free: 1 of 2');
    expect(lines.join('\n')).toContain('accept your handoffs (handoff_to): repo-guardian');
  });

  it('asks for no new proposals when every slot is taken', () => {
    const lines = dotBoundsPromptLines(CHARTER, {
      rootDir: TEST_ROOT,
      countOpenWorkItems: () => 99,
      listCharters: () => [CHARTER],
    });
    expect(lines.join('\n')).toMatch(/slots free: 0 of .*Propose nothing new/s);
    expect(lines.join('\n')).toContain('do not use handoff_to');
  });
});

describe('dispatchDotProposals — action scope and dedupe', () => {
  it('refuses a proposal that names a non-dot policy action', () => {
    const h = harness('auto');
    const { records } = dispatchDotProposals(
      CHARTER,
      [{ ...PROPOSAL, action_id: 'some_low_risk_policy_action' }],
      h.deps
    );
    expect(records[0]).toMatchObject({ status: 'refused' });
    expect(records[0].reason).toMatch(/not a dot action/);
    expect(h.gateInputs).toHaveLength(0);
  });

  it('does not re-ask a declined proposal inside the dedupe window', () => {
    const h = harness('approve');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    h.approvals.set('req-1', approval('rejected'));
    settleDotParkedActions(CHARTER, h.deps);
    const again = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(again.records).toHaveLength(0);
    expect(again.duplicates).toHaveLength(1);
    expect(h.routed).toHaveLength(1);
  });
});

describe('settleDotParkedActions + learning', () => {
  it('executes an approved action and records approval feedback', () => {
    const h = harness('approve');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    h.approvals.set('req-1', approval('approved'));
    const settled = settleDotParkedActions(CHARTER, h.deps);
    expect(settled[0]).toMatchObject({ status: 'dispatched', work_item_id: 'witem-1' });
    expect(h.items[0].metadata).toMatchObject({ approval_request_id: 'req-1' });
    expect(readDotFeedback('org-ops', h.deps)[0]).toMatchObject({ outcome: 'approved' });
    // Settled once: nothing left to settle.
    expect(settleDotParkedActions(CHARTER, h.deps)).toHaveLength(0);
  });

  it('declines a rejected action and raises that action to approve next time', () => {
    const rejected: unknown[] = [];
    const h = harness('approve', { feedback: { onRejection: (entry) => rejected.push(entry) } });
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    h.approvals.set('req-1', approval('rejected'));
    const settled = settleDotParkedActions(CHARTER, h.deps);
    expect(settled[0].status).toBe('declined');
    expect(rejected).toHaveLength(1);
    expect(learnedDotDecisionFloor('org-ops', h.deps)).toBe('approve');

    // The gate alone would auto-run it; the learned floor parks it instead.
    const next = harness('auto');
    const { records } = dispatchDotProposals(
      CHARTER,
      [{ ...PROPOSAL, title: 'Tick overdue operations again' }],
      next.deps
    );
    expect(next.gateInputs[0].requestedDecision).toBe('approve');
    expect(records[0].status).toBe('parked');
  });

  it('applies the learned floor to handoffs too (dot-wide)', () => {
    const h = harness('approve');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    h.approvals.set('req-1', approval('rejected'));
    settleDotParkedActions(CHARTER, h.deps);
    const next = harness('auto', {
      listCharters: () => [
        CHARTER,
        { ...CHARTER, dot_id: 'repo-guardian', team: { accepts_handoffs_from: ['org-ops'] } },
      ],
    });
    dispatchDotProposals(
      CHARTER,
      [{ ...PROPOSAL, action_id: 'dot_handoff', handoff_to: 'repo-guardian' }],
      next.deps
    );
    expect(next.gateInputs[0].requestedDecision).toBe('approve');
  });

  it('lifts a learned floor only after enough human approvals', () => {
    const deps = { rootDir: TEST_ROOT, now: () => new Date('2026-10-04T09:00:00Z') };
    const row = { dot_id: 'org-ops', action_id: 'dot_delegate_work', action_ref: 'a', title: 't' };
    const human = { decided_by: 'user:owner', decided_by_type: 'human' as const };
    recordDotFeedback({ ...row, outcome: 'rejected' }, { ...deps, onRejection: () => {} });
    recordDotFeedback({ ...row, outcome: 'approved', ...human }, deps);
    recordDotFeedback({ ...row, outcome: 'approved', decided_by: VETO_WINDOW_DECIDER }, deps);
    recordDotFeedback(
      { ...row, outcome: 'approved', decided_by: 'agent:x', decided_by_type: 'ai_agent' },
      deps
    );
    recordDotFeedback(
      { ...row, outcome: 'approved', decided_by: 'svc:y', decided_by_type: 'service' },
      deps
    );
    recordDotFeedback({ ...row, outcome: 'approved', ...human }, deps);
    expect(learnedDotDecisionFloor('org-ops', deps)).toBe('approve');
    recordDotFeedback({ ...row, outcome: 'approved', ...human }, deps);
    expect(learnedDotDecisionFloor('org-ops', deps)).toBeUndefined();
  });

  it('treats a vanished approval request as cancelled', () => {
    const h = harness('approve');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    const settled = settleDotParkedActions(CHARTER, h.deps);
    expect(settled[0]).toMatchObject({ status: 'declined', reason: 'approval request missing' });
  });

  it('expires a decision that waited past the charter limit and frees the slot', () => {
    const h = harness('approve');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    h.approvals.set('req-1', { ...approval('pending'), id: 'req-1', channel: 'operator' });
    const expired: string[] = [];
    const later = {
      ...h.deps,
      now: () => new Date('2026-10-05T09:00:10Z'),
      expireApproval: (record: ApprovalRequestRecord) => {
        expired.push(record.id);
        return { ...record, status: 'expired' as const };
      },
    };
    // Still inside the 24h default: nothing happens.
    expect(
      settleDotParkedActions(CHARTER, { ...later, now: () => new Date('2026-10-05T08:59:00Z') })
    ).toHaveLength(0);
    const settled = settleDotParkedActions(CHARTER, later);
    expect(expired).toEqual(['req-1']);
    expect(settled[0]).toMatchObject({ status: 'declined', reason: 'approval expired' });
    expect(readDotFeedback('org-ops', later)[0]).toMatchObject({ outcome: 'expired' });
    // Expiry is not a rejection: no learned floor.
    expect(learnedDotDecisionFloor('org-ops', later)).toBeUndefined();
    expect(
      currentDotActions('org-ops', later).filter((row) => row.status === 'parked')
    ).toHaveLength(0);
  });

  it('never lets the charter expiry pre-empt a live veto window', () => {
    const h = harness('approve');
    const short: DotCharter = {
      ...CHARTER,
      decisions: { ...CHARTER.decisions, decision_expiry_minutes: 10 },
    };
    dispatchDotProposals(short, [PROPOSAL], h.deps);
    const live = {
      ...approval('pending'),
      id: 'req-1',
      channel: 'operator',
      veto: { windowMinutes: 60, proceedsAt: '2026-10-06T09:00:00Z' },
    } as ApprovalRequestRecord;
    h.approvals.set('req-1', live);
    const expireApproval = (record: ApprovalRequestRecord) => ({
      ...record,
      status: 'expired' as const,
    });
    const later = { ...h.deps, now: () => new Date('2026-10-05T09:00:00Z'), expireApproval };
    expect(settleDotParkedActions(short, later)).toHaveLength(0);
    // Once the card fell back to a human decision, the charter expiry applies.
    h.approvals.set('req-1', { ...live, veto: { ...live.veto!, fallback: 'undelivered' } });
    expect(settleDotParkedActions(short, later)[0]).toMatchObject({ status: 'declined' });
  });

  it('honors a shorter charter decision_expiry_minutes and the request expiry', () => {
    const h = harness('approve');
    const short: DotCharter = {
      ...CHARTER,
      decisions: { ...CHARTER.decisions, decision_expiry_minutes: 30 },
    };
    dispatchDotProposals(short, [PROPOSAL], h.deps);
    h.approvals.set('req-1', { ...approval('pending'), id: 'req-1', channel: 'operator' });
    const expireApproval = (record: ApprovalRequestRecord) => ({
      ...record,
      status: 'expired' as const,
    });
    const in31 = { ...h.deps, now: () => new Date('2026-10-04T09:31:10Z'), expireApproval };
    expect(settleDotParkedActions(short, in31)[0]).toMatchObject({ status: 'declined' });

    const h2 = harness('approve');
    dispatchDotProposals(CHARTER, [{ ...PROPOSAL, title: 'A different proposal' }], h2.deps);
    h2.approvals.set('req-1', {
      ...approval('pending'),
      id: 'req-1',
      channel: 'operator',
      expiresAt: '2026-10-04T09:05:00Z',
    });
    const in10 = { ...h2.deps, now: () => new Date('2026-10-04T09:10:00Z'), expireApproval };
    expect(settleDotParkedActions(CHARTER, in10)[0]).toMatchObject({ status: 'declined' });
  });

  it('keeps an action parked when the approval store is transiently unreadable', () => {
    const h = harness('approve');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    const failing = {
      ...h.deps,
      loadApproval: () => {
        throw new Error('EBUSY');
      },
    };
    expect(settleDotParkedActions(CHARTER, failing)).toHaveLength(0);
    expect(readDotFeedback('org-ops', h.deps)).toHaveLength(0);
    expect(currentDotActions('org-ops', h.deps)[0].status).toBe('parked');
  });

  it('declines an approved action whose shape left the charter while it waited', () => {
    const h = harness('approve');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    h.approvals.set('req-1', approval('approved'));
    const narrowed: DotCharter = {
      ...CHARTER,
      authority: { ...CHARTER.authority, allowed_work_shapes: ['direct_reply'] },
    };
    const settled = settleDotParkedActions(narrowed, h.deps);
    expect(settled[0]).toMatchObject({ status: 'declined' });
    expect(settled[0].reason).toMatch(/no longer in scope/);
    expect(h.items).toHaveLength(0);
  });

  it('reuses the WorkItem and records feedback once when a settlement is retried', () => {
    const h = harness('approve');
    dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    h.approvals.set('req-1', approval('approved'));
    const parkedRef = currentDotActions('org-ops', h.deps)[0].action_ref;
    // A previous sweep wrote feedback and created the WorkItem, then died
    // before the ledger row advanced past `parked`.
    recordDotFeedback(
      {
        dot_id: 'org-ops',
        action_id: 'dot_delegate_work',
        action_ref: parkedRef,
        outcome: 'approved',
        title: PROPOSAL.title,
        decided_by: 'user:owner',
        decided_by_type: 'human',
      },
      { rootDir: TEST_ROOT, now: h.deps.now }
    );
    const existing = { item_id: 'witem-existing' } as WorkItem;
    const retried = settleDotParkedActions(CHARTER, {
      ...h.deps,
      findWorkItemByActionRef: (ref) => (ref === parkedRef ? existing : undefined),
    });
    expect(retried[0]).toMatchObject({ status: 'dispatched', work_item_id: 'witem-existing' });
    expect(h.items).toHaveLength(0);
    expect(readDotFeedback('org-ops', h.deps)).toHaveLength(1);
  });
});

describe('digest and success signals', () => {
  const DIGEST_CHARTER: DotCharter = {
    ...CHARTER,
    goal: {
      statement: 'No overdue operations.',
      signal_probes: [
        {
          signal: 'state file exists',
          probe: { type: 'file', path: 'state.json', expect: 'exists' },
        },
      ],
    },
    notification: { ...CHARTER.notification, digest_cron: '0 9 * * *' },
  };

  it('measures signals with throttling and reports them in the digest', async () => {
    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(`${TEST_ROOT}/state.json`, '{}\n');
    const now = new Date('2026-10-04T09:00:10Z');
    const first = await measureDotSuccessSignals(DIGEST_CHARTER, {
      rootDir: TEST_ROOT,
      now: () => now,
    });
    expect(first).toEqual([expect.objectContaining({ healthy: true })]);
    const again = await measureDotSuccessSignals(DIGEST_CHARTER, {
      rootDir: TEST_ROOT,
      now: () => now,
    });
    expect(again).toHaveLength(0);
    const text = composeDotDigest(DIGEST_CHARTER, undefined, { rootDir: TEST_ROOT });
    expect(text).toContain('OK state file exists');
  });

  it('sends the digest once per cron minute', () => {
    const h = harness('auto');
    dispatchDotProposals(DIGEST_CHARTER, [PROPOSAL], h.deps);
    expect(maybeSendDotDigest(DIGEST_CHARTER, h.deps)).toBe(true);
    expect(h.notes.at(-1)).toMatchObject({ event: 'decision_digest' });
    expect(maybeSendDotDigest(DIGEST_CHARTER, h.deps)).toBe(false);
    const offMinute = { ...h.deps, now: () => new Date('2026-10-04T09:01:00Z') };
    expect(maybeSendDotDigest(DIGEST_CHARTER, offMinute)).toBe(false);
  });

  it('housekeeping settles, measures, and digests in one isolated pass', async () => {
    const h = harness('approve');
    dispatchDotProposals(DIGEST_CHARTER, [PROPOSAL], h.deps);
    h.approvals.set('req-1', approval('approved'));
    const result = await runDotHousekeeping(DIGEST_CHARTER, h.deps);
    expect(result.settled).toHaveLength(1);
    expect(result.signals).toBe(1);
    expect(result.digest).toBe(true);
    expect(result.errors).toEqual([]);
    expect(currentDotActions('org-ops', h.deps)[0].status).toBe('dispatched');
  });
});
