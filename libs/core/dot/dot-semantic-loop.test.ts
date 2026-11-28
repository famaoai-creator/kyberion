import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { appendJsonLine } from '../foundation/json.js';
import type { LiveJudgmentInvokePort } from '../organization/semantic-judgment-live-provider.js';
import type { DotCharter } from './dot-charter.js';
import { evaluateDotProposalGate } from './dot-dispatch.js';
import {
  DOT_DECISION_RELAXERS,
  DOT_DIGEST_SECTIONS,
  DOT_STATUS_SECTIONS,
} from './dot-extension-registry.js';
import { ensureDotExtensionsRegistered } from './dot-extension-bootstrap.js';
import { recordDotFeedback } from './dot-feedback.js';
import type { DotProposal } from './dot-proposals.js';
import { createDotSemanticSharedBudgetPort } from './dot-semantic-budget.js';
import {
  DOT_SEMANTIC_JUDGMENT_LEDGER_FILE,
  DOT_SEMANTIC_LEDGER_MAX_ROWS,
  dotSemanticJudgmentDecisionRelaxer,
  dotSemanticJudgmentDigestSection,
  dotSemanticJudgmentMetrics,
  dotSemanticJudgmentStatusSection,
  latestReconciliationsByRef,
  observeLiveDotProposals,
  readDotSemanticJudgmentLedger,
  reconcileDotSemanticFeedback,
} from './dot-semantic-loop.js';
import { DOT_OUTCOMES_FILE, dotStatePath } from './dot-state-paths.js';
import * as path from 'node:path';

const TEST_ROOT = 'active/shared/tmp/dot-semantic-loop-tests';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'loop-dot',
  version: '1.0.0',
  title: 'Loop Dot',
  purpose: 'Verify live semantic judgment improvement loop.',
  status: 'active',
  scope: { tier: 'public' },
  goal: {
    statement: 'Keep runtime healthy with safe reversible actions.',
    budget: { token_cap_per_day: 50_000, wall_clock_ms_per_wake: 15_000 },
  },
  attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
  authority: {
    authority_role: 'infrastructure_sentinel',
    allowed_execution_shapes: ['pipeline'],
    allowed_pipelines: ['pipelines/cleanup.json'],
  },
  notification: { deliver_to: { surface: 'surface', channel: 'inbox' } },
  runtime: {
    heartbeat_id: 'dot-loop-dot',
    semantic_judgment: { mode: 'advisory' },
  },
};

const PROPOSAL: DotProposal = {
  action_id: 'dot_delegate_work',
  title: 'Rotate cache',
  objective: 'Clear expired cache entries.',
  execution_shape: 'pipeline',
  pipeline_ref: 'pipelines/cleanup.json',
};

function makePort(disposition: 'apply_precedent' | 'reframe' | 'escalate'): LiveJudgmentInvokePort {
  return {
    mode: 'live_api',
    provider: 'local',
    model: 'test-judge',
    async invoke() {
      return {
        text: JSON.stringify({
          disposition,
          rationale: `Evaluated as ${disposition}.`,
          precedent_refs: [],
          risk_flags: [],
          ...(disposition !== 'apply_precedent'
            ? { suggested_improvement: 'Clarify goal bounds for this action.' }
            : {}),
        }),
        usage: { input_tokens: 100, output_tokens: 40 },
      };
    },
  };
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('dot-semantic-loop', () => {
  it('observes proposals, reconciles human feedback, emits distill candidates on mismatch, and relaxes approve->notify only when earned', async () => {
    ensureDotExtensionsRegistered();
    expect(DOT_DECISION_RELAXERS.some((r) => r.id === 'semantic-judgment')).toBe(true);
    expect(DOT_STATUS_SECTIONS.some((s) => s.id === 'semantic_judgment')).toBe(true);
    expect(DOT_DIGEST_SECTIONS.some((s) => s.id === 'semantic_judgment')).toBe(true);

    let clockMs = Date.parse('2026-11-27T10:00:00.000Z');
    const now = () => new Date(clockMs);
    const budget = createDotSemanticSharedBudgetPort({
      rootDir: TEST_ROOT,
      now,
      charter: CHARTER,
      dailyTokenCap: 20_000,
      readOrgDailyCap: () => 100_000,
    });
    const emittedDistill: Array<{ action_ref: string; comment: string }> = [];

    // 1. Run 5 cycles of live observation + human approval
    for (let i = 1; i <= 5; i++) {
      clockMs += 1_000;
      const observed = await observeLiveDotProposals(CHARTER, [PROPOSAL], {
        rootDir: TEST_ROOT,
        now,
        invoke: makePort('apply_precedent'),
        budget,
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        status: 'evaluated',
        budget_status: 'settled',
        verdict: { disposition: 'apply_precedent' },
      });

      clockMs += 1_000;
      recordDotFeedback(
        {
          dot_id: CHARTER.dot_id,
          action_id: PROPOSAL.action_id,
          action_ref: `dact-ok-${i}`,
          outcome: 'approved',
          title: PROPOSAL.title,
          decided_by: 'user:operator',
          decided_by_type: 'human',
        },
        { rootDir: TEST_ROOT, now }
      );
      await reconcileDotSemanticFeedback(CHARTER, {
        rootDir: TEST_ROOT,
        now,
        recordDistillFeedback: (fb) => {
          emittedDistill.push({ action_ref: fb.action_ref, comment: fb.comment });
        },
      });
    }

    expect(emittedDistill).toEqual([]);
    const metrics = dotSemanticJudgmentMetrics(CHARTER, { rootDir: TEST_ROOT, now });
    expect(metrics).toMatchObject({
      judgments: 5,
      evaluated: 5,
      reconciled: 5,
      agreed: 5,
      agreement_rate: 1,
      false_apply_count: 0,
      relaxation_eligible: true,
    });

    // 2. With fresh apply_precedent + 100% agreement over 5 decisions, reversible approve relaxes to notify
    const gate = (decision: 'auto' | 'notify' | 'approve', extra: Record<string, unknown> = {}) =>
      ({
        actionId: PROPOSAL.action_id,
        decision,
        allowed: decision !== 'approve',
        score: decision === 'approve' ? 8 : 4,
        maxScore: 12,
        policyVersion: '1.2.0',
        executionMode: 'apply',
        reason: `policy ${decision}`,
        axes: { scope: 1, reversibility: 1, sensitivity: 1, confidence: 1 },
        shadow: false,
        escalations: [],
        highRiskPathMatches: [],
        ...extra,
      }) as never;

    const relaxedGate = evaluateDotProposalGate(CHARTER, PROPOSAL, {
      rootDir: TEST_ROOT,
      now,
      relaxableActions: ['dot_delegate_work'],
      gate: () => gate('approve'),
    });
    expect(relaxedGate.gate.decision).toBe('notify');
    expect(relaxedGate.relaxed_by).toBe('semantic-judgment');

    // Hard boundaries never relax even when eligible
    const hardGate = evaluateDotProposalGate(CHARTER, PROPOSAL, {
      rootDir: TEST_ROOT,
      now,
      relaxableActions: ['dot_delegate_work'],
      gate: () => gate('approve', { escalations: ['never_auto'] }),
    });
    expect(hardGate.gate.decision).toBe('approve');

    // 3. A single human rejection triggers false_apply, emits distill candidate, and immediately re-tightens to approve
    clockMs += 1_000;
    await observeLiveDotProposals(CHARTER, [PROPOSAL], {
      rootDir: TEST_ROOT,
      now,
      invoke: makePort('apply_precedent'),
      budget,
    });
    clockMs += 1_000;
    recordDotFeedback(
      {
        dot_id: CHARTER.dot_id,
        action_id: PROPOSAL.action_id,
        action_ref: 'dact-bad-1',
        outcome: 'rejected',
        title: PROPOSAL.title,
        decided_by: 'user:operator',
        decided_by_type: 'human',
      },
      { rootDir: TEST_ROOT, now, onRejection: () => {} }
    );
    const reconciledBad = await reconcileDotSemanticFeedback(CHARTER, {
      rootDir: TEST_ROOT,
      now,
      recordDistillFeedback: (fb) => {
        emittedDistill.push({ action_ref: fb.action_ref, comment: fb.comment });
      },
    });
    expect(reconciledBad).toHaveLength(1);
    expect(reconciledBad[0]).toMatchObject({
      agree: false,
      false_apply: true,
      mismatch_kind: 'false_apply',
    });
    expect(emittedDistill).toHaveLength(1);
    expect(emittedDistill[0].action_ref).toBe('dact-bad-1');

    const demotedGate = evaluateDotProposalGate(CHARTER, PROPOSAL, {
      rootDir: TEST_ROOT,
      now,
      relaxableActions: ['dot_delegate_work'],
      gate: () => gate('approve'),
    });
    expect(demotedGate.gate.decision).toBe('approve');

    // Status and digest sections report metrics cleanly
    const status = dotSemanticJudgmentStatusSection().collect(CHARTER, { rootDir: TEST_ROOT, now });
    expect(status).toMatchObject({ false_apply_count: 1, relaxation_eligible: false });
    const digest = dotSemanticJudgmentDigestSection().lines(CHARTER, undefined, {
      rootDir: TEST_ROOT,
      now,
    });
    expect(digest[0]).toContain('Semantic judgment [advisory]');
    expect(digest[0]).toContain('1 false-apply');
  });

  it('auto-demotes on regressed execution outcomes and withholds relaxation when receipt is expired or unavailable', async () => {
    let clockMs = Date.parse('2026-11-27T10:00:00.000Z');
    const now = () => new Date(clockMs);
    const budget = createDotSemanticSharedBudgetPort({
      rootDir: TEST_ROOT,
      now,
      charter: CHARTER,
      dailyTokenCap: 20_000,
      readOrgDailyCap: () => 100_000,
    });

    // When no provider is configured, records diagnostic unavailable without throwing
    const noProvider = await observeLiveDotProposals(CHARTER, [PROPOSAL], {
      rootDir: TEST_ROOT,
      now,
      invoke: null,
    });
    expect(noProvider[0]).toMatchObject({ status: 'unavailable', budget_status: 'not_reserved' });
    expect(readDotSemanticJudgmentLedger(CHARTER, { rootDir: TEST_ROOT })).toHaveLength(1);

    // Build 5 clean reconciled approvals
    for (let i = 1; i <= 5; i++) {
      clockMs += 1_000;
      await observeLiveDotProposals(CHARTER, [PROPOSAL], {
        rootDir: TEST_ROOT,
        now,
        invoke: makePort('apply_precedent'),
        budget,
      });
      clockMs += 1_000;
      recordDotFeedback(
        {
          dot_id: CHARTER.dot_id,
          action_id: PROPOSAL.action_id,
          action_ref: `dact-out-${i}`,
          outcome: 'approved',
          title: PROPOSAL.title,
          decided_by: 'user:operator',
          decided_by_type: 'human',
        },
        { rootDir: TEST_ROOT, now }
      );
      await reconcileDotSemanticFeedback(CHARTER, { rootDir: TEST_ROOT, now });
    }

    const relaxer = dotSemanticJudgmentDecisionRelaxer();
    const ctx = { rootDir: TEST_ROOT, now };
    const gate = {
      actionId: PROPOSAL.action_id,
      decision: 'approve',
      allowed: false,
      score: 8,
      maxScore: 12,
      policyVersion: '1.2.0',
      executionMode: 'apply',
      reason: 'policy approve',
      axes: { scope: 1, reversibility: 1, sensitivity: 1, confidence: 1 },
      shadow: false,
      escalations: [],
      highRiskPathMatches: [],
    } as never;

    // Fresh receipt qualifies
    expect(relaxer.relax(CHARTER, PROPOSAL, gate, undefined, ctx)?.decision).toBe('notify');

    // Regressed execution outcome blocks relaxation
    const outcomesPath = path.join(TEST_ROOT, dotStatePath(CHARTER, DOT_OUTCOMES_FILE));
    safeMkdir(path.dirname(outcomesPath), { recursive: true });
    appendJsonLine(outcomesPath, {
      dot_id: CHARTER.dot_id,
      action_ref: 'dact-out-5',
      work_item_id: 'WITEM-1',
      ref: { signal: 'health' },
      verdict: 'regressed',
      due_at: now().toISOString(),
      measured_at: now().toISOString(),
    });
    expect(relaxer.relax(CHARTER, PROPOSAL, gate, undefined, ctx)).toBeUndefined();

    // Clean outcome file, advance past 5-min receipt TTL -> expired receipt is withheld
    safeWriteFile(outcomesPath, '');
    clockMs += 6 * 60_000;
    expect(relaxer.relax(CHARTER, PROPOSAL, gate, undefined, ctx)).toBeUndefined();
  });

  it('runs port warmup, enforces wake wall-clock budget, persists route meta, re-reconciles delayed regression, and compacts ledger rows', async () => {
    let clockMs = Date.parse('2026-11-28T00:00:00.000Z');
    const now = () => new Date(clockMs);
    const budget = createDotSemanticSharedBudgetPort({
      rootDir: TEST_ROOT,
      now,
      charter: CHARTER,
      dailyTokenCap: 50_000,
      readOrgDailyCap: () => 100_000,
    });

    const events: string[] = [];
    const callerPort: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: 'hybrid',
      model: 'laya-mlx+gpt-4o-mini',
      async warmup() {
        events.push('warmup');
        // Simulate warmup latency without eating per-wake budget checked after warmup
        clockMs += 5_000;
      },
      dispose() {
        events.push('dispose');
      },
      async invoke() {
        events.push('invoke');
        clockMs += 600;
        return {
          text: JSON.stringify({
            disposition: 'apply_precedent',
            rationale: 'Safe cleanup.',
            precedent_refs: [],
            risk_flags: [],
          }),
          usage: { input_tokens: 0, output_tokens: 0 },
          meta: {
            disposition: 'apply_precedent',
            confidence: 0.93,
            route: 'primary',
            route_reason: 'primary_confident',
          },
        };
      },
    };

    const tightCharter: DotCharter = {
      ...CHARTER,
      goal: {
        ...CHARTER.goal,
        budget: { token_cap_per_day: 50_000, wall_clock_ms_per_wake: 1_000 },
      },
    };
    const threeProposals = [
      PROPOSAL,
      { ...PROPOSAL, title: 'Second cache pass' },
      { ...PROPOSAL, title: 'Third cache pass' },
    ];
    const wakeRecords = await observeLiveDotProposals(tightCharter, threeProposals, {
      rootDir: TEST_ROOT,
      now,
      invoke: callerPort,
      budget,
    });
    expect(events).toEqual(['warmup', 'invoke', 'invoke']); // Caller-owned port is warmed up, never disposed
    expect(wakeRecords).toHaveLength(3);
    expect(wakeRecords[0]).toMatchObject({
      status: 'evaluated',
      route: 'primary',
      route_reason: 'primary_confident',
      confidence: 0.93,
    });
    expect(wakeRecords[1]).toMatchObject({
      status: 'unavailable',
      reason: 'deadline_exceeded',
    });
    expect(wakeRecords[2]).toMatchObject({
      status: 'unavailable',
      reason: 'deadline_exceeded',
      budget_status: 'not_reserved',
    });

    // Delayed outcome regression updates reconciliation without double-counting and emits distill
    clockMs += 1_000;
    recordDotFeedback(
      {
        dot_id: tightCharter.dot_id,
        action_id: PROPOSAL.action_id,
        action_ref: 'dact-delay-1',
        outcome: 'approved',
        title: PROPOSAL.title,
        decided_by: 'user:operator',
        decided_by_type: 'human',
      },
      { rootDir: TEST_ROOT, now }
    );
    const distill: string[] = [];
    const firstRec = await reconcileDotSemanticFeedback(tightCharter, {
      rootDir: TEST_ROOT,
      now,
      recordDistillFeedback: (fb) => {
        distill.push(fb.action_ref);
      },
    });
    expect(firstRec).toHaveLength(1);
    expect(firstRec[0]).toMatchObject({ agree: true, false_apply: false });
    expect(distill).toHaveLength(0);

    // Delayed regression arrives later
    const outcomesPath = path.join(TEST_ROOT, dotStatePath(tightCharter, DOT_OUTCOMES_FILE));
    safeMkdir(path.dirname(outcomesPath), { recursive: true });
    appendJsonLine(outcomesPath, {
      dot_id: tightCharter.dot_id,
      action_ref: 'dact-delay-1',
      work_item_id: 'WITEM-DELAY-1',
      ref: { signal: 'health' },
      verdict: 'regressed',
      due_at: now().toISOString(),
      measured_at: now().toISOString(),
    });
    const secondRec = await reconcileDotSemanticFeedback(tightCharter, {
      rootDir: TEST_ROOT,
      now,
      recordDistillFeedback: (fb) => {
        distill.push(fb.action_ref);
      },
    });
    expect(secondRec).toHaveLength(1);
    expect(secondRec[0]).toMatchObject({
      action_ref: 'dact-delay-1',
      execution_outcome: 'regressed',
      agree: false,
      false_apply: true,
    });
    expect(distill).toEqual(['dact-delay-1']);
    expect(latestReconciliationsByRef([firstRec[0], secondRec[0]])).toHaveLength(1);

    const metrics = dotSemanticJudgmentMetrics(tightCharter, { rootDir: TEST_ROOT, now });
    expect(metrics).toMatchObject({
      reconciled: 1,
      false_apply_count: 1,
      last_provider: 'hybrid',
      last_model: 'laya-mlx+gpt-4o-mini',
      primary_route_count: 2,
      fallback_route_count: 0,
      primary_route_rate: 1,
      relaxation_eligible: false,
    });
    expect(metrics.next_action).toContain('distill');
    const digest = dotSemanticJudgmentDigestSection().lines(tightCharter, undefined, {
      rootDir: TEST_ROOT,
      now,
    });
    expect(digest[0]).toContain('provider=hybrid');
    expect(digest[0]).toContain('route=2 primary/0 fallback');
    expect(digest[0]).toContain('Next:');

    // Compaction trims oversized ledger files back to DOT_SEMANTIC_LEDGER_MAX_ROWS
    const ledgerFile = path.join(
      TEST_ROOT,
      dotStatePath(tightCharter, DOT_SEMANTIC_JUDGMENT_LEDGER_FILE)
    );
    const seedLines = Array.from({ length: DOT_SEMANTIC_LEDGER_MAX_ROWS + 100 }, (_, idx) =>
      JSON.stringify({
        dot_id: tightCharter.dot_id,
        action_id: PROPOSAL.action_id,
        title: `Seed-${idx}`,
        proposal_hash: 'h',
        mode: 'advisory',
        status: 'unavailable',
        budget_status: 'not_reserved',
        recorded_at: now().toISOString(),
      })
    );
    safeWriteFile(ledgerFile, seedLines.join('\n') + '\n');
    await observeLiveDotProposals(
      {
        ...tightCharter,
        goal: {
          ...tightCharter.goal,
          budget: { token_cap_per_day: 50_000, wall_clock_ms_per_wake: 20_000 },
        },
      },
      [PROPOSAL],
      { rootDir: TEST_ROOT, now, invoke: callerPort, budget }
    );
    const compactedLines = String(safeReadFile(ledgerFile, { encoding: 'utf8' }))
      .trim()
      .split('\n');
    expect(compactedLines).toHaveLength(DOT_SEMANTIC_LEDGER_MAX_ROWS);
  });
});
