import * as path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { safeMkdir, safeWriteFile, safeReadFile, pathResolver, safeExistsSync } from '@agent/core';
import {
  stakeholderGridSort,
  emitDissentLog,
  computeReadinessMatrix,
  recommend,
  findSlidesByOwner,
  pptxDiff,
  evaluateSimulationQuality,
  evaluateEnsembleConvergence,
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
    safeWriteFile(src.abs, JSON.stringify({
      topic: 'whether to migrate DB',
      hypotheses: [
        { id: 'H1', content: 'migrate now', proposed_by: 'Visionary', survived: true, status: 'survived' },
        { id: 'H2', content: 'delay 6 months', proposed_by: 'Auditor', survived: false, status: 'rejected', rejection_reason: 'cost', rejection_confidence: 'high' },
        { id: 'H3', content: 'do nothing', proposed_by: 'Pragmatic', survived: false, status: 'rejected', rejection_reason: 'debt grows', revisit_triggers: ['vendor EOL'] },
      ],
    }));
  });

  it('captures only rejected hypotheses with full provenance', () => {
    const result = emitDissentLog({ source_path: sourceRel, output_path: outRel, mission_id: 'TEST-M', topic: 'migration' });
    expect(result.count).toBe(2);
    const payload = JSON.parse(safeReadFile(pathResolver.rootResolve(outRel), { encoding: 'utf8' }) as string);
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
    emitDissentLog({ source_path: sourceRel, output_path: outRel, mission_id: 'TEST-M', topic: 'first' });
    emitDissentLog({ source_path: sourceRel, output_path: outRel, append: true, mission_id: 'TEST-M', topic: 'second' });
    const payload = JSON.parse(safeReadFile(pathResolver.rootResolve(outRel), { encoding: 'utf8' }) as string);
    expect(payload.dissents).toHaveLength(4);
  });
});

describe('computeReadinessMatrix + recommend', () => {
  const visitsDir = `${TMP_ROOT}/visits-${Date.now()}`;
  const matrixPath = `${visitsDir}/readiness.json`;

  beforeEach(() => {
    safeMkdir(pathResolver.rootResolve(visitsDir), { recursive: true });
    const write = (slug: string, stance: string) =>
      safeWriteFile(pathResolver.rootResolve(`${visitsDir}/${slug}.json`), JSON.stringify({
        person_slug: slug,
        visited_at: new Date().toISOString(),
        stance,
        conditions: [],
        dissent_signals: [],
      }));
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
      safeWriteFile(pathResolver.rootResolve(`${opposedDir}/${slug}.json`), JSON.stringify({
        person_slug: slug, visited_at: new Date().toISOString(), stance,
      }));
    write('x', 'oppose');
    write('y', 'oppose');
    write('z', 'neutral');
    const result = computeReadinessMatrix({ visits_dir: opposedDir, output_path: opposedMatrix });
    expect(result.recommendation).toBe('redesign');
  });
});

describe('findSlidesByOwner', () => {
  const slides = [
    { slide_index: 1, concatenated: 'Cover page', text_runs: ['Cover', 'page'] },
    { slide_index: 2, concatenated: 'Financials — owner_a', text_runs: ['Financials —', 'owner_a'] },
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
    const substring = findSlidesByOwner({ slides, owner_labels: ['owner'], match_mode: 'substring' });
    expect(substring.indices).toEqual([2, 3, 4]);

    const runExact = findSlidesByOwner({ slides, owner_labels: ['owner'], match_mode: 'run_exact' });
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

describe('evaluateSimulationQuality', () => {
  const mkBranch = (over: Partial<{
    branch_id: string;
    hypothesis_ref: string;
    first_failure_mode: string | null;
    first_success_mode: string | null;
    terminated_at_step: number | null;
  }> = {}) => ({
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
        mkBranch({ branch_id: 'B-3', first_failure_mode: 'compliance reject', terminated_at_step: 2 }),
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
        mkBranch({ branch_id: 'B-1', first_failure_mode: 'x', first_success_mode: 'y', terminated_at_step: 1 }),
      ],
    });
    expect(report.severity).toBe('poor');
    expect(report.checks.find((c) => c.id === 'failure_xor_success')!.passed).toBe(false);
  });

  it('warns when no branch reaches a terminal mode', () => {
    const report = evaluateSimulationQuality({
      goal: 'g',
      branches: [
        mkBranch({ branch_id: 'B-1' }),
        mkBranch({ branch_id: 'B-2' }),
      ],
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
