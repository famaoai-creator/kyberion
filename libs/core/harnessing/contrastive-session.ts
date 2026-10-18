/**
 * Contrastive session: optionally propose candidate overlays via the reasoning
 * backend, surface-validate every overlay, probe base + candidates on one
 * scenario, classify the evidence on the decision axis, and — when the axis
 * routes to human_gate — optionally produce a blind-selection recommendation
 * for the human. The report carries the full evidence trail, including a
 * harness2-shaped experience record only on decisive outcomes.
 *
 * Run-dir namespace under runRoot: probe dirs use the bare label ('base',
 * '<candidate>'), propose-stage overlays live under '_proposed/<label>/',
 * and the session report lands at 'report.json'.
 */

import * as path from 'node:path';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '../secure-io.js';
import { ledger } from '../ledger.js';
import { nowIso } from '../foundation/time.js';
import { runProbe, validateProbeSpec, type ProbeSpec, type RunOutcome } from './probe-runner.js';
import { classifyProbeSet, type DecisionReport, type MetricSpec } from './decision-axis.js';
import { validateOverlay, type SurfaceSpec } from './surface-spec.js';
import {
  applyBlindSelection,
  metricsFallbackSelector,
  type BlindRecommendation,
  type BlindSelector,
} from './blind-select.js';
import { proposeCandidates } from './propose.js';
import { scanOverlayForMarkers } from './leak-tripwire.js';

export interface ContrastiveSessionSpec {
  session_id: string;
  scenarioDir: string;
  command: string[];
  /** Supplied candidate overlays: label -> overlay dir. 'base' runs bare. */
  candidates?: Array<{ label: string; overlayDir: string }>;
  /** LLM propose stage: generate `count` overlays under the surface. */
  propose?: {
    brief: string;
    count: number;
    labelPrefix?: string;
    /** Optional experience library: its lessons seed the propose prompt. */
    library?: { root: string; domain: string };
  };
  /** Editable surface: every overlay (supplied or proposed) is validated. */
  surface?: SurfaceSpec;
  /** Extra leak-tripwire content markers (merged with DEFAULT_MARKERS). */
  markers?: string[];
  /** 'blind' adds an anonymized recommendation when the axis says human_gate. */
  selection?: 'blind';
  /** Seed for the blind letter mapping (default: hash of session_id). */
  seed?: number;
  /** Override for the blind selector (tests / LLM wiring). */
  selector?: BlindSelector;
  expectOutputs?: string[];
  metrics?: MetricSpec[];
  /** Directory the session's run dirs + report land in (repo-scoped). */
  runRoot: string;
  /** The work shape this session tunes — used as the experience cue. */
  work_shape?: string;
  timeoutMs?: number;
}

export interface ContrastiveSessionResult {
  report_path: string;
  decision: DecisionReport;
  outcomes: RunOutcome[];
  base: RunOutcome;
  rejected_overlays: Array<{ label: string; path: string; reason: string }>;
  /** Propose-stage provenance — stub-degraded or backend-less proposals must
   *  reach the caller, not only the report file. */
  propose_meta?: { backend_used: boolean; error?: string };
  selection: BlindRecommendation | null;
  experience: {
    cue: string;
    lesson: string;
    evidence: string;
    confidence: 'high' | 'medium' | 'low';
  } | null;
}

export function sessionSeed(sessionId: string): number {
  let h = 2166136261;
  for (const ch of sessionId) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export async function runContrastiveSession(
  spec: ContrastiveSessionSpec
): Promise<ContrastiveSessionResult> {
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  // Validate the probe spec before any backend spend — a bad command or
  // traversal expectOutputs must not surface only after LLM proposals ran.
  validateProbeSpec({ command: spec.command, expectOutputs: spec.expectOutputs });
  safeMkdir(runRoot, { recursive: true });

  const rejected: Array<{ label: string; path: string; reason: string }> = [];
  let propose_meta: { backend_used: boolean; error?: string } | undefined;
  const supplied = [...(spec.candidates ?? [])];

  // Label integrity BEFORE any probe or backend call — 'base' is reserved,
  // dupes corrupt run dirs, and a collision with a predicted proposed label
  // must be caught before spending propose calls.
  if (
    spec.propose &&
    (!Number.isInteger(spec.propose.count) || spec.propose.count < 1 || spec.propose.count > 10)
  ) {
    throw new Error('[CONTRASTIVE_SESSION] propose.count must be an integer 1..10');
  }
  const predicted = spec.propose
    ? Array.from(
        { length: spec.propose.count },
        (_, i) => `${spec.propose!.labelPrefix ?? 'llm'}${i + 1}`
      )
    : [];
  const allLabels = [...supplied.map((c) => c.label), ...predicted];
  if (allLabels.includes('base')) {
    throw new Error("[CONTRASTIVE_SESSION] 'base' is a reserved probe label");
  }
  if (new Set(allLabels).size !== allLabels.length) {
    throw new Error(`[CONTRASTIVE_SESSION] duplicate candidate labels: ${allLabels.join(', ')}`);
  }
  for (const label of allLabels) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label)) {
      throw new Error(`[CONTRASTIVE_SESSION] invalid candidate label ${JSON.stringify(label)}`);
    }
  }

  // Propose stage: LLM overlays written under runRoot/_proposed/<label>.
  if (spec.propose) {
    if (!spec.surface) {
      throw new Error('[CONTRASTIVE_SESSION] --propose requires a surface spec (--surface)');
    }
    const proposed = await proposeCandidates({
      brief: spec.propose.brief,
      surface: spec.surface,
      count: spec.propose.count,
      outDir: path.join(runRoot, '_proposed'),
      labelPrefix: spec.propose.labelPrefix,
      ...(spec.propose.library ? { library: spec.propose.library } : {}),
    });
    rejected.push(...proposed.rejected);
    // A degraded/empty propose run still yields evidence — record it as a
    // rejection so the decline report carries the reason instead of the
    // 'at least one candidate' throw misstating the cause.
    if (proposed.error && !proposed.candidates.length) {
      rejected.push({ label: 'propose', path: '.', reason: proposed.error });
    }
    propose_meta = {
      backend_used: proposed.backend_used,
      error: proposed.error || undefined,
    };
    supplied.push(
      ...proposed.candidates.map((c) => ({ label: c.label, overlayDir: c.overlayDir }))
    );
  }

  // Label integrity before anything runs — 'base' is reserved, dupes corrupt
  // run dirs and merge evidence across nominally distinct probes.
  const labels = supplied.map((c) => c.label);
  if (labels.includes('base')) {
    throw new Error("[CONTRASTIVE_SESSION] 'base' is a reserved probe label");
  }
  if (new Set(labels).size !== labels.length) {
    throw new Error(`[CONTRASTIVE_SESSION] duplicate candidate labels: ${labels.join(', ')}`);
  }
  for (const label of labels) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label)) {
      throw new Error(`[CONTRASTIVE_SESSION] invalid candidate label ${JSON.stringify(label)}`);
    }
  }

  // Surface validation: off-surface overlays are rejected, not probed.
  // Then the leak tripwire: a marker-bearing overlay is rejected too — it
  // must never reach a probe or be served as evidence later.
  const eligible = supplied.filter((c) => {
    if (spec.surface) {
      let v: ReturnType<typeof validateOverlay>;
      try {
        v = validateOverlay(c.overlayDir, spec.surface);
      } catch (error) {
        rejected.push({
          label: c.label,
          path: '.',
          reason: `overlay invalid: ${error instanceof Error ? error.message : error}`,
        });
        return false;
      }
      if (!v.ok) {
        rejected.push(
          ...v.rejected_files.map((r) => ({ label: c.label, path: r.path, reason: r.reason }))
        );
        return false;
      }
    }
    let scan;
    try {
      scan = scanOverlayForMarkers(c.overlayDir, spec.markers);
    } catch (error) {
      rejected.push({
        label: c.label,
        path: '.',
        reason: `overlay scan failed: ${error instanceof Error ? error.message : error}`,
      });
      return false;
    }
    if (!scan.clean) {
      rejected.push(
        ...scan.hits.map((h) => ({
          label: c.label,
          path: h.path,
          reason: `leak marker: ${h.marker} at ${h.path}:${h.line}`,
        }))
      );
      return false;
    }
    return true;
  });
  if (!eligible.length && !rejected.length) {
    throw new Error('[CONTRASTIVE_SESSION] at least one candidate overlay is required');
  }

  const probeFor = (label: string, overlayDir?: string): RunOutcome =>
    runProbe({
      label,
      scenarioDir: spec.scenarioDir,
      ...(overlayDir ? { overlayDir } : {}),
      command: spec.command,
      ...(spec.expectOutputs ? { expectOutputs: spec.expectOutputs } : {}),
      runRoot,
      timeoutMs: spec.timeoutMs,
    } satisfies ProbeSpec);

  // When every candidate was rejected there is nothing to contrast — skip the
  // base probe entirely and classify the empty set as missing evidence.
  const base = eligible.length ? probeFor('base') : null;
  const outcomes = eligible.map((c) => probeFor(c.label, c.overlayDir));
  const decision = classifyProbeSet(base, outcomes, spec.metrics ?? []);

  // Blind selection is a recommendation for the human gate — never a decision.
  const selection =
    spec.selection === 'blind' && decision.decision === 'human_gate'
      ? applyBlindSelection(
          [...(base ? [base] : []), ...outcomes],
          spec.seed ?? sessionSeed(spec.session_id),
          spec.selector ?? metricsFallbackSelector,
          undefined
        )
      : null;

  const experience =
    decision.decision === 'auto_advance' && decision.winner && base
      ? {
          cue: spec.work_shape || `contrastive probe on ${path.basename(spec.scenarioDir)}`,
          lesson: base.delivered
            ? `apply the '${decision.winner}' overlay; it dominated the base on the declared metrics`
            : `apply the '${decision.winner}' overlay; it delivered while the base failed the same scenario`,
          evidence: `base delivered=${base.delivered}, winner delivered=true; outcomes in ${runRoot}`,
          // Dominance over a delivering base is the stronger evidence;
          // a single delivery over a dead base may just be a broken baseline.
          confidence: base.delivered ? ('high' as const) : ('medium' as const),
        }
      : null;

  const baseResult: RunOutcome = base ?? {
    label: 'base',
    run_dir: '',
    ok: false,
    delivered: false,
    exit_code: null,
    wall_ms: 0,
    produced_files: [],
    staged_expected: [],
    error: 'no eligible candidates — base probe skipped',
    recorded_at: '',
  };
  const report = {
    session_id: spec.session_id,
    recorded_at: nowIso(),
    scenario_dir: spec.scenarioDir,
    command: spec.command,
    decision,
    selection,
    rejected_overlays: rejected,
    propose_meta,
    outcomes,
    base: baseResult,
    experience,
  };
  const reportPath = assertSafeRepositoryPath(path.join(runRoot, 'report.json'), {
    allowMissingLeaf: true,
  });
  safeWriteFile(reportPath, JSON.stringify(report, null, 2));
  ledger.record('CONTRASTIVE_SESSION', {
    session_id: spec.session_id,
    decision: decision.decision,
    winner: decision.winner,
    recommended: selection?.recommended_winner ?? null,
    probes: outcomes.length + (base ? 1 : 0),
    rejected: rejected.length,
  });
  return {
    report_path: reportPath,
    decision,
    outcomes,
    base: baseResult,
    rejected_overlays: rejected,
    ...(propose_meta ? { propose_meta } : {}),
    selection,
    experience,
  };
}
