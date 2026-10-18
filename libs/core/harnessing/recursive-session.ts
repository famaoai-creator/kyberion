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
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { ledger } from '../ledger.js';
import { nowIso } from '../foundation/time.js';
import {
  copyTree,
  manifestsEqual,
  runProbe,
  treeManifest,
  validateProbeSpec,
  type RunOutcome,
} from './probe-runner.js';
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
  /** The base dir's bytes differ from the round-start manifest — later
   *  probes may have run against different bytes than the base probe saw.
   *  Recorded on every round; on auto_advance it additionally halts adoption. */
  base_drifted?: boolean;
  propose_meta?: { backend_used: boolean; error?: string };
}

export interface RecursiveSessionResult {
  report_path: string;
  rounds: RoundRecord[];
  final_decision: DecisionReport;
  adopted_overlays: string[];
  /** 'budget' is the defensive default — every in-loop path currently sets a concrete halt before break, so it should never appear in a real report. */
  halted_by:
    | 'budget'
    | 'human_gate'
    | 'keep_base'
    | 'decline'
    | 'auto_advance_final'
    | 'materialization_error';
  budget: {
    expected_probes: number;
    planned_probes: number;
    actual_probes: number;
    status: 'ok' | 'rejected_shortfall' | 'probe_loss';
    actual_matches_plan: boolean;
  };
}

export async function runRecursiveSession(
  spec: RecursiveSessionSpec
): Promise<RecursiveSessionResult> {
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  // Freeze the library horizon at session start — lessons appended mid-run
  // must not change later rounds (retain causal order = reproducibility).
  const libraryAsOf = nowIso();
  const scen = path.resolve(spec.scenarioDir);
  const resolvedRoot = path.resolve(runRoot);
  if (resolvedRoot === scen || resolvedRoot.startsWith(`${scen}${path.sep}`)) {
    throw new Error(
      '[RECURSIVE_SESSION] runRoot must not equal or be nested inside scenarioDir (copyTree would recurse into itself)'
    );
  }
  safeMkdir(runRoot, { recursive: true });
  // Validate the probe spec at entry, before the round-1 propose stage can
  // spend backend calls on a session that could never probe.
  validateProbeSpec({ command: spec.command, expectOutputs: spec.expectOutputs });
  const scenarioDir = assertSafeRepositoryPath(spec.scenarioDir);
  if (!safeLstat(scenarioDir).isDirectory()) {
    throw new Error('[RECURSIVE_SESSION] scenarioDir must be a directory');
  }
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
  // Per-label manifest of the last probed snapshot — a SUPPLIED overlay
  // whose bytes change between rounds is surfaced, not silently re-probed.
  // Proposed overlays share labels across rounds but legitimately regenerate
  // — they have no cross-round identity to compare, so they are excluded.
  const overlayManifests = new Map<string, string>();
  const suppliedLabels = new Set(supplied.map((c) => c.label));
  // Verified manifest of the last materialized base, carried into the next
  // round — a detached writer hitting the verify→next-manifest window must
  // not silently re-baseline into unverified bytes.
  let pendingBaseManifest: Record<string, string> | null = null;
  let currentBase = spec.scenarioDir;
  let halted: RecursiveSessionResult['halted_by'] = 'budget';
  let actualProbes = 0;
  // Declared upfront (informational): each round was budgeted 1 base probe +
  // one probe per declared candidate. planned_probes tracks what each round
  // that actually executed was about to run — status compares actual vs
  // planned so a healthy early halt doesn't read as a shortfall.
  const declaredProbes =
    spec.rounds * (1 + (spec.candidates?.length ?? 0) + (spec.propose?.count ?? 0));
  const declaredPerRound = 1 + (spec.candidates?.length ?? 0) + (spec.propose?.count ?? 0);
  let plannedProbes = 0;
  let finalDecision: DecisionReport | null = null;

  for (let round = 1; round <= spec.rounds; round++) {
    const roundRoot = path.join(runRoot, `round-${round}`);
    // Manifest of the base BEFORE this round's probes — the scenario runs
    // unsandboxed and could write into bases/round-N or the scenario input;
    // a drift must fail adoption, not ride into the next base. A manifest
    // failure here is recorded, not thrown: the probes below fail soft
    // individually and their outcomes are evidence.
    let baseManifest: Record<string, string> | null = null;
    try {
      baseManifest = treeManifest(currentBase);
    } catch (error) {
      rejected.push({
        label: `r${round}:base`,
        path: '.',
        reason: `base manifest failed: ${error instanceof Error ? error.message : error} — drift unverifiable this round`,
      });
    }
    if (pendingBaseManifest) {
      if (baseManifest && !manifestsEqual(baseManifest, pendingBaseManifest)) {
        rejected.push({
          label: `r${round}:base`,
          path: '.',
          reason: 'base mutated between rounds — verified manifest kept as drift baseline',
        });
        // Keep the last VERIFIED state as the baseline: this round's probes
        // run against mutated bytes (base_drifted will record it) and any
        // adoption must still verify against the known-good manifest.
        baseManifest = pendingBaseManifest;
      }
      pendingBaseManifest = null;
    }
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
        ...(spec.propose.library
          ? { library: { ...spec.propose.library, asOf: libraryAsOf } }
          : {}),
      });
      rejected.push(...proposed.rejected.map((r) => ({ ...r, label: `r${round}:${r.label}` })));
      // Mirror contrastive-session: a degraded empty propose run is recorded
      // in the rejection trail, not only in propose_meta.
      if (proposed.error && !proposed.candidates.length) {
        rejected.push({ label: `r${round}:propose`, path: '.', reason: proposed.error });
      }
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
        ...(spec.markers ? { markers: spec.markers } : {}),
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
    // Count commands actually executed — a stage-refused or staging-failed
    // outcome ran nothing; counting it as a probe would inflate the budget.
    actualProbes += outcomes.filter((o) => o.ok).length + (base.ok ? 1 : 0);
    // A marker caught at stage time means the probe REFUSED to run — mirror
    // it into the rejection trail so the audit reads the same as a pre-probe
    // rejection (it is one: the command never executed).
    for (const o of outcomes) {
      if (o.probe_refused) {
        rejected.push({
          label: `r${round}:${o.label}`,
          path: '.',
          reason: `probe refused: ${o.error}`,
        });
      }
      // Cross-round honesty: same label, different bytes than last round —
      // the supplied overlay mutated under the session's immutability
      // assumption. Surface it; don't pretend the probes were comparable.
      if (o.snapshot_manifest && suppliedLabels.has(o.label)) {
        const canon = JSON.stringify(
          Object.keys(o.snapshot_manifest)
            .sort()
            .map((k) => [k, o.snapshot_manifest![k]])
        );
        const prev = overlayManifests.get(o.label);
        if (prev !== undefined && prev !== canon) {
          rejected.push({
            label: `r${round}:${o.label}`,
            path: '.',
            reason: 'supplied overlay bytes changed between rounds',
          });
        }
        overlayManifests.set(o.label, canon);
      }
    }
    const decision = classifyProbeSet(base, outcomes, spec.metrics ?? []);
    finalDecision = decision;
    // The scenario is unsandboxed: a probe can mutate the base mid-round and
    // silently skew every later probe's comparability. Detect + record drift
    // on EVERY round, not only when adoption needs it.
    let baseDrifted = false;
    try {
      baseDrifted = !baseManifest || !manifestsEqual(treeManifest(currentBase), baseManifest);
    } catch {
      baseDrifted = true;
    }

    const selection =
      spec.selection === 'blind' && decision.decision === 'human_gate'
        ? applyBlindSelection(
            // Never-executed outcomes (stage-refused, staging-failed) have no
            // artifacts to judge — keep them out of the anonymized pool so a
            // recommendation can't name bytes that never ran.
            [base, ...outcomes].filter((o) => o.ok),
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
      ...(baseDrifted ? { base_drifted: true } : {}),
      ...(roundProposeMeta ? { propose_meta: roundProposeMeta } : {}),
    });

    if (decision.decision === 'auto_advance' && decision.winner) {
      if (round === spec.rounds) {
        halted = 'auto_advance_final';
        break;
      }
      // Materialize: next base = current base + winner overlay — sourced from
      // the probe's staged snapshot, never the live overlayDir. The window
      // between probe and adoption is untrusted: bytes adopted must be the
      // bytes probed (R7-04).
      const winnerOutcome = outcomes.find((o) => o.label === decision.winner);
      const adoptionSource = winnerOutcome?.staged_snapshot;
      const adoptionManifest = winnerOutcome?.snapshot_manifest;
      // adopted bytes == probed bytes, verified — the scenario is
      // unsandboxed, so BOTH the winner snapshot and the current base can
      // drift during this round's probes.
      // treeManifest on a tampered path (dir swapped for a file, etc.) throws
      // — that IS drift, so convert it to a halt instead of crashing the
      // session and losing the probed evidence.
      let driftReason: string | null;
      try {
        driftReason = !adoptionSource
          ? 'probed-bytes snapshot unavailable'
          : !adoptionManifest
            ? 'snapshot manifest unavailable — bytes unverifiable'
            : !baseManifest
              ? 'base manifest unavailable — drift unverifiable'
              : !manifestsEqual(treeManifest(adoptionSource), adoptionManifest)
                ? 'winner snapshot drifted after probe'
                : !manifestsEqual(treeManifest(currentBase), baseManifest)
                  ? 'base dir drifted during round probes'
                  : null;
      } catch {
        driftReason = 'manifest unreadable — drifted';
      }
      if (driftReason || !adoptionSource) {
        const rejection = {
          label: `r${round}:${decision.winner}`,
          path: '.',
          reason: `materialization failed: ${driftReason ?? 'probed-bytes snapshot unavailable'}`,
        };
        rejected.push(rejection);
        // The round record was already pushed with a snapshot of `rejected` —
        // reflect the materialization failure into it or the report loses the
        // reason entirely (only halted_by would remain).
        rounds[rounds.length - 1].rejected.push(rejection);
        halted = 'materialization_error';
        break;
      }
      const nextBase = path.join(runRoot, 'bases', `round-${round + 1}`);
      const resolvedWinner = path.resolve(assertSafeRepositoryPath(adoptionSource));
      const resolvedNext = path.resolve(nextBase);
      const resolvedCurrent = path.resolve(currentBase);
      if (
        resolvedNext === resolvedWinner ||
        resolvedNext.startsWith(`${resolvedWinner}${path.sep}`) ||
        resolvedWinner.startsWith(`${resolvedNext}${path.sep}`) ||
        resolvedNext === resolvedCurrent ||
        resolvedNext.startsWith(`${resolvedCurrent}${path.sep}`) ||
        resolvedCurrent.startsWith(`${resolvedNext}${path.sep}`)
      ) {
        throw new Error(`[RECURSIVE_SESSION] next base dir would nest inside its copy sources`);
      }
      try {
        if (safeExistsSync(nextBase)) safeRmSync(nextBase);
        copyTree(currentBase, nextBase);
        copyTree(adoptionSource, nextBase);
        // A detached writer could land bytes in the verify→copy window;
        // re-hash the materialized tree and require it to equal exactly
        // base-manifest overridden by snapshot-manifest (overlay wins on
        // collision, same as the copy order above).
        const expected = { ...baseManifest, ...adoptionManifest };
        if (!manifestsEqual(treeManifest(nextBase), expected)) {
          safeRmSync(nextBase);
          throw new Error('materialized base failed post-copy integrity check');
        }
        adopted.push(`r${round}:${decision.winner}`);
        // Carry the verified state into the next round's baseline check.
        pendingBaseManifest = expected;
      } catch (error) {
        // Fail soft — the rounds already probed are evidence; don't lose them.
        const rejection = {
          label: `r${round}:${decision.winner}`,
          path: '.',
          reason: `materialization failed: ${error instanceof Error ? error.message : error}`,
        };
        rejected.push(rejection);
        rounds[rounds.length - 1].rejected.push(rejection);
        halted = 'materialization_error';
        break;
      }
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
    // Compare planned vs declared capacity of EXECUTED rounds only — a
    // healthy early halt is 'ok'; rejections/degrades that shrank a round's
    // candidate set read as 'rejected_shortfall'; a lost probe is 'probe_loss'.
    status: (actualProbes < plannedProbes
      ? 'probe_loss'
      : plannedProbes < declaredPerRound * rounds.length
        ? 'rejected_shortfall'
        : 'ok') as 'ok' | 'rejected_shortfall' | 'probe_loss',
    actual_matches_plan: actualProbes === plannedProbes,
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
    // final_decision still says auto_advance+winner on this halt path —
    // without the reason here a consumer keyed on final_decision alone would
    // see an adopted winner that never landed.
    ...(halted === 'materialization_error'
      ? {
          materialization_error:
            rounds[rounds.length - 1]?.rejected.at(-1)?.reason ?? 'materialization failed',
        }
      : {}),
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
