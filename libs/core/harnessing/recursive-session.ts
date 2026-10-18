/**
 * Multi-round contrastive recursion (harness2 import): each round probes
 * candidate overlays on the current base; an auto_advance winner is
 * materialized onto the base and becomes the next round's base.
 * keep_base/decline stop early; human_gate halts with the blind
 * recommendation — judgment never auto-progresses to a next round.
 *
 * Budget identity (harness2 ledger wisdom): the session declares its round
 * budget up front, asserts unique run labels BEFORE counting probes
 * (duplicates can satisfy a count while meaning nothing), and reports
 * expected vs actual probes.
 */

import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeCopyFileSync,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { ledger } from '../ledger.js';
import { nowIso } from '../foundation/time.js';
import { runProbe, type RunOutcome } from './probe-runner.js';
import { classifyProbeSet, type DecisionReport, type MetricSpec } from './decision-axis.js';
import { validateOverlay, type SurfaceSpec } from './surface-spec.js';
import { proposeCandidates } from './propose.js';
import {
  applyBlindSelection,
  metricsFallbackSelector,
  type BlindRecommendation,
  type BlindSelector,
} from './blind-select.js';

export interface RecursiveSessionSpec {
  session_id: string;
  scenarioDir: string;
  command: string[];
  /** Per-round candidate overlays (same set each round). */
  candidates?: Array<{ label: string; overlayDir: string }>;
  /** LLM propose per round (requires surface). */
  propose?: { brief: string; count: number; labelPrefix?: string };
  surface?: SurfaceSpec;
  /** Max rounds. 1 = single-shot. */
  rounds: number;
  selection?: 'blind';
  seed?: number;
  selector?: BlindSelector;
  expectOutputs?: string[];
  metrics?: MetricSpec[];
  runRoot: string;
  work_shape?: string;
  timeoutMs?: number;
}

export interface RoundRecord {
  round: number;
  base_dir: string;
  decision: DecisionReport;
  selection: BlindRecommendation | null;
  outcomes: RunOutcome[];
  rejected: Array<{ label: string; path: string; reason: string }>;
}

export interface RecursiveSessionResult {
  report_path: string;
  rounds: RoundRecord[];
  final_decision: DecisionReport;
  adopted_overlays: string[];
  halted_by: 'budget' | 'human_gate' | 'keep_base' | 'decline' | 'auto_advance_final';
  budget: { expected_probes: number; actual_probes: number; status: 'ok' | 'short' | 'exceeded' };
}

function copyTreeInto(src: string, dst: string): void {
  safeMkdir(dst, { recursive: true });
  for (const entry of safeReaddir(src)) {
    const s = path.join(src, entry);
    const d = path.join(dst, entry);
    const stat = safeLstat(s);
    if (stat.isDirectory()) copyTreeInto(s, d);
    else if (stat.isFile()) safeCopyFileSync(s, d);
  }
}

export async function runRecursiveSession(
  spec: RecursiveSessionSpec
): Promise<RecursiveSessionResult> {
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  safeMkdir(runRoot, { recursive: true });
  if (!Number.isInteger(spec.rounds) || spec.rounds < 1 || spec.rounds > 10) {
    throw new Error('[RECURSIVE_SESSION] rounds must be an integer 1..10');
  }
  const labels = (spec.candidates ?? []).map((c) => c.label);
  for (const label of labels) {
    if (label === 'base' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label)) {
      throw new Error(`[RECURSIVE_SESSION] invalid candidate label ${JSON.stringify(label)}`);
    }
  }
  if (new Set(labels).size !== labels.length) {
    throw new Error('[RECURSIVE_SESSION] duplicate candidate labels');
  }
  if (!labels.length && !spec.propose) {
    throw new Error('[RECURSIVE_SESSION] candidates or --propose required');
  }

  const rejected: Array<{ label: string; path: string; reason: string }> = [];
  // Surface-validate supplied overlays once (rounds reuse them).
  const supplied = (spec.candidates ?? []).filter((c) => {
    if (!spec.surface) return true;
    try {
      const v = validateOverlay(c.overlayDir, spec.surface);
      if (v.ok) return true;
      rejected.push(
        ...v.rejected_files.map((r) => ({ label: c.label, path: r.path, reason: r.reason }))
      );
      return false;
    } catch (error) {
      rejected.push({
        label: c.label,
        path: '.',
        reason: `overlay invalid: ${error instanceof Error ? error.message : error}`,
      });
      return false;
    }
  });

  const rounds: RoundRecord[] = [];
  const adopted: string[] = [];
  let currentBase = spec.scenarioDir;
  let halted: RecursiveSessionResult['halted_by'] = 'budget';
  let actualProbes = 0;
  let expectedProbes = 0;
  let finalDecision: DecisionReport | null = null;

  for (let round = 1; round <= spec.rounds; round++) {
    const roundRoot = path.join(runRoot, `round-${round}`);
    // Round-scoped run dirs: no cross-round or cross-session contamination.
    const candidates = [...supplied];
    if (spec.propose && spec.surface) {
      const proposed = await proposeCandidates({
        brief: spec.propose.brief,
        surface: spec.surface,
        count: spec.propose.count,
        outDir: path.join(roundRoot, '_proposed'),
        labelPrefix: spec.propose.labelPrefix,
      });
      rejected.push(...proposed.rejected.map((r) => ({ ...r, label: `r${round}:${r.label}` })));
      candidates.push(
        ...proposed.candidates.map((c) => ({ label: c.label, overlayDir: c.overlayDir }))
      );
    }

    // Budget identity: check duplicate labels BEFORE counting probes.
    const roundLabels = candidates.map((c) => c.label);
    if (new Set(roundLabels).size !== roundLabels.length) {
      throw new Error(
        `[BUDGET_IDENTITY] duplicate labels in round ${round}: ${roundLabels.join(', ')}`
      );
    }
    expectedProbes += candidates.length + (candidates.length ? 1 : 0);

    const probeFor = (label: string, overlayDir?: string): RunOutcome =>
      runProbe({
        label,
        scenarioDir: currentBase,
        ...(overlayDir ? { overlayDir } : {}),
        command: spec.command,
        ...(spec.expectOutputs ? { expectOutputs: spec.expectOutputs } : {}),
        runRoot: roundRoot,
        timeoutMs: spec.timeoutMs,
      });

    if (!candidates.length) {
      finalDecision = classifyProbeSet(null, [], spec.metrics ?? []);
      rounds.push({
        round,
        base_dir: currentBase,
        decision: finalDecision,
        selection: null,
        outcomes: [],
        rejected: [...rejected],
      });
      halted = 'decline';
      break;
    }

    const base = probeFor('base');
    const outcomes = candidates.map((c) => probeFor(c.label, c.overlayDir));
    actualProbes += outcomes.length + 1;
    const decision = classifyProbeSet(base, outcomes, spec.metrics ?? []);
    finalDecision = decision;

    const selection =
      spec.selection === 'blind' && decision.decision === 'human_gate'
        ? applyBlindSelection(
            [base, ...outcomes],
            (spec.seed ?? 0) + round,
            spec.selector ?? metricsFallbackSelector,
            spec.selector ? 'llm_blind' : 'metrics_fallback'
          )
        : null;

    rounds.push({
      round,
      base_dir: currentBase,
      decision,
      selection,
      outcomes,
      rejected: [...rejected],
    });

    if (decision.decision === 'auto_advance' && decision.winner) {
      adopted.push(decision.winner);
      if (round === spec.rounds) {
        halted = 'auto_advance_final';
        break;
      }
      // Materialize: next base = current base + winner overlay.
      const winner = candidates.find((c) => c.label === decision.winner)!;
      const nextBase = path.join(runRoot, 'bases', `round-${round + 1}`);
      if (safeExistsSync(nextBase)) safeRmSync(nextBase);
      copyTreeInto(currentBase, nextBase);
      copyTreeInto(winner.overlayDir, nextBase);
      currentBase = nextBase;
      continue;
    }
    halted =
      decision.decision === 'human_gate'
        ? 'human_gate'
        : decision.decision === 'keep_base'
          ? 'keep_base'
          : 'decline';
    break;
  }

  const budget = {
    expected_probes: expectedProbes,
    actual_probes: actualProbes,
    status: (actualProbes === expectedProbes
      ? 'ok'
      : actualProbes < expectedProbes
        ? 'short'
        : 'exceeded') as 'ok' | 'short' | 'exceeded',
  };
  const report = {
    session_id: spec.session_id,
    recorded_at: nowIso(),
    rounds,
    final_decision: finalDecision,
    adopted_overlays: adopted,
    halted_by: halted,
    budget,
  };
  const reportPath = assertSafeRepositoryPath(path.join(runRoot, 'report.json'), {
    allowMissingLeaf: true,
  });
  safeWriteFile(reportPath, JSON.stringify(report, null, 2));
  ledger.record('CONTRASTIVE_RECURSIVE_SESSION', {
    session_id: spec.session_id,
    rounds: rounds.length,
    halted_by: halted,
    adopted: adopted,
    budget,
  });
  return {
    report_path: reportPath,
    rounds,
    final_decision: finalDecision!,
    adopted_overlays: adopted,
    halted_by: halted,
    budget,
  };
}
