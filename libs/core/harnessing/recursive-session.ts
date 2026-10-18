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
  loadJson,
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
import {
  buildExperienceRecord,
  persistExperience,
  type ExperienceSink,
} from './experience-writeback.js';
import type { LessonInput } from './experience-library.js';

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
  /** Governed write-back: qualifying per-round experience records append to
   *  this library (quality-gated + deduped; see experience-writeback). */
  experienceSink?: ExperienceSink;
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
  /** Post-probe manifest of the base — lets resumeRecursiveSession verify
   *  the halt→resume window against recorded bytes. */
  base_end_manifest?: Record<string, string>;
  propose_meta?: { backend_used: boolean; error?: string };
  /** Set when this round produced a reusable lesson: an auto_advance winner
   *  whose probed bytes were materialized into the next base, or a final-
   *  round winner decided without needing a next base. Absent on
   *  keep_base/decline/human_gate and on materialization failure — those
   *  outcomes are evidence, not lessons. */
  experience?: LessonInput;
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
  /** Present only on a human_gate resume: which halted report this session
   *  continues and which candidate the human adopted. */
  resume?: { from: string; adopt: string; halted_round: number };
}

/** Spec + filesystem validation shared by fresh and resumed sessions — a
 *  session that could never probe must fail before any evidence moves.
 *  Returns the asserted runRoot. */
function assertRecursiveSpec(spec: RecursiveSessionSpec): string {
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
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
  return runRoot;
}

export async function runRecursiveSession(
  spec: RecursiveSessionSpec
): Promise<RecursiveSessionResult> {
  assertRecursiveSpec(spec);
  return runSessionLoop(spec, {
    startRound: 1,
    initialBase: spec.scenarioDir,
    initialBaseManifest: null,
    initialAdopted: [],
    declaredRounds: spec.rounds,
  });
}

interface SessionLoopInit {
  /** First round number — 1 for a fresh session, haltedRound+1 on resume
   *  (numbering continues so labels like 'r3:win' stay honest about which
   *  round ran). */
  startRound: number;
  /** Base workspace round `startRound` probes against. */
  initialBase: string;
  /** Verified manifest of initialBase — becomes that round's baseline. */
  initialBaseManifest: Record<string, string> | null;
  /** adopted_overlays seed — a resume adoption lands before the resumed
   *  session's first round and is labelled 'resume:r<halted>:<label>',
   *  never an auto_advance 'r<N>:' label. */
  initialAdopted: string[];
  /** Rounds this session declares — the budget denominator. */
  declaredRounds: number;
  resume?: { from: string; adopt: string; haltedRound: number };
  /** Set when the resume-time adoption itself failed verification — the
   *  loop must not probe; the session reports materialization_error with
   *  zero executed rounds. */
  resumeFailure?: string;
}

async function runSessionLoop(
  spec: RecursiveSessionSpec,
  init: SessionLoopInit
): Promise<RecursiveSessionResult> {
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  // Freeze the library horizon at session start — lessons appended mid-run
  // must not change later rounds (retain causal order = reproducibility).
  const libraryAsOf = nowIso();
  const reportPath = assertSafeRepositoryPath(path.join(runRoot, 'report.json'), {
    allowMissingLeaf: true,
  });
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
  const adopted: string[] = [...init.initialAdopted];
  // Per-label manifest of the last probed snapshot — a SUPPLIED overlay
  // whose bytes change between rounds is surfaced, not silently re-probed.
  // Proposed overlays share labels across rounds but legitimately regenerate
  // — they have no cross-round identity to compare, so they are excluded.
  const overlayManifests = new Map<string, string>();
  const suppliedLabels = new Set(supplied.map((c) => c.label));
  // Verified manifest of the last materialized base, carried into the next
  // round — a detached writer hitting the verify→next-manifest window must
  // not silently re-baseline into unverified bytes.
  let pendingBaseManifest: Record<string, string> | null = init.initialBaseManifest;
  let currentBase = init.initialBase;
  let halted: RecursiveSessionResult['halted_by'] = 'budget';
  let actualProbes = 0;
  // Declared upfront (informational): each round was budgeted 1 base probe +
  // one probe per declared candidate. planned_probes tracks what each round
  // that actually executed was about to run — status compares actual vs
  // planned so a healthy early halt doesn't read as a shortfall.
  const declaredProbes =
    init.declaredRounds * (1 + (spec.candidates?.length ?? 0) + (spec.propose?.count ?? 0));
  const declaredPerRound = 1 + (spec.candidates?.length ?? 0) + (spec.propose?.count ?? 0);
  let plannedProbes = 0;
  let finalDecision: DecisionReport | null = null;

  if (init.resumeFailure) {
    // The human's pick failed byte verification before the resumed session
    // could probe — record the refused adoption exactly like an in-loop
    // materialization failure (evidence, not a crash).
    const rejection = {
      label: `resume:r${init.resume!.haltedRound}:${init.resume!.adopt}`,
      path: '.',
      reason: `materialization failed: ${init.resumeFailure}`,
    };
    rejected.push(rejection);
    finalDecision = classifyProbeSet(null, [], spec.metrics ?? []);
    halted = 'materialization_error';
  }

  for (let round = init.startRound; !init.resumeFailure && round <= spec.rounds; round++) {
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
    let baseEndManifest: Record<string, string> | null = null;
    try {
      baseEndManifest = treeManifest(currentBase);
      baseDrifted = !baseManifest || !manifestsEqual(baseEndManifest, baseManifest);
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
      // Post-probe manifest of the base — lets a resume verify the
      // halt→resume window against recorded bytes, not just trust the dir.
      ...(baseEndManifest ? { base_end_manifest: baseEndManifest } : {}),
      ...(roundProposeMeta ? { propose_meta: roundProposeMeta } : {}),
    });

    if (decision.decision === 'auto_advance' && decision.winner) {
      const winnerOutcome = outcomes.find((o) => o.label === decision.winner);
      const adoptLabel = `r${round}:${decision.winner}`;
      if (round === spec.rounds) {
        // No next base is needed, but the decisive contrast is still a
        // reusable lesson — emit the record (write-back stays gated).
        if (winnerOutcome) {
          rounds[rounds.length - 1].experience = buildExperienceRecord({
            workShape: spec.work_shape,
            scenarioDir: spec.scenarioDir,
            base,
            winner: decision.winner,
            adoptedLabel: adoptLabel,
            reportPath,
            materialized: false,
          });
        }
        halted = 'auto_advance_final';
        break;
      }
      // Materialize: next base = current base + winner overlay — sourced from
      // the probe's staged snapshot, never the live overlayDir. The window
      // between probe and adoption is untrusted: bytes adopted must be the
      // bytes probed (R7-04).
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
        // The adoption landed on verified bytes — this round produced a
        // reusable lesson (write-back stays gated + deduped below).
        rounds[rounds.length - 1].experience = buildExperienceRecord({
          workShape: spec.work_shape,
          scenarioDir: spec.scenarioDir,
          base,
          winner: decision.winner,
          adoptedLabel: adoptLabel,
          reportPath,
          materialized: true,
        });
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

  // Governed write-back: only records emitted by landed adoptions reach the
  // gate — a round whose materialization failed emits none, so a session
  // halted_by materialization_error can never leak an unverified lesson.
  let lessonsPersisted = 0;
  let lessonsDeduped = 0;
  if (spec.experienceSink) {
    for (const rec of rounds) {
      if (!rec.experience) continue;
      const status = persistExperience(spec.experienceSink, rec.experience, {
        decision: rec.decision.decision,
        winner: rec.decision.winner,
        winnerOutcome: rec.outcomes.find((o) => o.label === rec.decision.winner),
        base_drifted: rec.base_drifted,
      });
      if (status === 'persisted') lessonsPersisted++;
      else if (status === 'duplicate') lessonsDeduped++;
    }
  }

  const budget = {
    expected_probes: declaredProbes,
    planned_probes: plannedProbes,
    actual_probes: actualProbes,
    // Compare planned vs declared capacity of EXECUTED rounds only — a
    // healthy early halt is 'ok'; rejections/degrades that shrank a round's
    // candidate set (or a resume that refused before probing) read as
    // 'rejected_shortfall'; a lost probe is 'probe_loss'.
    status: (actualProbes < plannedProbes
      ? 'probe_loss'
      : plannedProbes < declaredPerRound * rounds.length || Boolean(init.resumeFailure)
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
    declared_rounds: init.declaredRounds,
    halted_by: halted,
    // final_decision still says auto_advance+winner on this halt path —
    // without the reason here a consumer keyed on final_decision alone would
    // see an adopted winner that never landed.
    ...(halted === 'materialization_error'
      ? {
          materialization_error:
            rounds[rounds.length - 1]?.rejected.at(-1)?.reason ??
            rejected.at(-1)?.reason ??
            'materialization failed',
        }
      : {}),
    ...(init.resume
      ? {
          resumed_from: init.resume.from,
          resumed_adopt: init.resume.adopt,
          resumed_after_round: init.resume.haltedRound,
          // A human's pick, never an axis verdict — kept visibly distinct
          // from auto_advance adoptions (labelled 'resume:r<N>:<label>').
          // Omitted when the resume adoption itself failed verification —
          // claiming a route that never landed would be dishonest.
          ...(!init.resumeFailure ? { adopted_via: 'human_gate_resume' as const } : {}),
        }
      : {}),
    budget,
    ...(spec.experienceSink
      ? {
          experience_sink: {
            root: spec.experienceSink.root,
            domain: spec.experienceSink.domain,
            persisted: lessonsPersisted,
            deduplicated: lessonsDeduped,
          },
        }
      : {}),
    ...(spec.work_shape ? { work_shape: spec.work_shape } : {}),
  };
  safeWriteFile(reportPath, JSON.stringify(report, null, 2));
  ledger.record('CONTRASTIVE_RECURSIVE_SESSION', {
    session_id: spec.session_id,
    rounds: rounds.length,
    halted_by: halted,
    adopted: adopted,
    budget,
    ...(init.resume ? { resumed_from: init.resume.from, resumed_adopt: init.resume.adopt } : {}),
    ...(spec.experienceSink ? { lessons_persisted: lessonsPersisted } : {}),
  });
  return {
    report_path: reportPath,
    rounds,
    final_decision: finalDecision!,
    adopted_overlays: adopted,
    halted_by: halted,
    budget,
    ...(init.resume
      ? {
          resume: {
            from: init.resume.from,
            adopt: init.resume.adopt,
            halted_round: init.resume.haltedRound,
          },
        }
      : {}),
  };
}

/** Shape of the halted report the resume path trusts — only the fields it
 *  reads; everything else is opaque evidence. */
interface HaltedSessionReport {
  halted_by?: unknown;
  declared_rounds?: unknown;
  rounds?: Array<{
    round?: unknown;
    base_dir?: unknown;
    base_drifted?: unknown;
    base_end_manifest?: Record<string, string>;
    outcomes?: RunOutcome[];
  }>;
}

/**
 * Resume a session halted by human_gate: the human names a candidate from
 * the halted round, its VERIFIED staged snapshot is materialized onto the
 * halted base, and the remaining rounds run under the caller-supplied
 * runRoot with continuing round numbers. The adoption is labelled
 * 'resume:r<halted>:<label>' in adopted_overlays and reported as
 * adopted_via: 'human_gate_resume' — a human's pick, never an auto_advance
 * decision.
 *
 * spec.rounds is the TOTAL declared budget (the same value the halted
 * session declared — e.g. the report's declared_rounds); the resumed
 * session runs `spec.rounds - haltedRound` rounds. spec.runRoot must differ
 * from the halted session's runRoot — its report.json is evidence.
 */
export async function resumeRecursiveSession(
  spec: RecursiveSessionSpec,
  opts: { fromReport: string; adopt: string }
): Promise<RecursiveSessionResult> {
  // A session that could never probe must fail before any evidence moves.
  assertRecursiveSpec(spec);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts.adopt)) {
    throw new Error(`[RESUME] invalid adopt label ${JSON.stringify(opts.adopt)}`);
  }
  const reportFile = assertSafeRepositoryPath(opts.fromReport);
  let prior: HaltedSessionReport;
  try {
    prior = loadJson<HaltedSessionReport>(reportFile);
  } catch (error) {
    throw new Error(
      `[RESUME] prior report unreadable: ${error instanceof Error ? error.message : error}`
    );
  }
  if (prior.halted_by !== 'human_gate') {
    throw new Error(
      `[RESUME] report halted_by must be 'human_gate', got ${JSON.stringify(
        prior.halted_by
      )} — only gated sessions resume`
    );
  }
  const priorRounds = Array.isArray(prior.rounds) ? prior.rounds : [];
  const lastRound = priorRounds[priorRounds.length - 1];
  if (!lastRound || typeof lastRound.round !== 'number' || !Array.isArray(lastRound.outcomes)) {
    throw new Error('[RESUME] prior report has no halted round with probe outcomes');
  }
  if (typeof lastRound.base_dir !== 'string' || !lastRound.base_dir) {
    throw new Error('[RESUME] halted round records no base_dir — nothing to adopt onto');
  }
  const haltedRound = lastRound.round;
  const remaining = spec.rounds - haltedRound;
  if (remaining < 1) {
    throw new Error(
      `[RESUME] no remaining rounds — declared ${spec.rounds}, halted after round ${haltedRound}`
    );
  }

  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  // The halted session's report.json is evidence — a resumed session must
  // never overwrite it.
  if (path.resolve(runRoot) === path.resolve(path.dirname(reportFile))) {
    throw new Error(
      '[RESUME] runRoot must differ from the halted session runRoot (its report.json is evidence)'
    );
  }

  // The human's pick — never auto-picked. An outcome that never ran or
  // never delivered is not adoptable; one without a snapshot manifest is
  // unverifiable. All three are structured refusals.
  const outcome = lastRound.outcomes.find((o) => o.label === opts.adopt);
  if (!outcome) {
    throw new Error(
      `[RESUME] no candidate ${JSON.stringify(
        opts.adopt
      )} among halted round ${haltedRound} outcomes — refusing to auto-pick`
    );
  }
  if (!outcome.ok || !outcome.delivered) {
    throw new Error(
      `[RESUME] candidate ${JSON.stringify(
        opts.adopt
      )} did not deliver in round ${haltedRound} (ok=${outcome.ok} delivered=${outcome.delivered})`
    );
  }
  if (!outcome.staged_snapshot || !outcome.snapshot_manifest) {
    throw new Error(
      `[RESUME] candidate ${JSON.stringify(
        opts.adopt
      )} has no verifiable snapshot — probed bytes are required for adoption`
    );
  }

  const haltedBase = assertSafeRepositoryPath(lastRound.base_dir);
  if (!safeExistsSync(haltedBase) || !safeLstat(haltedBase).isDirectory()) {
    throw new Error(`[RESUME] halted base dir missing: ${lastRound.base_dir}`);
  }
  const snapshot = assertSafeRepositoryPath(outcome.staged_snapshot);
  const nextBase = path.join(runRoot, 'bases', `round-${haltedRound + 1}`);
  const resolvedNext = path.resolve(nextBase);
  for (const src of [haltedBase, snapshot]) {
    const r = path.resolve(src);
    if (
      resolvedNext === r ||
      resolvedNext.startsWith(`${r}${path.sep}`) ||
      r.startsWith(`${resolvedNext}${path.sep}`)
    ) {
      throw new Error('[RESUME] materialized base dir would nest inside its copy sources');
    }
  }

  // Materialize haltedBase + verified snapshot — the same integrity
  // contract as the in-loop adoption: a base already drifted at halt time
  // is refused, the recorded post-probe manifest re-verifies the halted
  // base AND the live snapshot bytes, and the materialized tree must equal
  // base-manifest overridden by snapshot-manifest.
  let resumeFailure: string | null = null;
  let verifiedManifest: Record<string, string> | null = null;
  try {
    if (lastRound.base_drifted === true) {
      throw new Error('halted base already drifted during probes — refusing adoption');
    }
    const haltedBaseManifest = treeManifest(haltedBase);
    if (
      lastRound.base_end_manifest &&
      !manifestsEqual(haltedBaseManifest, lastRound.base_end_manifest)
    ) {
      throw new Error('halted base mutated between halt and resume');
    }
    if (!manifestsEqual(treeManifest(snapshot), outcome.snapshot_manifest)) {
      throw new Error('adopted candidate snapshot drifted after the halted probe');
    }
    if (safeExistsSync(nextBase)) safeRmSync(nextBase);
    copyTree(haltedBase, nextBase);
    copyTree(snapshot, nextBase);
    const expected = { ...haltedBaseManifest, ...outcome.snapshot_manifest };
    if (!manifestsEqual(treeManifest(nextBase), expected)) {
      safeRmSync(nextBase);
      throw new Error('materialized base failed post-copy integrity check');
    }
    verifiedManifest = expected;
  } catch (error) {
    resumeFailure = error instanceof Error ? error.message : String(error);
  }

  return runSessionLoop(spec, {
    startRound: haltedRound + 1,
    initialBase: nextBase,
    initialBaseManifest: verifiedManifest,
    // The resume adoption counts as adopted only when its bytes verified.
    initialAdopted: resumeFailure ? [] : [`resume:r${haltedRound}:${opts.adopt}`],
    declaredRounds: remaining,
    resume: { from: reportFile, adopt: opts.adopt, haltedRound },
    ...(resumeFailure ? { resumeFailure } : {}),
  });
}
