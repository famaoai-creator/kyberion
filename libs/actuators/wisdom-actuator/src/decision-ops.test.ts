import * as path from 'node:path';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import {
  safeMkdir,
  safeWriteFile,
  safeReadFile,
  pathResolver,
  safeExistsSync,
  registerReasoningBackend,
  buildFailoverReasoningBackend,
  resetReasoningBackend,
  resetVoiceBridge,
  stubReasoningBackend,
} from '@agent/core';
import {
  stakeholderGridSort,
  emitDissentLog,
  computeReadinessMatrix,
  recommend,
  resolveHypothesisConflict,
  evaluateDecisionRightsApprovalOp,
  findSlidesByOwner,
  pptxDiff,
  evaluateSimulationQuality,
  evaluateEnsembleConvergence,
  simulateAll,
  simulateAllEnsemble,
  generateFacilitationScriptOp,
  dispatchDecisionOp,
} from './decision-ops.js';

const TMP_ROOT = 'active/shared/tmp/decision-ops-tests';

function tmpPath(sub: string): { rel: string; abs: string } {
  const rel = path.posix.join(TMP_ROOT, sub);
  const abs = pathResolver.rootResolve(rel);
  safeMkdir(path.dirname(abs), { recursive: true });
  return { rel, abs };
}

describe('stakeholderGridSort', () => {
  it('orders High/High first, Low/Low last', () => {
    const input = [
      { person_slug: 'monitor_only', power_level: 'low', interest_level: 'low' },
      { person_slug: 'keep_informed', power_level: 'low', interest_level: 'high' },
      { person_slug: 'manage_closely', power_level: 'high', interest_level: 'high' },
      { person_slug: 'keep_satisfied', power_level: 'high', interest_level: 'low' },
    ];
    const sorted = stakeholderGridSort(input);
    expect(sorted.map((n) => n.person_slug)).toEqual([
      'manage_closely',
      'keep_satisfied',
      'keep_informed',
      'monitor_only',
    ]);
  });

  it('is stable for equal ranks and tolerates missing fields', () => {
    const input = [
      { person_slug: 'a' },
      { person_slug: 'b', power: 'high', interest: 'high' },
      { person_slug: 'c' },
    ];
    const sorted = stakeholderGridSort(input);
    expect(sorted[0].person_slug).toBe('b');
  });
});

describe('emitDissentLog', () => {
  let sourceRel: string;
  let outRel: string;

  beforeEach(() => {
    const src = tmpPath(`src-${Date.now()}-${Math.random()}.json`);
    const out = tmpPath(`out-${Date.now()}-${Math.random()}.json`);
    sourceRel = src.rel;
    outRel = out.rel;
    safeWriteFile(
      src.abs,
      JSON.stringify({
        topic: 'whether to migrate DB',
        hypotheses: [
          {
            id: 'H1',
            content: 'migrate now',
            proposed_by: 'Visionary',
            survived: true,
            status: 'survived',
          },
          {
            id: 'H2',
            content: 'delay 6 months',
            proposed_by: 'Auditor',
            survived: false,
            status: 'rejected',
            rejection_reason: 'cost',
            rejection_confidence: 'high',
          },
          {
            id: 'H3',
            content: 'do nothing',
            proposed_by: 'Pragmatic',
            survived: false,
            status: 'rejected',
            rejection_reason: 'debt grows',
            revisit_triggers: ['vendor EOL'],
          },
        ],
      })
    );
  });

  it('captures only rejected hypotheses with full provenance', () => {
    const result = emitDissentLog({
      source_path: sourceRel,
      output_path: outRel,
      mission_id: 'TEST-M',
      topic: 'migration',
    });
    expect(result.count).toBe(2);
    const payload = JSON.parse(
      safeReadFile(pathResolver.rootResolve(outRel), { encoding: 'utf8' }) as string
    );
    expect(payload.mission_id).toBe('TEST-M');
    expect(payload.dissents).toHaveLength(2);
    expect(payload.dissents[0]).toMatchObject({
      hypothesis: 'delay 6 months',
      proposed_by: 'Auditor',
      rejection_reason: 'cost',
      rejection_confidence: 'high',
    });
    expect(payload.dissents[1].revisit_triggers).toEqual(['vendor EOL']);
  });

  it('appends to an existing log when append flag is set', () => {
    emitDissentLog({
      source_path: sourceRel,
      output_path: outRel,
      mission_id: 'TEST-M',
      topic: 'first',
    });
    emitDissentLog({
      source_path: sourceRel,
      output_path: outRel,
      append: true,
      mission_id: 'TEST-M',
      topic: 'second',
    });
    const payload = JSON.parse(
      safeReadFile(pathResolver.rootResolve(outRel), { encoding: 'utf8' }) as string
    );
    expect(payload.dissents).toHaveLength(4);
  });
});

describe('computeReadinessMatrix + recommend', () => {
  const visitsDir = `${TMP_ROOT}/visits-${Date.now()}`;
  const matrixPath = `${visitsDir}/readiness.json`;

  beforeEach(() => {
    safeMkdir(pathResolver.rootResolve(visitsDir), { recursive: true });
    const write = (slug: string, stance: string) =>
      safeWriteFile(
        pathResolver.rootResolve(`${visitsDir}/${slug}.json`),
        JSON.stringify({
          person_slug: slug,
          visited_at: new Date().toISOString(),
          stance,
          conditions: [],
          dissent_signals: [],
        })
      );
    write('a', 'support');
    write('b', 'support');
    write('c', 'conditional');
  });

  it('produces a proceed recommendation for mostly-supportive room', () => {
    const result = computeReadinessMatrix({
      visits_dir: visitsDir,
      output_path: matrixPath,
    });
    expect(result.readiness_score).toBeGreaterThanOrEqual(70);
    expect(result.recommendation).toBe('proceed');
    expect(safeExistsSync(pathResolver.rootResolve(matrixPath))).toBe(true);
  });

  it('recommend() mirrors the matrix recommendation', () => {
    computeReadinessMatrix({ visits_dir: visitsDir, output_path: matrixPath });
    const rec = recommend({ readiness_ref: matrixPath });
    expect(rec.choice).toBe('proceed');
    expect(rec.reason).toMatch(/readiness_score=/);
  });

  it('flags redesign when most stakeholders oppose', () => {
    const opposedDir = `${TMP_ROOT}/opposed-${Date.now()}`;
    const opposedMatrix = `${opposedDir}/readiness.json`;
    safeMkdir(pathResolver.rootResolve(opposedDir), { recursive: true });
    const write = (slug: string, stance: string) =>
      safeWriteFile(
        pathResolver.rootResolve(`${opposedDir}/${slug}.json`),
        JSON.stringify({
          person_slug: slug,
          visited_at: new Date().toISOString(),
          stance,
        })
      );
    write('x', 'oppose');
    write('y', 'oppose');
    write('z', 'neutral');
    const result = computeReadinessMatrix({ visits_dir: opposedDir, output_path: opposedMatrix });
    expect(result.recommendation).toBe('redesign');
  });
});

// CO-04 Task 3: hypothesis-tree convergence (hypothesis-tree-protocol.md Phase
// C) must tie-break surviving hypotheses using the vision's golden-rule
// priority order, not an arbitrary pick.
describe('resolveHypothesisConflict', () => {
  const writeTree = (hypotheses: any[]) => {
    const { rel, abs } = tmpPath(`hypothesis-tree-${Date.now()}-${Math.random()}.json`);
    safeWriteFile(abs, JSON.stringify({ topic: 'test', hypotheses }));
    return rel;
  };

  it('passes through the sole survivor without flagging a conflict', () => {
    const sourceRel = writeTree([
      { id: 'H1', survived: true, golden_rule_dimension: 'execution_speed' },
      { id: 'H2', survived: false },
    ]);
    const { rel: outputRel } = tmpPath(`conflict-${Date.now()}.json`);
    const result = resolveHypothesisConflict({ source_path: sourceRel, output_path: outputRel });
    expect(result.conflict).toBe(false);
    expect(result.survivor_count).toBe(1);
    expect(result.winner_id).toBe('H1');
  });

  it('tie-breaks multiple survivors using the default golden-rule priority order', () => {
    const sourceRel = writeTree([
      { id: 'H-SPEED', survived: true, golden_rule_dimension: 'execution_speed' },
      { id: 'H-INTEGRITY', survived: true, golden_rule_dimension: 'logical_integrity' },
      { id: 'H-VISION', survived: true, golden_rule_dimension: 'vision_alignment' },
    ]);
    const { rel: outputRel, abs: outputAbs } = tmpPath(`conflict-${Date.now()}.json`);
    const result = resolveHypothesisConflict({ source_path: sourceRel, output_path: outputRel });
    expect(result.conflict).toBe(true);
    expect(result.survivor_count).toBe(3);
    // Logical Integrity outranks Vision Alignment and Execution Speed by default.
    expect(result.winner_id).toBe('H-INTEGRITY');
    expect(result.golden_rule_priority[0]).toBe('logical_integrity');
    const written = JSON.parse(safeReadFile(outputAbs, { encoding: 'utf8' }) as string);
    expect(written.winner_id).toBe('H-INTEGRITY');
  });

  it('ranks an untagged survivor last so omission cannot win by default', () => {
    const sourceRel = writeTree([
      { id: 'H-UNTAGGED', survived: true },
      { id: 'H-RESILIENCE', survived: true, golden_rule_dimension: 'adaptive_resilience' },
    ]);
    const { rel: outputRel } = tmpPath(`conflict-${Date.now()}.json`);
    const result = resolveHypothesisConflict({ source_path: sourceRel, output_path: outputRel });
    expect(result.conflict).toBe(true);
    // adaptive_resilience is the lowest ranked *named* dimension, but an
    // untagged candidate still ranks below it.
    expect(result.winner_id).toBe('H-RESILIENCE');
  });

  it("is deterministic for same-dimension ties (stable on the source array's order)", () => {
    const sourceRel = writeTree([
      { id: 'H-FIRST', survived: true, golden_rule_dimension: 'logical_integrity' },
      { id: 'H-SECOND', survived: true, golden_rule_dimension: 'logical_integrity' },
    ]);
    const { rel: outputRel } = tmpPath(`conflict-${Date.now()}.json`);
    const result = resolveHypothesisConflict({ source_path: sourceRel, output_path: outputRel });
    expect(result.winner_id).toBe('H-FIRST');
  });
});

describe('evaluateDecisionRightsApprovalOp (CO-05)', () => {
  it('requires operation_id, correlation_id, and decision_type', () => {
    expect(() =>
      evaluateDecisionRightsApprovalOp({
        operation_id: '',
        correlation_id: 'corr-1',
        decision_type: 'operational_spend',
      })
    ).toThrow('requires operation_id, correlation_id, and decision_type');
  });

  it('blocks operational_spend behind a real pending approval (knowledge/product/governance/decision-rights.json requires_human_acceptance)', () => {
    const correlationId = `co05-procurement-test-${Date.now()}-${Math.random()}`;
    const result = evaluateDecisionRightsApprovalOp({
      operation_id: 'procurement:test-vendor',
      correlation_id: correlationId,
      decision_type: 'operational_spend',
      channel: 'wisdom-decision-ops-test',
      amount: 100,
      title: 'Approval required: test-vendor procurement',
    });
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('pending');
    expect(result.request_id).toBeTruthy();
  });

  it('blocks headcount_expansion behind a real pending approval', () => {
    const correlationId = `co05-hiring-test-${Date.now()}-${Math.random()}`;
    const result = evaluateDecisionRightsApprovalOp({
      operation_id: 'hiring:test-role',
      correlation_id: correlationId,
      decision_type: 'headcount_expansion',
      channel: 'wisdom-decision-ops-test',
      amount: 1,
    });
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('pending');
    expect(result.request_id).toBeTruthy();
  });

  it('reuses the same pending request for a repeated correlation_id instead of creating a duplicate', () => {
    const correlationId = `co05-repeat-test-${Date.now()}-${Math.random()}`;
    const first = evaluateDecisionRightsApprovalOp({
      operation_id: 'procurement:repeat-vendor',
      correlation_id: correlationId,
      decision_type: 'operational_spend',
      channel: 'wisdom-decision-ops-test',
    });
    const second = evaluateDecisionRightsApprovalOp({
      operation_id: 'procurement:repeat-vendor',
      correlation_id: correlationId,
      decision_type: 'operational_spend',
      channel: 'wisdom-decision-ops-test',
    });
    expect(second.allowed).toBe(false);
    expect(second.request_id).toBe(first.request_id);
  });

  it('allows an unregistered decision_type through when no policy or matrix entry matches', () => {
    const correlationId = `co05-unregistered-test-${Date.now()}-${Math.random()}`;
    const result = evaluateDecisionRightsApprovalOp({
      operation_id: 'noop:unregistered-decision-type',
      correlation_id: correlationId,
      decision_type: 'not-a-registered-decision-type',
      channel: 'wisdom-decision-ops-test',
    });
    expect(result.allowed).toBe(true);
    expect(result.status).toBe('not_required');
  });
});

describe('findSlidesByOwner', () => {
  const slides = [
    { slide_index: 1, concatenated: 'Cover page', text_runs: ['Cover', 'page'] },
    {
      slide_index: 2,
      concatenated: 'Financials — owner_a',
      text_runs: ['Financials —', 'owner_a'],
    },
    { slide_index: 3, concatenated: 'Clients — owner_a', text_runs: ['Clients —', 'owner_a'] },
    { slide_index: 4, concatenated: 'Reorg — owner_b', text_runs: ['Reorg —', 'owner_b'] },
  ];

  it('returns slides whose text contains the owner label', () => {
    const result = findSlidesByOwner({ slides, owner_labels: ['owner_a'] });
    expect(result.indices).toEqual([2, 3]);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({ slide_index: 2, matched_label: 'owner_a' });
  });

  it('supports multiple labels (OR semantics)', () => {
    const result = findSlidesByOwner({ slides, owner_labels: ['owner_b', 'owner_a'] });
    expect(result.indices).toEqual([2, 3, 4]);
  });

  it('run_exact mode requires an exact <a:t> run, not substring', () => {
    const substring = findSlidesByOwner({
      slides,
      owner_labels: ['owner'],
      match_mode: 'substring',
    });
    expect(substring.indices).toEqual([2, 3, 4]);

    const runExact = findSlidesByOwner({
      slides,
      owner_labels: ['owner'],
      match_mode: 'run_exact',
    });
    expect(runExact.indices).toEqual([]);
  });

  it('returns empty result when no slide matches', () => {
    const result = findSlidesByOwner({ slides, owner_labels: ['not_present'] });
    expect(result.indices).toEqual([]);
    expect(result.matches).toEqual([]);
  });
});

describe('pptxDiff', () => {
  it('classifies slides into added/removed/changed/unchanged', () => {
    const before = [
      { slide_index: 1, text_runs: ['a', 'b'] },
      { slide_index: 2, text_runs: ['unchanged'] },
      { slide_index: 3, text_runs: ['to-remove'] },
    ];
    const after = [
      { slide_index: 1, text_runs: ['a', 'b', 'new'] },
      { slide_index: 2, text_runs: ['unchanged'] },
      { slide_index: 4, text_runs: ['brand-new'] },
    ];
    const diff = pptxDiff({ before, after });
    expect(diff.unchanged).toEqual([2]);
    expect(diff.added).toEqual([4]);
    expect(diff.removed).toEqual([3]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({
      slide_index: 1,
      added_runs: ['new'],
      removed_runs: [],
    });
  });

  it('handles empty inputs gracefully', () => {
    const diff = pptxDiff({ before: [], after: [] });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });
});

describe('generateFacilitationScriptOp', () => {
  afterEach(() => {
    resetReasoningBackend();
  });

  it('uses best-of-N and judge selection for facilitation utterances', async () => {
    const delegateTask = vi.fn().mockImplementation((instruction: string) => {
      if (instruction.includes('candidate 1/2')) {
        return Promise.resolve(
          JSON.stringify({
            speech_text: 'Let us review the agenda.',
            next_action: 'continue_listen',
          })
        );
      }
      if (instruction.includes('candidate 2/2')) {
        return Promise.resolve(
          JSON.stringify({
            speech_text: 'Please choose the next topic.',
            next_action: 'transition_topic',
          })
        );
      }
      return Promise.resolve(
        JSON.stringify({ winner_index: 1, rationale: 'clearer and more directive' })
      );
    });

    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'best-of-test',
      delegateTask,
    });

    const result = await generateFacilitationScriptOp({
      facilitator_persona_label: 'moderator',
      current_topic: 'status',
      recent_transcript_chunk: 'We are still on the first topic.',
      language: 'en',
    });

    expect(result).toEqual({
      speech_text: 'Please choose the next topic.',
      next_action: 'transition_topic',
    });
    expect(delegateTask).toHaveBeenCalledTimes(3);
  });
});

describe('evaluateSimulationQuality', () => {
  const mkBranch = (
    over: Partial<{
      branch_id: string;
      hypothesis_ref: string;
      first_failure_mode: string | null;
      first_success_mode: string | null;
      terminated_at_step: number | null;
    }> = {}
  ) => ({
    branch_id: over.branch_id ?? 'B-1',
    hypothesis_ref: over.hypothesis_ref ?? 'H-1',
    first_failure_mode: over.first_failure_mode ?? null,
    first_success_mode: over.first_success_mode ?? null,
    terminated_at_step: over.terminated_at_step ?? null,
  });

  it('reports ok for a balanced, terminated 3-branch simulation', () => {
    const report = evaluateSimulationQuality({
      goal: 'g',
      branches: [
        mkBranch({ branch_id: 'B-1', first_failure_mode: 'cost too high', terminated_at_step: 3 }),
        mkBranch({ branch_id: 'B-2', first_success_mode: 'launched', terminated_at_step: 5 }),
        mkBranch({
          branch_id: 'B-3',
          first_failure_mode: 'compliance reject',
          terminated_at_step: 2,
        }),
      ],
    });
    expect(report.severity).toBe('ok');
    expect(report.branch_count).toBe(3);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it('reports poor when zero branches', () => {
    const report = evaluateSimulationQuality({ goal: 'g', branches: [] });
    expect(report.severity).toBe('poor');
    expect(report.checks.find((c) => c.id === 'has_branches')!.passed).toBe(false);
  });

  it('reports poor on duplicate branch ids', () => {
    const report = evaluateSimulationQuality({
      goal: 'g',
      branches: [
        mkBranch({ branch_id: 'B-1', first_failure_mode: 'a', terminated_at_step: 1 }),
        mkBranch({ branch_id: 'B-1', first_success_mode: 'b', terminated_at_step: 2 }),
      ],
    });
    expect(report.severity).toBe('poor');
    expect(report.checks.find((c) => c.id === 'unique_branch_ids')!.passed).toBe(false);
  });

  it('reports poor when a branch reports both failure and success modes', () => {
    const report = evaluateSimulationQuality({
      goal: 'g',
      branches: [
        mkBranch({
          branch_id: 'B-1',
          first_failure_mode: 'x',
          first_success_mode: 'y',
          terminated_at_step: 1,
        }),
      ],
    });
    expect(report.severity).toBe('poor');
    expect(report.checks.find((c) => c.id === 'failure_xor_success')!.passed).toBe(false);
  });

  it('warns when no branch reaches a terminal mode', () => {
    const report = evaluateSimulationQuality({
      goal: 'g',
      branches: [mkBranch({ branch_id: 'B-1' }), mkBranch({ branch_id: 'B-2' })],
    });
    expect(report.severity).toBe('warn');
    expect(report.checks.find((c) => c.id === 'reaches_terminal_mode')!.passed).toBe(false);
  });

  it('warns when 3+ terminated branches share an outcome', () => {
    const report = evaluateSimulationQuality({
      goal: 'g',
      branches: [
        mkBranch({ branch_id: 'B-1', first_failure_mode: 'a', terminated_at_step: 1 }),
        mkBranch({ branch_id: 'B-2', first_failure_mode: 'b', terminated_at_step: 2 }),
        mkBranch({ branch_id: 'B-3', first_failure_mode: 'c', terminated_at_step: 3 }),
      ],
    });
    expect(report.severity).toBe('warn');
    expect(report.checks.find((c) => c.id === 'outcome_balance')!.passed).toBe(false);
  });

  it('warns on zero-step terminations', () => {
    const report = evaluateSimulationQuality({
      goal: 'g',
      branches: [
        mkBranch({ branch_id: 'B-1', first_failure_mode: 'gave up', terminated_at_step: 0 }),
      ],
    });
    expect(report.severity).toBe('warn');
    expect(report.checks.find((c) => c.id === 'non_trivial_termination_depth')!.passed).toBe(false);
  });
});

describe('evaluateEnsembleConvergence (IP-4)', () => {
  const branch = (id: string, outcome: 'failure' | 'success' | 'pending') => ({
    branch_id: id,
    hypothesis_ref: `H-${id}`,
    first_failure_mode: outcome === 'failure' ? 'mode-x' : null,
    first_success_mode: outcome === 'success' ? 'mode-y' : null,
    terminated_at_step: outcome === 'pending' ? null : 1,
  });

  it('returns severity ok when all 3 runs agree on every branch', () => {
    const runs = [
      { branches: [branch('B-1', 'failure'), branch('B-2', 'success')] },
      { branches: [branch('B-1', 'failure'), branch('B-2', 'success')] },
      { branches: [branch('B-1', 'failure'), branch('B-2', 'success')] },
    ];
    const report = evaluateEnsembleConvergence({ runs });
    expect(report.severity).toBe('ok');
    expect(report.mean_convergence).toBe(1);
    expect(report.divergent_outcomes_warning).toBe(false);
    expect(report.per_branch.find((b) => b.branch_id === 'B-1')!.dominant_outcome).toBe('failure');
  });

  it('returns warn when one branch flips outcome across runs', () => {
    const runs = [
      { branches: [branch('B-1', 'failure'), branch('B-2', 'success')] },
      { branches: [branch('B-1', 'success'), branch('B-2', 'success')] },
      { branches: [branch('B-1', 'failure'), branch('B-2', 'success')] },
    ];
    const report = evaluateEnsembleConvergence({ runs, threshold: 0.9 });
    expect(report.severity).not.toBe('ok');
    expect(report.divergent_outcomes_warning).toBe(true);
    const b1 = report.per_branch.find((b) => b.branch_id === 'B-1')!;
    expect(b1.outcome_counts).toEqual({ failure: 2, success: 1, pending: 0 });
    expect(b1.convergence).toBeCloseTo(2 / 3, 2);
  });

  it('returns poor when there are no branches at all', () => {
    const report = evaluateEnsembleConvergence({ runs: [{ branches: [] }] });
    expect(report.severity).toBe('poor');
  });

  it('marks dominant_outcome as tie on equal counts', () => {
    const runs = [
      { branches: [branch('B-1', 'failure')] },
      { branches: [branch('B-1', 'success')] },
    ];
    const report = evaluateEnsembleConvergence({ runs });
    const b1 = report.per_branch.find((b) => b.branch_id === 'B-1')!;
    expect(b1.dominant_outcome).toBe('tie');
  });

  it('uses default threshold 0.6 when none provided', () => {
    const runs = [
      { branches: [branch('B-1', 'failure')] },
      { branches: [branch('B-1', 'success')] },
    ];
    const report = evaluateEnsembleConvergence({ runs });
    expect(report.threshold).toBe(0.6);
  });
});

describe('simulateAll', () => {
  afterEach(() => {
    resetReasoningBackend();
  });

  it('retries once with a larger branch budget when the first run is poor', async () => {
    const simulateBranches = vi.fn().mockImplementation(async (input: any) => {
      if ((input.maxStepsPerBranch ?? 0) < 12) {
        return { branches: [] };
      }
      return {
        branches: [
          {
            branch_id: 'B-1',
            hypothesis_ref: 'H-1',
            first_failure_mode: null,
            first_success_mode: 'completed',
            terminated_at_step: 4,
          },
        ],
      };
    });

    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'simulate-retry-test',
      simulateBranches,
    });

    const outputDir = tmpPath(`simulate-${Date.now()}-${Math.random()}`).rel;
    const result = await simulateAll({
      goal: 'ship the change',
      output_dir: outputDir,
      max_steps_per_branch: 10,
    });

    expect(simulateBranches).toHaveBeenCalledTimes(2);
    expect(result.quality_retry_count).toBe(1);
    expect(result.quality_severity).toBe('ok');
    expect(result.max_steps_per_branch).toBeGreaterThan(10);
    const summary = JSON.parse(
      safeReadFile(pathResolver.rootResolve(result.written_to), { encoding: 'utf8' }) as string
    );
    expect(summary.max_steps_per_branch).toBeGreaterThan(10);
  });
});

describe('simulateAllEnsemble', () => {
  afterEach(() => {
    resetReasoningBackend();
  });

  it('retries once with a larger run budget when convergence is poor', async () => {
    let callCount = 0;
    const simulateBranches = vi.fn().mockImplementation(async () => {
      callCount += 1;
      const branchId = callCount <= 3 ? `B-${callCount}` : 'B-1';
      return {
        branches: [
          {
            branch_id: branchId,
            hypothesis_ref: 'H-1',
            first_failure_mode: null,
            first_success_mode: 'mode-y',
            terminated_at_step: 1,
          },
        ],
      };
    });

    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'ensemble-retry-test',
      simulateBranches,
    });

    const outputDir = tmpPath(`ensemble-${Date.now()}-${Math.random()}`).rel;
    const result = await simulateAllEnsemble({
      goal: 'ship the change',
      output_dir: outputDir,
      runs: 3,
      convergence_threshold: 0.9,
    });

    expect(result.retry_count).toBe(1);
    expect(result.convergence_severity).toBe('ok');
    expect(simulateBranches).toHaveBeenCalledTimes(8);
  });
});

describe("dispatchDecisionOp 'distill' (memory-distillation op)", () => {
  it('is handled and emits non-empty lessons into the produces channel', async () => {
    // run_pipeline bridges produces.channel → params.export_as; simulate that.
    const result = await dispatchDecisionOp(
      'distill',
      { scope: 'recent_missions', export_as: 'lessons_learned' },
      {}
    );
    expect(result.handled).toBe(true);
    expect(typeof result.ctx.lessons_learned).toBe('string');
    expect((result.ctx.lessons_learned as string).length).toBeGreaterThan(0);
  });
});

describe("dispatchDecisionOp 'curate_background_review'", () => {
  it('routes the archive-only curator through the typed wisdom op', async () => {
    const result = await dispatchDecisionOp(
      'curate_background_review',
      { max_age_days: 7, limit: 1, dry_run: true, export_as: 'curator_result' },
      {}
    );
    expect(result.handled).toBe(true);
    expect(result.ctx.curator_result).toMatchObject({
      scanned: expect.any(Number),
      archived: [],
      would_archive: expect.any(Array),
    });
  });
});

describe("dispatchDecisionOp 'peer_advice'", () => {
  it('uses a peer backend when a failover candidate is available', async () => {
    const calls: string[] = [];
    registerReasoningBackend(
      buildFailoverReasoningBackend([
        {
          label: 'primary',
          provider: 'codex',
          backend: {
            ...stubReasoningBackend,
            delegateTask: async () => {
              calls.push('primary');
              return JSON.stringify({
                advisor_label: 'primary',
                recommendation: 'stay on course',
                risks: [],
                follow_up_questions: [],
                confidence: 'low',
              });
            },
          },
        },
        {
          label: 'peer',
          provider: 'gemini',
          backend: {
            ...stubReasoningBackend,
            delegateTask: async (instruction: string) => {
              calls.push('peer');
              expect(instruction).toContain('Question:');
              return JSON.stringify({
                advisor_label: 'peer',
                advisor_provider: 'gemini',
                recommendation: 'ask for an explicit trade-off',
                risks: ['scope creep'],
                follow_up_questions: ['what is the smallest useful answer?'],
                confidence: 'high',
              });
            },
          },
        },
      ])
    );

    const result = await dispatchDecisionOp(
      'peer_advice',
      {
        question: 'Should we split the task?',
        context: 'The task is high risk and ambiguous.',
        export_as: 'advice',
      },
      {}
    );

    expect(result.handled).toBe(true);
    expect(calls).toEqual(['peer']);
    expect(result.ctx.advice).toMatchObject({
      advisor_label: 'peer',
      advisor_provider: 'gemini',
      recommendation: 'ask for an explicit trade-off',
      peer_used: true,
    });
  });
});

describe('reasoning_mode visibility', () => {
  beforeEach(() => {
    resetReasoningBackend();
    resetVoiceBridge();
  });

  it('tags wisdom outputs as placeholder when the stub backend/bridge is used', async () => {
    const fanoutOut = tmpPath(`fanout-${Date.now()}.json`).rel;
    const roleplayOut = tmpPath(`roleplay-${Date.now()}.json`).rel;

    const fanout = await dispatchDecisionOp(
      'a2a_fanout',
      {
        personas: ['auditor', 'operator'],
        min_hypotheses_per_persona: 1,
        topic: 'scope check',
        output_path: fanoutOut,
        export_as: 'fanout',
      },
      {}
    );
    expect(fanout.handled).toBe(true);
    expect(fanout.ctx.fanout.reasoning_mode).toBe('placeholder');
    expect(
      JSON.parse(safeReadFile(pathResolver.rootResolve(fanoutOut), { encoding: 'utf8' }) as string)
        .reasoning_mode
    ).toBe('placeholder');

    const roleplay = await dispatchDecisionOp(
      'a2a_roleplay',
      {
        persona: { identity: { label: 'counterparty' } },
        objective: 'confirm requirements',
        time_budget_minutes: 5,
        output_path: roleplayOut,
        export_as: 'roleplay',
      },
      {}
    );
    expect(roleplay.handled).toBe(true);
    expect(roleplay.ctx.roleplay.reasoning_mode).toBe('placeholder');
    expect(
      JSON.parse(
        safeReadFile(pathResolver.rootResolve(roleplayOut), { encoding: 'utf8' }) as string
      ).reasoning_mode
    ).toBe('placeholder');
  });
});

describe("dispatchDecisionOp 'derive_test_inventory'", () => {
  it('writes deterministic QA viewpoints through the wisdom actuator', async () => {
    resetReasoningBackend();
    const contract = tmpPath(`quality-contract-${Date.now()}.json`);
    const output = tmpPath(`test-inventory-${Date.now()}.json`);
    safeWriteFile(
      contract.abs,
      JSON.stringify({
        version: '1.0.0',
        project_id: 'project-1',
        accountable_human_id: 'human:owner',
        must_have_requirement_ids: ['REQ-1'],
        dor: [{ check_id: 'DOR-1', description: 'Ready', status: 'pending' }],
        acceptance_criteria: [
          {
            criterion_id: 'AC-1',
            description: 'Returns 200',
            requirement_refs: ['REQ-1'],
            expected_result: '200',
            status: 'pending',
          },
        ],
        dod: [{ check_id: 'DOD-1', description: 'Done', status: 'pending' }],
      })
    );
    const result = await dispatchDecisionOp(
      'derive_test_inventory',
      {
        contract_path: contract.rel,
        output_path: output.rel,
        system_tags: ['api', 'ai'],
        risk_refs: ['RISK-1'],
        export_as: 'inventory',
      },
      {}
    );
    expect(result.handled).toBe(true);
    expect(result.ctx.inventory.items.length).toBeGreaterThan(0);
    const written = JSON.parse(safeReadFile(output.abs, { encoding: 'utf8' }) as string);
    expect(written.items.flatMap((item: any) => item.viewpoint_ids)).toContain(
      'security.trust-boundary'
    );
  });
});

describe('typed participant wisdom operations', () => {
  beforeEach(() => {
    resetReasoningBackend();
  });

  const participant = (id: string, tenant = 'tenant-a') => ({
    participant_id: id,
    organization_role_id: 'cyber_security',
    team_role_id: 'reviewer',
    perspective_ids: ['security_attacker'],
    agent_profile_id: 'reasoning-worker',
    authority_role_id: 'ecosystem_architect',
    reasoning_route_id: 'local-test',
    security_scope: {
      tenant_id: tenant,
      project_id: 'project-x',
      mission_id: 'MSN-TYPED-WISDOM',
      participant_id: id,
      read_tiers: ['public', 'confidential'],
      write_tier: 'confidential',
      purpose: 'security-review',
      external_egress: 'deny',
    },
  });

  it('filters context per participant and persists a scope receipt', async () => {
    const output = tmpPath(`typed-fanout-${Date.now()}.json`).rel;
    const result = await dispatchDecisionOp(
      'perspective_fanout',
      {
        participants: [participant('security-review')],
        context_fragments: [
          {
            fragment_id: 'MATCH',
            source_ref: 'knowledge/confidential/tenant-a/project-x/review.md',
            source_tier: 'confidential',
            tenant_id: 'tenant-a',
            project_id: 'project-x',
            mission_id: 'MSN-TYPED-WISDOM',
            purpose_tags: ['security-review'],
            content: 'allowed',
          },
          {
            fragment_id: 'OTHER-TENANT',
            source_ref: 'knowledge/confidential/tenant-b/project-x/review.md',
            source_tier: 'confidential',
            tenant_id: 'tenant-b',
            project_id: 'project-x',
            mission_id: 'MSN-TYPED-WISDOM',
            purpose_tags: ['security-review'],
            content: 'denied',
          },
        ],
        min_hypotheses_per_participant: 1,
        topic: 'typed scope check',
        output_path: output,
        output_tier: 'confidential',
        export_as: 'typed_fanout',
      },
      {}
    );

    expect(result.handled).toBe(true);
    const payload = JSON.parse(
      safeReadFile(pathResolver.rootResolve(output), { encoding: 'utf8' }) as string
    );
    expect(payload.operation).toBe('perspective_fanout');
    expect(payload.participant_receipts[0]).toMatchObject({
      participant_id: 'security-review',
      backend_name: 'stub',
      accepted_fragment_ids: ['MATCH'],
      rejected_fragments: [{ fragment_id: 'OTHER-TENANT', code: 'TENANT_SCOPE_MISMATCH' }],
    });
    expect(payload.hypotheses[0]).toMatchObject({
      participant_id: 'security-review',
      proposed_by: 'security-review',
      perspective_ids: ['security_attacker'],
    });
  });

  it('blocks lower-tier output and cross-tenant critique projection', async () => {
    const fanoutOutput = tmpPath(`typed-fanout-guard-${Date.now()}.json`).rel;
    await expect(
      dispatchDecisionOp(
        'perspective_fanout',
        {
          participants: [participant('security-review')],
          context_fragments: [
            {
              fragment_id: 'CONFIDENTIAL',
              source_ref: 'knowledge/confidential/tenant-a/project-x/review.md',
              source_tier: 'confidential',
              tenant_id: 'tenant-a',
              project_id: 'project-x',
              mission_id: 'MSN-TYPED-WISDOM',
              purpose_tags: ['security-review'],
              content: 'sensitive',
            },
          ],
          topic: 'downflow check',
          output_path: fanoutOutput,
          output_tier: 'public',
        },
        {}
      )
    ).rejects.toThrow('[CONTEXT_TIER_DOWNFLOW]');

    await dispatchDecisionOp(
      'perspective_fanout',
      {
        participants: [participant('security-review')],
        min_hypotheses_per_participant: 1,
        topic: 'critique scope check',
        output_path: fanoutOutput,
        output_tier: 'confidential',
      },
      {}
    );
    await expect(
      dispatchDecisionOp(
        'typed_cross_critique',
        {
          source_path: fanoutOutput,
          participants: [participant('other-review', 'tenant-b')],
          output_path: tmpPath(`typed-critique-${Date.now()}.json`).rel,
          output_tier: 'confidential',
        },
        {}
      )
    ).rejects.toThrow('[CROSS_CRITIQUE_SCOPE_DENIED]');
  });
});
