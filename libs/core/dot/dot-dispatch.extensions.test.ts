import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

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
  DOT_DISPOSITION_OVERRIDES,
  DOT_FLOOR_CONTRIBUTORS,
  DOT_PRE_GATE_CHECKS,
} from './dot-extension-registry.js';
import { DOT_L4_NOTIFY_TO_AUTO_EXCEPTION } from './dot-extensions.js';
import { recordDotFeedback } from './dot-feedback.js';
import type { DotProposal } from './dot-proposals.js';

const TEST_ROOT = `active/shared/tmp/dot-dispatch-extension-tests-${randomUUID()}`;
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
  work_shape: 'direct_reply',
};

function harness(
  base: AutonomousOpsGateResult['decision'] = 'auto',
  extra: Partial<AutonomousOpsGateResult> = {}
) {
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
        ...extra,
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
  DOT_DISPOSITION_OVERRIDES.length = 0;
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

  it('lets only the named L4 exception go below the policy gate, re-verified by dispatch', () => {
    const claim = {
      id: 'autonomy',
      relax: () => ({
        decision: 'auto' as const,
        reason: 'L4 eligible',
        exception: DOT_L4_NOTIFY_TO_AUTO_EXCEPTION,
      }),
    };
    DOT_DECISION_RELAXERS.push(claim);
    const relaxable = { relaxableActions: ['dot_delegate_work'] };
    const notify = harness('notify', { vetoWindowMinutes: 60 });
    const result = evaluateDotProposalGate(CHARTER, PROPOSAL, { ...notify.deps, ...relaxable });
    expect(result.gate).toMatchObject({ decision: 'auto', allowed: true });
    expect(result.gate.vetoWindowMinutes).toBeUndefined();
    expect(result).toMatchObject({ floor: 'auto', relaxed_by: 'autonomy' });

    // Proceeds without a card: a WorkItem, no veto park.
    const run = harness('notify', { vetoWindowMinutes: 60 });
    const { records } = dispatchDotProposals(CHARTER, [PROPOSAL], { ...run.deps, ...relaxable });
    expect(records[0].status).toBe('dispatched');
    expect(run.items).toHaveLength(1);

    const decisionOf = (
      deps: DotDispatchDeps,
      charter: DotCharter = CHARTER,
      proposal: DotProposal = PROPOSAL
    ) => evaluateDotProposalGate(charter, proposal, deps).gate.decision;
    // Not a relaxable action.
    expect(decisionOf({ ...harness('notify').deps, relaxableActions: [] })).toBe('notify');
    // Never below approve, a charter floor, or a hard escalation.
    expect(decisionOf({ ...harness('approve').deps, ...relaxable })).toBe('approve');
    expect(
      decisionOf(
        { ...harness('notify').deps, ...relaxable },
        {
          ...CHARTER,
          decisions: { default_decision: 'notify' },
        }
      )
    ).toBe('notify');
    for (const extra of [
      { escalations: ['never_auto'] },
      { escalations: ['budget'] },
      { highRiskPathMatches: ['libs/core/**'] },
      { axes: { scope: 0, reversibility: 2, sensitivity: 0, confidence: 0 } },
      { shadow: true },
    ]) {
      expect(
        decisionOf({ ...harness('notify', extra).deps, ...relaxable }),
        JSON.stringify(extra)
      ).toBe('notify');
    }
    // Without the marker a relaxer is still clamped at the policy gate.
    DOT_DECISION_RELAXERS.length = 0;
    DOT_DECISION_RELAXERS.push({ id: 'plain', relax: () => ({ decision: 'auto', reason: 'x' }) });
    expect(decisionOf({ ...harness('notify').deps, ...relaxable })).toBe('notify');
  });

  it('a shadow disposition records only; a throwing override is skipped', () => {
    DOT_DISPOSITION_OVERRIDES.push(
      {
        id: 'boom',
        dispose: () => {
          throw new Error('exploded');
        },
      },
      { id: 'autonomy', dispose: () => ({ disposition: 'shadow', reason: 'L0' }) }
    );
    const h = harness('approve');
    const { records } = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(records[0]).toMatchObject({
      status: 'shadow',
      disposition_by: 'autonomy',
      gate_decision: 'approve',
      reason: 'autonomy: L0',
    });
    expect(h.routed).toHaveLength(0);
    expect(h.items).toHaveLength(0);

    DOT_DISPOSITION_OVERRIDES.length = 0;
    DOT_DISPOSITION_OVERRIDES.push({
      id: 'boom',
      dispose: () => {
        throw new Error('exploded');
      },
    });
    const plain = harness('auto');
    const second = dispatchDotProposals(CHARTER, [{ ...PROPOSAL, title: 'Other' }], plain.deps);
    expect(second.records[0].status).toBe('dispatched');
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

  it('merged escalations keep every link and say only the primary one is superseded', () => {
    DOT_PRE_GATE_CHECKS.push(
      {
        id: 'arbitration',
        check: () => ({
          ok: 'escalate',
          reason: 'conflicts with a',
          card_context: 'Conflicts with dact-a.',
          link: { action_ref: 'dact-a', dot_id: 'dot-a' },
        }),
      },
      {
        id: 'second',
        check: () => ({
          ok: 'escalate',
          reason: 'conflicts with b',
          card_context: 'Conflicts with dact-b.',
          link: { action_ref: 'dact-b', dot_id: 'dot-b' },
        }),
      }
    );
    const h = harness('auto');
    const { records } = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(h.routed[0].question).toContain('On approve only dact-a (dot:dot-a) is superseded');
    expect(records[0].escalation).toMatchObject({
      link: { action_ref: 'dact-a', dot_id: 'dot-a' },
      links: [
        { action_ref: 'dact-a', dot_id: 'dot-a' },
        { action_ref: 'dact-b', dot_id: 'dot-b' },
      ],
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
