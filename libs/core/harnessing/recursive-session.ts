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
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { ledger } from '../ledger.js';
import { nowIso } from '../foundation/time.js';
import { copyTree, runProbe, type RunOutcome } from './probe-runner.js';
import { classifyProbeSet, type DecisionReport, type MetricSpec } from './decision-axis.js';
import { validateOverlay, type SurfaceSpec } from './surface-spec.js';
import { proposeCandidates } from './propose.js';
import { scanOverlayForMarkers } from './leak-tripwire.js';
import {
  applyBlindSelection,
  metricsFallbackSelector,
  type BlindRecommendation,
  type BlindSelector,
} from './blind-select.js';
import { sessionSeed } from './contrastive-session.js';

export interface RecursiveSessionSpec {
  session_id: string;
  scenarioDir: string;
  command: string[];
  /** Per-round candidate overlays (same set each round). */
  candidates?: Array<{ label: string; overlayDir: string }>;
  /** LLM propose per round (requires surface). */
  propose?: {
    brief: string;
    count: number;
    labelPrefix?: string;
    /** Optional experience library: its lessons seed the propose prompt. */
    library?: { root: string; domain: string };
  };
  surface?: SurfaceSpec;
  /** Extra leak-tripwire content markers (merged with DEFAULT_MARKERS). */
  markers?: string[];
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
  /** Cumulative — includes rejections from earlier rounds (session-level trail). */
  rejected: Array<{ label: string; path: string; reason: string }>;
  propose_meta?: { backend_used: boolean; error?: string };
}

export interface RecursiveSessionResult {
  report_path: string;
  rounds: RoundRecord[];
  final_decision: DecisionReport;
  adopted_overlays: string[];
  /** 'budget' is the defensive default — every in-loop path currently sets a concrete halt before break, so it should never appear in a real report. */
  halted_by: 'budget' | 'human_gate' | 'keep_base' | 'decline' | 'auto_advance_final';
  budget: { expected_probes: number; actual_probes: number; status: 'ok' | 'short' | 'exceeded' };
}

export async function runRecursiveSession(
  spec: RecursiveSessionSpec
): Promise<RecursiveSessionResult> {
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  const scen = path.resolve(spec.scenarioDir);
  const resolvedRoot = path.resolve(runRoot);
  if (resolvedRoot === scen || resolvedRoot.startsWith(`${scen}${path.sep}`)) {
    throw new Error(
      '[RECURSIVE_SESSION] runRoot must not equal or be nested inside scenarioDir (copyTree would recurse into itself)'
    );
  }
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
  if (spec.propose && !spec.surface) {
    throw new Error('[RECURSIVE_SESSION] --propose requires a surface spec');
  }
  // Predict proposed labels and reject collisions before spending backend calls.
  if (spec.propose) {
    if (
      !Number.isInteger(spec.propose.count) ||
      spec.propose.count < 1 ||
      spec.propose.count > 10
    ) {
      throw new Error('[RECURSIVE_SESSION] propose.count must be an integer 1..10');
    }
    const prefix = spec.propose.labelPrefix ?? 'llm';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(prefix)) {
      throw new Error('[RECURSIVE_SESSION] invalid propose.labelPrefix charset');
    }
    const predicted = Array.from({ length: spec.propose.count }, (_, i) => `${prefix}${i + 1}`);
    for (const label of predicted) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label)) {
        throw new Error(
          `[RECURSIVE_SESSION] predicted label ${JSON.stringify(label)} is not a valid label`
        );
      }
    }
    const all = [...labels, ...predicted];
    if (new Set(all).size !== all.length) {
      throw new Error('[RECURSIVE_SESSION] supplied label collides with predicted proposed labels');
    }
  }

  const rejected: Array<{ label: string; path: string; reason: string }> = [];
  // Reject an overlay whose marker scan hits — a leak-marked file must never
  // reach a probe (harness2 leak tripwire).
  const rejectOnMarkers = (label: string, overlayDir: string): boolean => {
    let scan;
    try {
      scan = scanOverlayForMarkers(overlayDir, spec.markers);
    } catch (error) {
      rejected.push({
        label,
        path: '.',
        reason: `overlay scan failed: ${error instanceof Error ? error.message : error}`,
      });
      return true;
    }
    if (scan.clean) return false;
    rejected.push(
      ...scan.hits.map((h) => ({
        label,
        path: h.path,
        reason: `leak marker: ${h.marker} at ${h.path}:${h.line}`,
      }))
    );
    return true;
  };
  // Surface-validate + tripwire supplied overlays once — supplied overlay
  // dirs are assumed session-immutable; a mid-session mutation is not
  // re-scanned (proposed overlays ARE scanned per round).
  const supplied = (spec.candidates ?? []).filter((c) => {
    if (spec.surface) {
      try {
        const v = validateOverlay(c.overlayDir, spec.surface);
        if (!v.ok) {
          rejected.push(
            ...v.rejected_files.map((r) => ({ label: c.label, path: r.path, reason: r.reason }))
          );
          return false;
        }
      } catch (error) {
        rejected.push({
          label: c.label,
          path: '.',
          reason: `overlay invalid: ${error instanceof Error ? error.message : error}`,
        });
        return false;
      }
    }
    return !rejectOnMarkers(c.label, c.overlayDir);
  });

  const rounds: RoundRecord[] = [];
  const adopted: string[] = [];
  let currentBase = spec.scenarioDir;
  let halted: RecursiveSessionResult['halted_by'] = 'budget';
  let actualProbes = 0;
  // Declared upfront (informational): each round was budgeted 1 base probe +
  // one probe per declared candidate. planned_probes tracks what each round
  // that actually executed was about to run — status compares actual vs
  // planned so a healthy early halt doesn't read as a shortfall.
  const declaredProbes =
    spec.rounds * (1 + (spec.candidates?.length ?? 0) + (spec.propose?.count ?? 0));
  let plannedProbes = 0;
  let finalDecision: DecisionReport | null = null;

  for (let round = 1; round <= spec.rounds; round++) {
    const roundRoot = path.join(runRoot, `round-${round}`);
    // Round-scoped run dirs: no cross-round or cross-session contamination.
    let roundProposeMeta: RoundRecord['propose_meta'];
    const candidates = [...supplied];
    if (spec.propose && spec.surface) {
      const roundBrief =
        adopted.length || round > 1
          ? `${spec.propose.brief} (round ${round} of ${spec.rounds}; adopted so far: ${adopted.join(', ') || 'none'})`
          : spec.propose.brief;
      const proposed = await proposeCandidates({
        brief: roundBrief,
        surface: spec.surface,
        count: spec.propose.count,
        outDir: path.join(roundRoot, '_proposed'),
        labelPrefix: spec.propose.labelPrefix,
        ...(spec.propose.library ? { library: spec.propose.library } : {}),
      });
      rejected.push(...proposed.rejected.map((r) => ({ ...r, label: `r${round}:${r.label}` })));
      candidates.push(
        ...proposed.candidates
          .filter((c) => !rejectOnMarkers(`r${round}:${c.label}`, c.overlayDir))
          .map((c) => ({ label: c.label, overlayDir: c.overlayDir }))
      );
      roundProposeMeta = {
        backend_used: proposed.backend_used,
        ...(proposed.error ? { error: proposed.error } : {}),
      };
    }

    // Budget identity: check duplicate labels BEFORE counting probes.
    const roundLabels = candidates.map((c) => c.label);
    if (new Set(roundLabels).size !== roundLabels.length) {
      throw new Error(
        `[BUDGET_IDENTITY] duplicate labels in round ${round}: ${roundLabels.join(', ')}`
      );
    }
    plannedProbes += candidates.length + (candidates.length ? 1 : 0);

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
        ...(roundProposeMeta ? { propose_meta: roundProposeMeta } : {}),
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
            // Per-round variation: +round makes each round's letter mapping
            // differ — deliberate, unlike the single-shot session's raw seed.
            (spec.seed ?? sessionSeed(spec.session_id)) + round,
            spec.selector ?? metricsFallbackSelector
          )
        : null;

    rounds.push({
      round,
      base_dir: currentBase,
      decision,
      selection,
      outcomes,
      rejected: [...rejected],
      ...(roundProposeMeta ? { propose_meta: roundProposeMeta } : {}),
    });

    if (decision.decision === 'auto_advance' && decision.winner) {
      adopted.push(`r${round}:${decision.winner}`);
      if (round === spec.rounds) {
        halted = 'auto_advance_final';
        break;
      }
      // Materialize: next base = current base + winner overlay.
      const winner = candidates.find((c) => c.label === decision.winner)!;
      const nextBase = path.join(runRoot, 'bases', `round-${round + 1}`);
      const resolvedWinner = path.resolve(assertSafeRepositoryPath(winner.overlayDir));
      const resolvedNext = path.resolve(nextBase);
      if (
        resolvedNext === resolvedWinner ||
        resolvedNext.startsWith(`${resolvedWinner}${path.sep}`)
      ) {
        throw new Error(
          `[RECURSIVE_SESSION] winner overlay ${JSON.stringify(winner.overlayDir)} contains the next base dir`
        );
      }
      if (safeExistsSync(nextBase)) safeRmSync(nextBase);
      copyTree(currentBase, nextBase);
      copyTree(winner.overlayDir, nextBase);
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
    expected_probes: declaredProbes,
    planned_probes: plannedProbes,
    actual_probes: actualProbes,
    status: (actualProbes === plannedProbes
      ? 'ok'
      : actualProbes < plannedProbes
        ? 'short'
        : 'exceeded') as 'ok' | 'short' | 'exceeded',
  };
  const report = {
    session_id: spec.session_id,
    recorded_at: nowIso(),
    rounds,
    final_decision: finalDecision,
    adopted_overlays: adopted,
    scenario_dir: spec.scenarioDir,
    command: spec.command,
    declared_rounds: spec.rounds,
    halted_by: halted,
    budget,
    ...(spec.work_shape ? { work_shape: spec.work_shape } : {}),
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
