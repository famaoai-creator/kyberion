/**
 * Contrastive session: probe base + candidates on one scenario, classify the
 * evidence, and emit a report — including a harness2-shaped experience record
 * only when the decision is decisive enough to carry one.
 */

import * as path from 'node:path';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '../secure-io.js';
import { ledger } from '../ledger.js';
import { nowIso } from '../foundation/time.js';
import { runProbe, type ProbeSpec, type RunOutcome } from './probe-runner.js';
import { classifyProbeSet, type DecisionReport, type MetricSpec } from './decision-axis.js';

export interface ContrastiveSessionSpec {
  session_id: string;
  scenarioDir: string;
  command: string[];
  /** Candidate overlays: label -> overlay dir. 'base' runs with no overlay. */
  candidates: Array<{ label: string; overlayDir: string }>;
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
  experience: {
    cue: string;
    lesson: string;
    evidence: string;
    confidence: 'high' | 'medium' | 'low';
  } | null;
}

export function runContrastiveSession(spec: ContrastiveSessionSpec): ContrastiveSessionResult {
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  safeMkdir(runRoot, { recursive: true });
  if (!spec.candidates.length) {
    throw new Error('[CONTRASTIVE_SESSION] at least one candidate overlay is required');
  }
  // Validate labels up front — a 'base' candidate or duplicate label would
  // silently merge distinct probes into one run dir and corrupt the evidence.
  const labels = spec.candidates.map((c) => c.label);
  if (labels.includes('base')) {
    throw new Error("[CONTRASTIVE_SESSION] 'base' is a reserved probe label");
  }
  if (new Set(labels).size !== labels.length) {
    throw new Error(`[CONTRASTIVE_SESSION] duplicate candidate labels: ${labels.join(', ')}`);
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

  const base = probeFor('base');
  const outcomes = spec.candidates.map((c) => probeFor(c.label, c.overlayDir));
  const decision = classifyProbeSet(base, outcomes, spec.metrics ?? []);

  const experience =
    decision.decision === 'auto_advance' && decision.winner
      ? {
          cue: spec.work_shape || `contrastive probe on ${path.basename(spec.scenarioDir)}`,
          lesson: `apply the '${decision.winner}' overlay; it dominated the base under the same scenario`,
          evidence: `base delivered=${base.delivered}, winner delivered=true; outcomes in ${runRoot}`,
          confidence: base.delivered ? ('medium' as const) : ('high' as const),
        }
      : null;

  const report = {
    session_id: spec.session_id,
    recorded_at: nowIso(),
    scenario_dir: spec.scenarioDir,
    command: spec.command,
    decision,
    outcomes: outcomes.map((o) => ({ ...o, run_dir: o.run_dir })),
    base: { ...base, run_dir: base.run_dir },
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
    probes: outcomes.length + 1,
  });
  return { report_path: reportPath, decision, outcomes, experience };
}
