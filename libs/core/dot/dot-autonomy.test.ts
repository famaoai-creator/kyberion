import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { safeMkdir, safeRmSync } from '../secure-io.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import type {
  AutonomousOpsGateInput,
  AutonomousOpsGateResult,
} from '../governance/autonomous-ops-gate.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import type {
  RouteAutonomousDecisionInput,
  RoutedDecision,
} from '../governance/approval-decision-routing.js';
import type { DotCharter } from './dot-charter.js';
import {
  dispatchDotProposals,
  evaluateDotProposalGate,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import type { CreateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import {
  DOT_DECISION_RELAXERS,
  DOT_DIGEST_SECTIONS,
  DOT_FLOOR_CONTRIBUTORS,
  DOT_STATUS_SECTIONS,
} from './dot-extension-registry.js';
import { recordDotFeedback, type DotFeedbackEntry } from './dot-feedback.js';
import type { DotDecisionLevel, DotProposal } from './dot-proposals.js';
import {
  DEFAULT_DOT_AUTONOMY_POLICY,
  clampDotAutonomyLevel,
  dotAutonomyDecisionAt,
  dotAutonomyDecisionRelaxer,
  dotAutonomyDigestLines,
  dotAutonomyFloorContributor,
  dotAutonomyLevel,
  dotAutonomyMetrics,
  dotAutonomyPromotionReady,
  dotLearnedFloorHolds,
  readDotAutonomyShadow,
  readDotAutonomyState,
  recordDotAutonomyShadow,
  runDotAutonomyStep,
  writeDotAutonomyState,
  type DotAutonomyDeps,
  type DotAutonomyStateDoc,
} from './dot-autonomy.js';
import {
  DOT_AUTONOMY_LEVELS,
  DOT_OUTCOMES_FILE,
  DOT_WORK_RESULTS_FILE,
  dotStatePath,
  type DotAutonomyLevel,
} from './dot-state-paths.js';
import './dot-extension-bootstrap.js';

const TEST_ROOT = `active/shared/tmp/dot-autonomy-tests-${randomUUID()}`;
const RANK = { auto: 0, notify: 1, approve: 2 } as const;
const T0 = new Date('2026-10-04T09:00:00Z');

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'auto-dot',
  version: '1.0.0',
  title: 'Autonomy dot',
  purpose: 'Exercise the autonomy ladder.',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'Earn trust.' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-auto-dot' },
};

const PROPOSAL: DotProposal = {
  action_id: 'dot_delegate_work',
  title: 'Rerun CI',
  objective: 'Re-run the flaky job.',
  work_shape: 'direct_reply',
};

function gateResult(
  input: AutonomousOpsGateInput,
  base: DotDecisionLevel,
  extra: Partial<AutonomousOpsGateResult> = {}
): AutonomousOpsGateResult {
  const requested = input.requestedDecision;
  const decision = requested && RANK[requested] > RANK[base] ? requested : base;
  return {
    actionId: input.actionId,
    decision,
    allowed: decision !== 'approve',
    score: 4,
    maxScore: 6,
    policyVersion: 'test',
    executionMode: 'apply',
    reason: 'test gate',
    axes: { scope: 1, reversibility: 1, sensitivity: 1, confidence: 1 },
    shadow: false,
    escalations: requested && RANK[requested] > RANK[base] ? ['requested'] : [],
    highRiskPathMatches: [],
    ...extra,
  };
}

function setLevel(level: DotAutonomyLevel, extra: Partial<DotAutonomyStateDoc> = {}, at = T0) {
  writeDotAutonomyState(
    CHARTER,
    { dot_id: CHARTER.dot_id, level, since: at.toISOString(), history: [], ...extra },
    { rootDir: TEST_ROOT }
  );
}

function feedback(outcome: DotFeedbackEntry['outcome'], at: Date, ref: string, human = true): void {
  recordDotFeedback(
    {
      dot_id: CHARTER.dot_id,
      action_id: 'dot_delegate_work',
      action_ref: ref,
      title: ref,
      outcome,
      ...(human ? { decided_by: 'famao', decided_by_type: 'human' as const } : {}),
    },
    { rootDir: TEST_ROOT, now: () => at, onRejection: () => {} }
  );
}

function appendState(file: string, row: unknown): void {
  const abs = path.join(TEST_ROOT, dotStatePath(CHARTER, file));
  safeMkdir(path.dirname(abs), { recursive: true });
  appendJsonLine(abs, row);
}

function outcome(verdict: string, at: Date, ref: string): void {
  appendState(DOT_OUTCOMES_FILE, {
    dot_id: CHARTER.dot_id,
    action_ref: ref,
    work_item_id: `w-${ref}`,
    ref: { kr_id: 'kr' },
    verdict,
    due_at: at.toISOString(),
    measured_at: at.toISOString(),
  });
}

function dispatchDeps(base: DotDecisionLevel, now = T0): DotDispatchDeps {
  return {
    rootDir: TEST_ROOT,
    now: () => now,
    gate: (input) => gateResult(input, base),
  };
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dot autonomy levels and state', () => {
  it('registers floor, relaxer, status and digest sections', () => {
    expect(DOT_FLOOR_CONTRIBUTORS.map((x) => x.id)).toContain('autonomy');
    expect(DOT_DECISION_RELAXERS.map((x) => x.id)).toContain('autonomy');
    expect(DOT_STATUS_SECTIONS.map((x) => x.id)).toContain('autonomy');
    expect(DOT_DIGEST_SECTIONS.map((x) => x.id)).toContain('autonomy');
  });

  it('defaults to L2, clamps to charter bounds and defaults max to L3', () => {
    expect(dotAutonomyLevel(CHARTER, { rootDir: TEST_ROOT })).toBe('L2');
    expect(clampDotAutonomyLevel(CHARTER, 'L4')).toBe('L3');
    const bounded = {
      ...CHARTER,
      autonomy: { initial_level: 'L0' as const, min_level: 'L1' as const },
    };
    expect(dotAutonomyLevel(bounded, { rootDir: TEST_ROOT })).toBe('L1');
    setLevel('L4');
    expect(dotAutonomyLevel(CHARTER, { rootDir: TEST_ROOT })).toBe('L3');
    expect(
      dotAutonomyLevel({ ...CHARTER, autonomy: { max_level: 'L4' } }, { rootDir: TEST_ROOT })
    ).toBe('L4');
  });

  it('L0/L1 floor approve; L2+ contribute nothing', () => {
    const contributor = dotAutonomyFloorContributor();
    const ctx = { rootDir: TEST_ROOT, now: () => T0 };
    for (const level of DOT_AUTONOMY_LEVELS) {
      setLevel(level);
      const c = { ...CHARTER, autonomy: { max_level: 'L4' as const } };
      expect(contributor.floor(c, PROPOSAL, ctx)).toBe(
        level === 'L0' || level === 'L1' ? 'approve' : undefined
      );
    }
  });

  it('L3 releases the learned floor after one human approval or 7 days; L2 needs three', () => {
    const rows: DotFeedbackEntry[] = [
      {
        dot_id: 'd',
        action_id: 'a',
        action_ref: 'r1',
        title: 't',
        outcome: 'rejected',
        recorded_at: T0.toISOString(),
      },
    ];
    const soon = new Date(T0.getTime() + 60_000);
    expect(dotLearnedFloorHolds(rows, 'L3', soon)).toBe(true);
    const withVetoApproval = [
      ...rows,
      {
        ...rows[0],
        action_ref: 'r2',
        outcome: 'approved' as const,
        decided_by: 'policy:veto-window',
        decided_by_type: 'human' as const,
      },
    ];
    expect(dotLearnedFloorHolds(withVetoApproval, 'L3', soon)).toBe(true);
    const withHuman = [
      ...rows,
      {
        ...rows[0],
        action_ref: 'r3',
        outcome: 'approved' as const,
        decided_by: 'famao',
        decided_by_type: 'human' as const,
      },
    ];
    expect(dotLearnedFloorHolds(withHuman, 'L3', soon)).toBe(false);
    expect(dotLearnedFloorHolds(withHuman, 'L2', soon)).toBe(true);
    expect(dotLearnedFloorHolds(rows, 'L3', new Date(T0.getTime() + 7 * 86_400_000))).toBe(false);
    expect(dotLearnedFloorHolds(rows, 'L2', new Date(T0.getTime() + 7 * 86_400_000))).toBe(true);
  });

  it('decision semantics: L4 relaxes only eligible notify; approve and charter floors hold', () => {
    const base = { learnedHolds: false, l4Eligible: true };
    expect(dotAutonomyDecisionAt('L0', { ...base, policyDecision: 'auto' })).toBe('approve');
    expect(dotAutonomyDecisionAt('L1', { ...base, policyDecision: 'auto' })).toBe('approve');
    expect(
      dotAutonomyDecisionAt('L2', { ...base, policyDecision: 'notify', learnedHolds: true })
    ).toBe('approve');
    expect(dotAutonomyDecisionAt('L4', { ...base, policyDecision: 'notify' })).toBe('auto');
    expect(dotAutonomyDecisionAt('L4', { ...base, policyDecision: 'approve' })).toBe('approve');
    expect(
      dotAutonomyDecisionAt('L4', { ...base, policyDecision: 'notify', hardFloor: 'notify' })
    ).toBe('notify');
    expect(
      dotAutonomyDecisionAt('L4', { ...base, policyDecision: 'notify', l4Eligible: false })
    ).toBe('notify');
    expect(dotAutonomyDecisionAt('L3', { ...base, policyDecision: 'notify' })).toBe('notify');
  });
});

describe('dot autonomy through the dispatch gate', () => {
  it('never yields a decision below gate.decision or the charter floor, except L4 notify → auto', () => {
    const levels: DotAutonomyLevel[] = [...DOT_AUTONOMY_LEVELS];
    const decisions: DotDecisionLevel[] = ['auto', 'notify', 'approve'];
    for (const level of levels) {
      for (const base of decisions) {
        for (const charterFloor of [undefined, ...decisions]) {
          for (const learned of [false, true]) {
            safeRmSync(TEST_ROOT, { recursive: true, force: true });
            setLevel(level);
            if (learned) {
              feedback('rejected', new Date(T0.getTime() - 3_600_000), 'rej');
              feedback('approved', new Date(T0.getTime() - 1_800_000), 'ok');
            }
            outcome('improved', new Date(T0.getTime() - 3_600_000), 'o1');
            const charter: DotCharter = {
              ...CHARTER,
              autonomy: { max_level: 'L4' },
              ...(charterFloor ? { decisions: { default_decision: charterFloor } } : {}),
            };
            const { gate } = evaluateDotProposalGate(charter, PROPOSAL, dispatchDeps(base));
            const label = `${level}/${base}/${charterFloor}/${learned}`;
            // The single permitted exception: L4, policy notify, no hard floor
            // at notify or above (the learned floor is released after one approval).
            const exception =
              level === 'L4' && base === 'notify' && (!charterFloor || charterFloor === 'auto');
            if (exception) {
              expect(gate.decision, label).toBe('auto');
              continue;
            }
            expect(RANK[gate.decision], label).toBeGreaterThanOrEqual(RANK[base]);
            if (charterFloor) {
              expect(RANK[gate.decision], label).toBeGreaterThanOrEqual(RANK[charterFloor]);
            }
            if (level === 'L0' || level === 'L1') expect(gate.decision, label).toBe('approve');
          }
        }
      }
    }
  });

  it('L4 relaxes notify → auto only for a relaxable, eligible action', () => {
    const l4 = { ...CHARTER, autonomy: { max_level: 'L4' as const } };
    setLevel('L4');
    outcome('improved', new Date(T0.getTime() - 3_600_000), 'o1');
    const relaxed = evaluateDotProposalGate(l4, PROPOSAL, dispatchDeps('notify'));
    expect(relaxed.gate).toMatchObject({ decision: 'auto', allowed: true });
    expect(relaxed.gate.vetoWindowMinutes).toBeUndefined();
    expect(relaxed.gate.reason).toContain('l4_notify_to_auto');
    expect(relaxed.relaxed_by).toBe('autonomy');
    // Not in policy autonomy.relaxable_actions.
    expect(
      evaluateDotProposalGate(l4, PROPOSAL, { ...dispatchDeps('notify'), relaxableActions: [] })
        .gate.decision
    ).toBe('notify');
    expect(
      evaluateDotProposalGate(
        l4,
        { ...PROPOSAL, action_id: 'dot_handoff', handoff_to: 'other' },
        dispatchDeps('notify')
      ).gate.decision
    ).toBe('notify');
    // L3 never takes the exception.
    setLevel('L3');
    expect(evaluateDotProposalGate(l4, PROPOSAL, dispatchDeps('notify')).gate.decision).toBe(
      'notify'
    );
  });

  it('L4 never relaxes approve, high-risk, irreversible, poor outcomes or a charter floor', () => {
    const l4 = { ...CHARTER, autonomy: { max_level: 'L4' as const } };
    setLevel('L4');
    outcome('improved', new Date(T0.getTime() - 3_600_000), 'o1');
    expect(evaluateDotProposalGate(l4, PROPOSAL, dispatchDeps('approve')).gate.decision).toBe(
      'approve'
    );
    const withGate = (extra: Partial<AutonomousOpsGateResult>): DotDispatchDeps => ({
      ...dispatchDeps('notify'),
      gate: (input) => gateResult(input, 'notify', extra),
    });
    expect(
      evaluateDotProposalGate(l4, PROPOSAL, withGate({ highRiskPathMatches: ['libs/core/**'] }))
        .gate.decision
    ).toBe('notify');
    expect(
      evaluateDotProposalGate(
        l4,
        PROPOSAL,
        withGate({ axes: { scope: 1, reversibility: 2, sensitivity: 1, confidence: 1 } })
      ).gate.decision
    ).toBe('notify');
    expect(
      evaluateDotProposalGate(l4, PROPOSAL, withGate({ escalations: ['budget'] })).gate.decision
    ).toBe('notify');
    expect(
      evaluateDotProposalGate(
        { ...l4, decisions: { default_decision: 'notify' } },
        PROPOSAL,
        dispatchDeps('notify')
      ).gate.decision
    ).toBe('notify');
    expect(
      evaluateDotProposalGate(
        l4,
        { ...PROPOSAL, requested_decision: 'notify' },
        dispatchDeps('notify')
      ).gate.decision
    ).toBe('notify');
    outcome('regressed', new Date(T0.getTime() - 3_000_000), 'o2');
    expect(evaluateDotProposalGate(l4, PROPOSAL, dispatchDeps('notify')).gate.decision).toBe(
      'notify'
    );
  });

  it('L3 lifts the learned floor after one human approval; L2 keeps it', () => {
    feedback('rejected', new Date(T0.getTime() - 3_600_000), 'rej');
    feedback('approved', new Date(T0.getTime() - 1_800_000), 'ok');
    setLevel('L2');
    expect(evaluateDotProposalGate(CHARTER, PROPOSAL, dispatchDeps('notify')).gate.decision).toBe(
      'approve'
    );
    setLevel('L3');
    const result = evaluateDotProposalGate(CHARTER, PROPOSAL, dispatchDeps('notify'));
    expect(result.gate.decision).toBe('notify');
    expect(result.relaxed_by).toBe('autonomy');
  });

  it('the relaxer never relaxes a never_auto / high-risk gate', () => {
    setLevel('L3');
    feedback('rejected', new Date(T0.getTime() - 8 * 86_400_000), 'rej');
    const relaxer = dotAutonomyDecisionRelaxer();
    const ctx = { rootDir: TEST_ROOT, now: () => T0 };
    const hard = gateResult({ actionId: 'x' }, 'approve', { escalations: ['never_auto'] });
    expect(relaxer.relax(CHARTER, PROPOSAL, hard, 'approve', ctx)).toBeUndefined();
    const ok = gateResult({ actionId: 'x', requestedDecision: 'approve' }, 'notify');
    expect(relaxer.relax(CHARTER, PROPOSAL, ok, 'approve', ctx)?.decision).toBe('auto');
    setLevel('L2');
    expect(relaxer.relax(CHARTER, PROPOSAL, ok, 'approve', ctx)).toBeUndefined();
  });
});

describe('dot autonomy L0 true shadow', () => {
  function l0Harness() {
    const routed: RouteAutonomousDecisionInput[] = [];
    const items: CreateWorkItemInput[] = [];
    const notes: string[] = [];
    const deps: DotDispatchDeps = {
      ...dispatchDeps('auto'),
      route: (input) => {
        routed.push(input);
        throw new Error('L0 must never route a decision card');
      },
      createWorkItem: (input) => {
        items.push(input);
        return { item_id: `witem-${items.length}` } as WorkItem;
      },
      countOpenWorkItems: () => 0,
      listCharters: () => [CHARTER],
      notify: (_e, payload) => {
        notes.push(payload.title);
        return true;
      },
      audit: () => {},
    };
    return { deps, routed, items, notes };
  }

  it('records proposals only: no decision card, no notification, no WorkItem', () => {
    setLevel('L0');
    const h = l0Harness();
    const { records } = dispatchDotProposals(
      CHARTER,
      [PROPOSAL, { ...PROPOSAL, title: 'Clean caches', objective: 'Drop stale caches.' }],
      h.deps
    );
    expect(records.map((r) => [r.status, r.disposition_by])).toEqual([
      ['shadow', 'autonomy'],
      ['shadow', 'autonomy'],
    ]);
    expect(records[0].work_item_id).toBeUndefined();
    expect(records[0].request_id).toBeUndefined();
    expect(h.routed).toHaveLength(0);
    expect(h.items).toHaveLength(0);
    expect(h.notes).toHaveLength(0);

    const shadow = readDotAutonomyShadow(CHARTER, { rootDir: TEST_ROOT });
    expect(shadow.map((r) => [r.action_ref, r.disposition, r.next_level, r.would_have])).toEqual([
      [records[0].action_ref, 'shadow', 'L1', 'approve'],
      [records[1].action_ref, 'shadow', 'L1', 'approve'],
    ]);
    expect(shadow.every((r) => r.agree && r.human_outcome === undefined)).toBe(true);

    // Not re-recorded inside the dedupe window; never counted as a delegation slot.
    const again = dispatchDotProposals(CHARTER, [PROPOSAL], h.deps);
    expect(again.records).toHaveLength(0);
    expect(again.duplicates).toEqual([records[0].action_ref]);

    // Surfaced in the digest; counted as decisions for the L0 → L1 promotion.
    const lines = dotAutonomyDigestLines(CHARTER, undefined, { rootDir: TEST_ROOT, now: () => T0 });
    expect(lines[0]).toContain('2 proposal(s) recorded only');
    expect(lines).toContain('- shadow: Clean caches (L1 would ask: approve)');
    const metrics = dotAutonomyMetrics(CHARTER, { rootDir: TEST_ROOT, now: () => T0 });
    expect(metrics).toMatchObject({ level: 'L0', decisions: 2, agreement_rate: 1 });
    // No outcomes exist at L0, so the outcome bar is waived for that step only.
    const policy = {
      ...DEFAULT_DOT_AUTONOMY_POLICY,
      promotion: { ...DEFAULT_DOT_AUTONOMY_POLICY.promotion, min_decisions: 2 },
    };
    expect(dotAutonomyPromotionReady(metrics, policy).ready).toBe(true);
    expect(dotAutonomyPromotionReady({ ...metrics, level: 'L1' }, policy).ready).toBe(false);
  });

  it('L1 still routes every proposal to an operator decision', () => {
    setLevel('L1');
    const h = l0Harness();
    expect(() => dispatchDotProposals(CHARTER, [PROPOSAL], h.deps)).not.toThrow();
    expect(h.routed).toHaveLength(1);
    expect(h.routed[0].gate.decision).toBe('approve');
    expect(readDotAutonomyShadow(CHARTER, { rootDir: TEST_ROOT })).toHaveLength(0);
  });
});

describe('dot autonomy shadow ledger and metrics', () => {
  it('records would-have vs human outcome once per settled human decision', () => {
    setLevel('L2');
    feedback('approved', new Date(T0.getTime() - 3_000), 'a1');
    feedback('rejected', new Date(T0.getTime() - 2_000), 'a2');
    feedback('expired', new Date(T0.getTime() - 1_000), 'a3');
    feedback('approved', new Date(T0.getTime() - 500), 'a4', false);
    const deps: DotAutonomyDeps = {
      rootDir: TEST_ROOT,
      now: () => T0,
      gate: (input) => gateResult(input, 'notify'),
      listActions: () => [],
    };
    const rows = recordDotAutonomyShadow(CHARTER, deps);
    expect(rows.map((r) => [r.action_ref, r.next_level, r.would_have, r.agree])).toEqual([
      ['a1', 'L3', 'notify', true],
      ['a2', 'L3', 'notify', false],
    ]);
    expect(recordDotAutonomyShadow(CHARTER, deps)).toEqual([]);
    expect(readDotAutonomyShadow(CHARTER, deps)).toHaveLength(2);
    const metrics = dotAutonomyMetrics(CHARTER, deps);
    // The later (veto-silence) approval ends the rejection streak.
    expect(metrics).toMatchObject({ decisions: 2, agreement_rate: 0.5, rejection_streak: 0 });
  });

  it('counts incidents from executor failures and regressed outcomes', () => {
    setLevel('L2', {}, new Date(T0.getTime() - 86_400_000));
    appendState(DOT_WORK_RESULTS_FILE, {
      dot_id: CHARTER.dot_id,
      work_item_id: 'w1',
      action_ref: 'x',
      mode: 'goal_turn',
      status: 'failed',
      summary: 'boom',
      started_at: T0.toISOString(),
      completed_at: T0.toISOString(),
    });
    // By-design stops (escalated guidance, blocked) are not incidents.
    appendState(DOT_WORK_RESULTS_FILE, {
      dot_id: CHARTER.dot_id,
      work_item_id: 'w2',
      action_ref: 'y',
      mode: 'escalated',
      status: 'blocked',
      summary: 'mission-shaped: needs an operator',
      started_at: T0.toISOString(),
      completed_at: T0.toISOString(),
    });
    outcome('regressed', T0, 'o1');
    outcome('improved', T0, 'o2');
    const metrics = dotAutonomyMetrics(CHARTER, { rootDir: TEST_ROOT, now: () => T0 });
    expect(metrics).toMatchObject({
      incidents_30d: 2,
      executor_incidents_30d: 1,
      regressed_outcomes_30d: 1,
      outcome_success_rate: 0.5,
      since_level_change: { executor_incidents: 1, regressed_outcomes: 1 },
    });
  });
});

describe('dot autonomy supervisor step', () => {
  function stepDeps(now: Date, extra: Partial<DotAutonomyDeps> = {}) {
    const notes: string[] = [];
    const audits: string[] = [];
    const routed: RouteAutonomousDecisionInput[] = [];
    const deps: DotAutonomyDeps = {
      rootDir: TEST_ROOT,
      now: () => now,
      policy: {
        ...DEFAULT_DOT_AUTONOMY_POLICY,
        promotion: { ...DEFAULT_DOT_AUTONOMY_POLICY.promotion, min_decisions: 2 },
      },
      gate: (input) => gateResult(input, 'notify'),
      listActions: () => [],
      notify: (_e, payload) => {
        notes.push(payload.title);
        return true;
      },
      audit: (entry) => {
        audits.push(entry.operation);
      },
      route: (input): RoutedDecision => {
        routed.push(input);
        return {
          level: 'decide',
          timing: 'immediate',
          proceed: false,
          parked: true,
          shadow: false,
          requestId: 'req-promo',
          notified: true,
        };
      },
      ...extra,
    };
    return { deps, notes, audits, routed };
  }

  it('first run only initializes state so pre-rollout history never demotes', () => {
    outcome('regressed', new Date(T0.getTime() - 3_600_000), 'o1');
    outcome('regressed', new Date(T0.getTime() - 3_500_000), 'o2');
    const { deps } = stepDeps(T0);
    expect(runDotAutonomyStep(CHARTER, deps).change).toBeUndefined();
    expect(readDotAutonomyState(CHARTER, deps)).toMatchObject({ level: 'L2', persisted: true });
    expect(runDotAutonomyStep(CHARTER, deps).change).toBeUndefined();
  });

  it('demotes automatically with notify + audit, not below L1 by default', () => {
    setLevel('L3', {}, new Date(T0.getTime() - 86_400_000));
    outcome('regressed', new Date(T0.getTime() - 3_600_000), 'o1');
    outcome('regressed', new Date(T0.getTime() - 3_500_000), 'o2');
    const h = stepDeps(T0);
    const result = runDotAutonomyStep(CHARTER, h.deps);
    expect(result.change).toMatchObject({ from: 'L3', to: 'L2' });
    expect(h.audits).toContain('demote');
    expect(h.notes[0]).toContain('L3 → L2');
    // Counters reset at the level change: no cascade on the next sweep.
    expect(
      runDotAutonomyStep(CHARTER, stepDeps(new Date(T0.getTime() + 60_000)).deps).change
    ).toBeUndefined();
    expect(
      dotAutonomyDigestLines(CHARTER, new Date(T0.getTime() - 1), {
        rootDir: TEST_ROOT,
        now: () => T0,
      })[0]
    ).toContain('demoted from L3');

    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    setLevel('L1', {}, new Date(T0.getTime() - 86_400_000));
    feedback('rejected', new Date(T0.getTime() - 3_000), 'r1');
    feedback('rejected', new Date(T0.getTime() - 2_000), 'r2');
    expect(runDotAutonomyStep(CHARTER, stepDeps(T0).deps).change).toBeUndefined();
  });

  it('promotes only after a human approval settles in a later sweep', () => {
    const start = new Date(T0.getTime() - 86_400_000);
    setLevel('L2', {}, start);
    feedback('approved', new Date(T0.getTime() - 3_000), 'a1');
    feedback('approved', new Date(T0.getTime() - 2_000), 'a2');
    outcome('improved', new Date(T0.getTime() - 1_000), 'o1');
    const first = stepDeps(T0, {
      loadApproval: () => {
        throw new Error('must not load in the same sweep');
      },
    });
    const opened = runDotAutonomyStep(CHARTER, first.deps);
    expect(opened.promotion_requested).toEqual({ to: 'L3', request_id: 'req-promo' });
    expect(opened.level).toBe('L2');
    expect(first.routed[0].gate).toMatchObject({ decision: 'approve', allowed: false });

    const later = new Date(T0.getTime() + 60_000);
    const approval = (patch: Partial<ApprovalRequestRecord>) =>
      ({
        id: 'req-promo',
        status: 'approved',
        decidedBy: 'bot',
        decidedByType: 'ai_agent',
        ...patch,
      }) as ApprovalRequestRecord;

    // Pending: nothing changes.
    const pending = runDotAutonomyStep(
      CHARTER,
      stepDeps(later, { loadApproval: () => approval({ status: 'pending' }) }).deps
    );
    expect(pending.level).toBe('L2');
    expect(
      readDotAutonomyState(CHARTER, { rootDir: TEST_ROOT }).pending_promotion?.request_id
    ).toBe('req-promo');

    // Agent approval is ignored and clears the card.
    const agent = runDotAutonomyStep(
      CHARTER,
      stepDeps(later, { loadApproval: () => approval({}) }).deps
    );
    expect(agent.level).toBe('L2');
    expect(agent.promotion_cleared).toContain('without a human decider');

    // Re-open (next day) and approve as a human.
    const nextDay = new Date(T0.getTime() + 86_400_000);
    const reopened = runDotAutonomyStep(CHARTER, stepDeps(nextDay).deps);
    expect(reopened.promotion_requested?.to).toBe('L3');
    const veto = runDotAutonomyStep(
      CHARTER,
      stepDeps(new Date(nextDay.getTime() + 60_000), {
        loadApproval: () => approval({ decidedBy: 'policy:veto-window', decidedByType: 'human' }),
      }).deps
    );
    expect(veto.level).toBe('L2');

    const dayThree = new Date(T0.getTime() + 2 * 86_400_000);
    runDotAutonomyStep(CHARTER, stepDeps(dayThree).deps);
    const human = stepDeps(new Date(dayThree.getTime() + 60_000), {
      loadApproval: () => approval({ decidedBy: 'famao', decidedByType: 'human' }),
    });
    const promoted = runDotAutonomyStep(CHARTER, human.deps);
    expect(promoted.change).toMatchObject({ from: 'L2', to: 'L3' });
    expect(human.audits).toContain('promote');
    expect(dotAutonomyLevel(CHARTER, { rootDir: TEST_ROOT })).toBe('L3');
  });

  it('never opens a promotion card beyond max_level or below the policy bar', () => {
    setLevel('L3', {}, new Date(T0.getTime() - 86_400_000));
    feedback('approved', new Date(T0.getTime() - 3_000), 'a1');
    feedback('approved', new Date(T0.getTime() - 2_000), 'a2');
    outcome('improved', new Date(T0.getTime() - 1_000), 'o1');
    const h = stepDeps(T0);
    expect(runDotAutonomyStep(CHARTER, h.deps).promotion_requested).toBeUndefined();
    expect(h.routed).toHaveLength(0);

    safeRmSync(TEST_ROOT, { recursive: true, force: true });
    setLevel('L2', {}, new Date(T0.getTime() - 86_400_000));
    feedback('approved', new Date(T0.getTime() - 3_000), 'a1');
    feedback('approved', new Date(T0.getTime() - 2_000), 'a2');
    // No measurable outcomes: success 0 < 0.8.
    const none = stepDeps(T0);
    expect(runDotAutonomyStep(CHARTER, none.deps).promotion_requested).toBeUndefined();
    const ledger = readJsonLines(
      path.join(TEST_ROOT, dotStatePath(CHARTER, 'autonomy-shadow.jsonl'))
    );
    expect(ledger).toHaveLength(2);
  });
});
