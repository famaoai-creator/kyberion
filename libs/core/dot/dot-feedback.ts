/**
 * Dot learning loop — operator feedback and success-signal measurement.
 *
 * Two ledgers under `active/shared/runtime/`:
 *
 * - `dot-feedback.jsonl` — one row per settled decision (approved, rejected,
 *   expired, cancelled). Feedback shapes the next wake twice: recent rows are
 *   summarized into the wake prompt, and a rejection raises that action's
 *   decision floor (dot-wide) to `approve` until a human approves
 *   {@link DOT_FLOOR_RELEASE_APPROVALS} more of its actions. Rejections also land in the
 *   execution-feedback store so the distill pipeline can propose a reviewed
 *   improvement — feedback never silently rewrites a charter.
 * - `dot-signal-ledger.jsonl` — success-signal measurements from
 *   `goal.signal_probes` (healthy while the probe matches).
 */

import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { evaluateStateProbe, type StateProbeDeps } from '../state-probe.js';
import { VETO_WINDOW_DECIDER } from '../governance/approval-veto-window.js';
import type { DotCharter } from './dot-charter.js';
import type { DotDecisionLevel } from './dot-proposals.js';
import { createLogger } from '../logger.js';

const logger = createLogger('dot-feedback');

export const DOT_FEEDBACK_PATH = 'active/shared/runtime/dot-feedback.jsonl';
export const DOT_SIGNAL_LEDGER_PATH = 'active/shared/runtime/dot-signal-ledger.jsonl';
/** Feedback older than this no longer shapes floors or prompts. */
export const DOT_FEEDBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Approvals after the latest rejection needed before a learned floor lifts. */
export const DOT_FLOOR_RELEASE_APPROVALS = 3;
const DEFAULT_SIGNAL_EVERY_S = 900;

export type DotFeedbackOutcome = 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface DotFeedbackEntry {
  dot_id: string;
  action_id: string;
  action_ref: string;
  outcome: DotFeedbackOutcome;
  title: string;
  decided_by?: string;
  decided_by_type?: 'human' | 'ai_agent' | 'service';
  note?: string;
  recorded_at: string;
}

export interface DotSignalEntry {
  dot_id: string;
  signal: string;
  healthy: boolean;
  detail?: string;
  measured_at: string;
}

export interface DotFeedbackDeps {
  rootDir?: string;
  now?: () => Date;
  /** Distill hook for rejections; production records execution feedback. */
  onRejection?: (entry: DotFeedbackEntry) => void;
}

function runtimeFile(rootDir: string | undefined, rel: string): string {
  return path.join(rootDir ?? pathResolver.rootDir(), rel);
}

function appendRow(rel: string, value: unknown, rootDir?: string): void {
  const filePath = runtimeFile(rootDir, rel);
  safeMkdir(path.dirname(filePath), { recursive: true });
  appendJsonLine(filePath, value);
}

export function readDotFeedback(dotId: string, deps: DotFeedbackDeps = {}): DotFeedbackEntry[] {
  const cutoff = (deps.now?.() ?? new Date()).getTime() - DOT_FEEDBACK_WINDOW_MS;
  return readJsonLines<DotFeedbackEntry>(runtimeFile(deps.rootDir, DOT_FEEDBACK_PATH), {
    onMalformed: 'skip',
  }).filter(
    (row) =>
      row?.dot_id === dotId &&
      typeof row.action_id === 'string' &&
      Date.parse(row.recorded_at) >= cutoff
  );
}

async function recordRejectionForDistill(entry: DotFeedbackEntry): Promise<void> {
  const { recordExecutionFeedback, materializeExecutionFeedbackCandidate } =
    await import('../execution-feedback.js');
  const feedback = recordExecutionFeedback({
    scenario_id: `dot:${entry.dot_id}`,
    intent_id: entry.action_id,
    correlation_id: entry.action_ref,
    surface: 'dot',
    outcome: 'dissatisfied',
    comment: `Operator rejected "${entry.title}"${entry.note ? `: ${entry.note}` : ''}`,
    source: 'operator',
  });
  materializeExecutionFeedbackCandidate({ feedback, procedureId: `dot:${entry.dot_id}` });
}

/** Append one settled decision; rejections also feed the distill pipeline. */
export function recordDotFeedback(
  entry: Omit<DotFeedbackEntry, 'recorded_at'>,
  deps: DotFeedbackDeps = {}
): DotFeedbackEntry {
  const row: DotFeedbackEntry = {
    ...entry,
    recorded_at: (deps.now?.() ?? new Date()).toISOString(),
  };
  appendRow(DOT_FEEDBACK_PATH, row, deps.rootDir);
  if (row.outcome === 'rejected') {
    const hook =
      deps.onRejection ??
      ((rejected: DotFeedbackEntry) => {
        void recordRejectionForDistill(rejected).catch((error) =>
          logger.warn(
            `[dot-feedback] distill hand-off failed for ${rejected.dot_id} — ${error instanceof Error ? error.message : error} | next: the rejection is still in ${DOT_FEEDBACK_PATH}`
          )
        );
      });
    try {
      hook(row);
    } catch (error) {
      logger.warn(
        `[dot-feedback] rejection hook failed for ${row.dot_id} — ${error instanceof Error ? error.message : error}`
      );
    }
  }
  return row;
}

/** Only an explicit human decision re-earns trust; veto-window silence or an agent/service decider does not. */
function isHumanApproval(row: DotFeedbackEntry): boolean {
  return (
    row.outcome === 'approved' &&
    row.decided_by_type === 'human' &&
    row.decided_by !== VETO_WINDOW_DECIDER
  );
}

/**
 * Floor learned from operator feedback, dot-wide (a rejection is about the
 * dot's judgment, so re-labelling the work as another action cannot escape
 * it): `approve` while the latest rejection has not been followed by enough
 * human approvals, else undefined.
 */
export function learnedDotDecisionFloor(
  dotId: string,
  deps: DotFeedbackDeps = {}
): DotDecisionLevel | undefined {
  const rows = readDotFeedback(dotId, deps);
  let lastRejection = -1;
  rows.forEach((row, index) => {
    if (row.outcome === 'rejected') lastRejection = index;
  });
  if (lastRejection < 0) return undefined;
  const approvalsSince = rows.slice(lastRejection + 1).filter(isHumanApproval).length;
  return approvalsSince >= DOT_FLOOR_RELEASE_APPROVALS ? undefined : 'approve';
}

/** True when feedback for this action_ref was already recorded (settlement is idempotent). */
export function hasDotFeedbackFor(
  dotId: string,
  actionRef: string,
  deps: DotFeedbackDeps = {}
): boolean {
  return readDotFeedback(dotId, deps).some((row) => row.action_ref === actionRef);
}

/** Recent feedback, newest first, phrased for the wake prompt. */
export function dotFeedbackPromptLines(
  dotId: string,
  deps: DotFeedbackDeps = {},
  limit = 5
): string[] {
  return readDotFeedback(dotId, deps)
    .slice(-limit)
    .reverse()
    .map(
      (row) =>
        `- ${row.outcome}: "${row.title}" (${row.action_id})${row.note ? ` — ${row.note.slice(0, 200)}` : ''}`
    );
}

export function readDotSignals(dotId: string, deps: { rootDir?: string } = {}): DotSignalEntry[] {
  return readJsonLines<DotSignalEntry>(runtimeFile(deps.rootDir, DOT_SIGNAL_LEDGER_PATH), {
    onMalformed: 'skip',
  }).filter((row) => row?.dot_id === dotId && typeof row.signal === 'string');
}

/** Latest measurement per declared signal (undefined entries are unmeasured). */
export function latestDotSignals(
  charter: DotCharter,
  deps: { rootDir?: string } = {}
): Array<{ signal: string; latest?: DotSignalEntry }> {
  const rows = readDotSignals(charter.dot_id, deps);
  return (charter.goal.signal_probes ?? []).map(({ signal }) => {
    let latest: DotSignalEntry | undefined;
    for (const row of rows) if (row.signal === signal) latest = row;
    return { signal, ...(latest ? { latest } : {}) };
  });
}

/**
 * Measure every due `goal.signal_probes` entry (throttled by `every_s`,
 * default 15 min). Probe failures record `healthy: false` with the error so a
 * broken measurement is visible instead of silently stale.
 */
export async function measureDotSuccessSignals(
  charter: DotCharter,
  deps: { rootDir?: string; now?: () => Date; serviceCall?: StateProbeDeps['serviceCall'] } = {}
): Promise<DotSignalEntry[]> {
  const probes = charter.goal.signal_probes ?? [];
  if (probes.length === 0) return [];
  const now = deps.now?.() ?? new Date();
  const latest = new Map(
    latestDotSignals(charter, deps).map((entry) => [entry.signal, entry.latest])
  );
  const measured: DotSignalEntry[] = [];
  for (const spec of probes) {
    const previous = latest.get(spec.signal);
    const everyMs = (spec.every_s ?? DEFAULT_SIGNAL_EVERY_S) * 1000;
    if (previous && now.getTime() - Date.parse(previous.measured_at) < everyMs) continue;
    let entry: DotSignalEntry;
    try {
      const result = await evaluateStateProbe(spec.probe, {
        rootDir: deps.rootDir,
        serviceCall: deps.serviceCall,
      });
      entry = {
        dot_id: charter.dot_id,
        signal: spec.signal,
        healthy: result.matched,
        ...(result.detail ? { detail: String(result.detail).slice(0, 300) } : {}),
        measured_at: now.toISOString(),
      };
    } catch (error) {
      entry = {
        dot_id: charter.dot_id,
        signal: spec.signal,
        healthy: false,
        detail:
          `measurement failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            300
          ),
        measured_at: now.toISOString(),
      };
    }
    appendRow(DOT_SIGNAL_LEDGER_PATH, entry, deps.rootDir);
    measured.push(entry);
  }
  return measured;
}

/** Signal status lines for the wake prompt and digest. */
export function dotSignalStatusLines(
  charter: DotCharter,
  deps: { rootDir?: string } = {}
): string[] {
  return latestDotSignals(charter, deps).map(({ signal, latest }) =>
    latest
      ? `- ${latest.healthy ? 'OK' : 'NG'} ${signal}${latest.detail && !latest.healthy ? ` (${latest.detail})` : ''}`
      : `- ?? ${signal} (not measured yet)`
  );
}
