import { afterEach, describe, expect, it } from 'vitest';

import { safeRmSync } from '../secure-io.js';
import type {
  AutonomousOpsGateInput,
  AutonomousOpsGateResult,
} from '../governance/autonomous-ops-gate.js';
import { resolveInterventionLevel } from '../governance/approval-decision-card.js';
import type {
  RouteAutonomousDecisionInput,
  RoutedDecision,
} from '../governance/approval-decision-routing.js';
import type { CreateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import type { DotCharter } from './dot-charter.js';
import {
  composeDotDigest,
  dispatchDotProposals,
  evaluateDotProposalGate,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import {
  DOT_DECISION_RELAXERS,
  DOT_DIGEST_SECTIONS,
  DOT_FLOOR_CONTRIBUTORS,
  DOT_PRE_GATE_CHECKS,
} from './dot-extension-registry.js';
import { recordDotFeedback } from './dot-feedback.js';
import type { DotProposal } from './dot-proposals.js';

const TEST_ROOT = 'active/shared/tmp/dot-dispatch-extension-tests';
const RANK = { auto: 0, notify: 1, approve: 2 } as const;

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'ext-dot',
  version: '1.0.0',
  title: 'Extension dot',
  purpose: 'Exercise dispatch hooks.',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'Stay governed.' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-ext-dot' },
};

const PROPOSAL: DotProposal = {
  action_id: 'dot_delegate_work',
  title: 'Rerun CI',
  objective: 'Re-run the flaky job.',
  work_shape: 'task_session',
};

function harness(base: AutonomousOpsGateResult['decision'] = 'auto') {
  const gateInputs: AutonomousOpsGateInput[] = [];
  const routed: RouteAutonomousDecisionInput[] = [];
  const items: CreateWorkItemInput[] = [];
  const deps: DotDispatchDeps = {
    rootDir: TEST_ROOT,
    now: () => new Date('2026-10-04T09:00:10Z'),
    gate: (input) => {
      gateInputs.push(input);
      const requested = input.requestedDecision;
      return {
        actionId: input.actionId,
        decision: requested && RANK[requested] > RANK[base] ? requested : base,
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
      } as AutonomousOpsGateResult;
    },
    route: (input): RoutedDecision => {
      routed.push(input);
      const level = resolveInterventionLevel(input.gate);
      return level === 'none' || level === 'fyi'
        ? { level, timing: 'digest', proceed: true, parked: false, shadow: false, notified: false }
        : {
            level,
            timing: 'immediate',
            proceed: false,
            parked: true,
            shadow: false,
            requestId: `req-${routed.length}`,
            notified: true,
          };
    },
    createWorkItem: (input) => {
      items.push(input);
      return { item_id: `witem-${items.length}` } as WorkItem;
    },
    countOpenWorkItems: () => 0,
    listCharters: () => [CHARTER],
    assertTenant: () => {},
    appendInbox: () => {},
    notify: () => true,
    audit: () => {},
    feedback: { onRejection: () => {} },
  };
  return { deps, gateInputs, routed, items };
}

function learnApproveFloor(): void {
  recordDotFeedback(
    {
      dot_id: CHARTER.dot_id,
      action_id: 'dot_delegate_work',
      action_ref: 'earlier',
      title: 't',
      outcome: 'rejected',
    },
    { rootDir: TEST_ROOT, now: () => new Date('2026-10-04T08:00:00Z'), onRejection: () => {} }
  );
}

afterEach(() => {
  DOT_FLOOR_CONTRIBUTORS.length = 0;
  DOT_DECISION_RELAXERS.length = 0;
  DOT_PRE_GATE_CHECKS.length = 0;
  DOT_DIGEST_SECTIONS.length = 0;
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dot-dispatch extension hooks', () => {
  it('merges floor contributors into the strictest floor; a throwing one is skipped', () => {
    DOT_FLOOR_CONTRIBUTORS.push(
      {
        id: 'boom',
        floor: () => {
          throw new Error('exploded');
        },
      },
      { id: 'budget-soft', floor: () => 'approve' }
    );
    const h = harness('auto');
    const { records } = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(h.gateInputs[0].requestedDecision).toBe('approve');
    expect(records[0].status).toBe('parked');
  });

  it('lets a relaxer lower only the learned floor, clamped to the charter default and policy gate', () => {
    learnApproveFloor();
    DOT_DECISION_RELAXERS.push({
      id: 'trusted',
      relax: () => ({ decision: 'auto', reason: 'trusted dot' }),
    });
    const h = harness('auto');
    // Charter default notify: relaxing to auto clamps at notify.
    const charter = { ...CHARTER, decisions: { default_decision: 'notify' as const } };
    const result = evaluateDotProposalGate(charter, PROPOSAL, h.deps);
    expect(result.floor).toBe('notify');
    expect(result.gate.decision).toBe('notify');
    expect(result.relaxed_by).toBe('trusted');

    // The policy gate's own decision is a floor too.
    const strictGate = harness('notify');
    expect(evaluateDotProposalGate(CHARTER, PROPOSAL, strictGate.deps).gate.decision).toBe(
      'notify'
    );
    // Without a learned floor there is nothing to relax.
    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    const plain = harness('auto');
    expect(
      evaluateDotProposalGate(
        { ...CHARTER, decisions: { default_decision: 'approve' } },
        PROPOSAL,
        plain.deps
      ).gate.decision
    ).toBe('approve');
  });

  it('refuses on a pre-gate check failure before the gate runs', () => {
    DOT_PRE_GATE_CHECKS.push({ id: 'arbitration', check: () => ({ ok: false, reason: 'owned' }) });
    const h = harness('auto');
    const { records } = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(records[0]).toMatchObject({ status: 'refused', reason: 'arbitration: owned' });
    expect(h.gateInputs).toHaveLength(0);
  });

  it('forces an operator decision with card context on escalate', () => {
    DOT_PRE_GATE_CHECKS.push({
      id: 'arbitration',
      check: () => ({
        ok: 'escalate',
        reason: 'conflicts with repo-guardian',
        card_context: 'Conflicts with dact-other (repo-guardian).',
        link: { action_ref: 'dact-other', dot_id: 'repo-guardian' },
      }),
    });
    const h = harness('auto');
    const { records } = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(h.gateInputs[0].requestedDecision).toBe('approve');
    expect(h.routed[0].question).toContain('Conflicts with dact-other (repo-guardian).');
    expect(records[0]).toMatchObject({
      status: 'parked',
      escalation: {
        check_id: 'arbitration',
        link: { action_ref: 'dact-other', dot_id: 'repo-guardian' },
      },
    });
  });

  it('appends registered digest sections', () => {
    DOT_DIGEST_SECTIONS.push(
      { id: 'kr', lines: () => ['KR: 2/3 on track'] },
      {
        id: 'boom',
        lines: () => {
          throw new Error('exploded');
        },
      }
    );
    const text = composeDotDigest(CHARTER, undefined, { rootDir: TEST_ROOT });
    expect(text.split('\n').at(-1)).toBe('KR: 2/3 on track');
  });
});
