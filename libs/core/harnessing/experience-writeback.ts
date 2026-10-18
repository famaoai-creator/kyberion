/**
 * Experience write-back: turns a session's experience record into a library
 * lesson — but only through a quality gate. decline/keep_base/human_gate
 * outcomes are not reusable lessons; a refused probe, a drifted base, or a
 * failed materialization means the bytes adopted (or the contrast measured)
 * are not the evidence the decision saw. Identical cue+lesson rows are
 * deduped at the append-time horizon — a repeated lesson adds noise, not
 * signal.
 */

import * as path from 'node:path';
import { nowIso } from '../foundation/time.js';
import { appendLesson, lookupLessons, type LessonInput } from './experience-library.js';
import type { RunOutcome } from './probe-runner.js';

export interface ExperienceSink {
  /** Library root (repo-scoped dir holding <domain>.jsonl files). */
  root: string;
  domain: string;
}

export type ExperienceWriteback = 'persisted' | 'duplicate' | 'rejected';

/** One cue/lesson/evidence/confidence shape for single-shot sessions and
 *  recursive rounds — evidence cites the report path and the adopted label
 *  honestly (a decided-but-unmaterialized winner is not an adoption). */
export function buildExperienceRecord(opts: {
  workShape?: string;
  scenarioDir: string;
  base: RunOutcome;
  winner: string;
  /** The label as recorded in adopted_overlays / the report (e.g. 'r2:win'). */
  adoptedLabel: string;
  reportPath: string;
  materialized: boolean;
}): LessonInput {
  return {
    cue: opts.workShape || `contrastive probe on ${path.basename(opts.scenarioDir)}`,
    lesson: opts.base.delivered
      ? `apply the '${opts.winner}' overlay; it dominated the base on the declared metrics`
      : `apply the '${opts.winner}' overlay; it delivered while the base failed the same scenario`,
    evidence:
      `base delivered=${opts.base.delivered}, winner delivered=true; ` +
      `adopted '${opts.adoptedLabel}'${opts.materialized ? '' : ' (decided, not materialized)'}; ` +
      `report at ${opts.reportPath}; adopt staged_snapshot of the winner outcome ` +
      `(verified probed bytes), not the live overlayDir`,
    // Dominance over a delivering base is the stronger evidence; a single
    // delivery over a dead base may just be a broken baseline.
    confidence: opts.base.delivered ? 'high' : 'medium',
  };
}

/** The gate: persist ONLY a decisive, verified contrast — auto_advance with
 *  a winner whose probe ran and delivered (never a stage-refused outcome),
 *  no materialization failure behind the adoption, and no drifted base
 *  making the probes incomparable. */
export function experienceQualifies(opts: {
  decision: string;
  winner: string | null;
  winnerOutcome?: RunOutcome | null;
  halted_by?: string;
  base_drifted?: boolean;
}): boolean {
  if (opts.decision !== 'auto_advance' || !opts.winner) return false;
  const w = opts.winnerOutcome;
  if (!w || !w.ok || !w.delivered || w.probe_refused) return false;
  if (opts.halted_by === 'materialization_error') return false;
  if (opts.base_drifted === true) return false;
  return true;
}

/** Append through the gate; skip when an identical cue+lesson row is already
 *  visible asOf now (the append-time causal horizon). */
export function persistExperience(
  sink: ExperienceSink,
  experience: LessonInput,
  gate: Parameters<typeof experienceQualifies>[0]
): ExperienceWriteback {
  if (!experienceQualifies(gate)) return 'rejected';
  const duplicate = lookupLessons({
    libraryRoot: sink.root,
    domain: sink.domain,
    asOf: nowIso(),
  }).some((e) => e.cue === experience.cue && e.lesson === experience.lesson);
  if (duplicate) return 'duplicate';
  appendLesson({ libraryRoot: sink.root, domain: sink.domain, entry: experience });
  return 'persisted';
}
