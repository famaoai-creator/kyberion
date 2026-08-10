/**
 * EV-07: one source of truth for how each system's event names map onto the
 * shared collaboration vocabulary.
 *
 * Six independent vocabularies exist by design — worker events, mission
 * orchestration events, mission task events, process watch kinds, operator
 * notification events, and the collaboration kinds the UI renders. What was
 * missing was the mapping *between* them. `collaborationKindFromEventType`
 * guessed it with a chain of `String.includes` tests, so it was:
 *
 *   - order-dependent: 'subagent_unavailable' had to be tested before
 *     'subagent', and 'mission_reconciliation_requested' matched 'reconcile'
 *     before anything else could claim it;
 *   - silently lossy: an unmapped name fell through to 'unknown', which the UI
 *     renders as an event it cannot explain;
 *   - invisible to review: adding an event type to any vocabulary changed the
 *     projection's behaviour with no diff in this file.
 *
 * The tables below are explicit and, for the closed vocabularies, exhaustive by
 * type: `Record<WorkerEventType, …>` will not compile if a worker event type is
 * added without deciding what it means here. Following QM-09's precedent, the
 * code *is* the registry — there is no parallel JSON to drift from it.
 *
 * Substring inference survives only as a last resort for the open-ended
 * `decision` strings that the runtime supervisor and journal writers emit, and
 * it is now anchored on explicit prefixes rather than bare `includes`.
 */

import type { CollaborationKind } from './agent-collaboration-events.js';
import type { WorkerEventType } from './worker-event-stream.js';
import type { MissionOrchestrationEventType } from './mission-orchestration-events.js';
import type { MissionTaskEventType } from './mission-task-events.js';
import type { ManagedProcessWatchEventKind } from './managed-process.js';
import type { OperatorEvent } from './operator-notifications.js';

/**
 * Worker event stream → collaboration kind.
 * Exhaustive by type: a new WORKER_EVENT_TYPES member breaks the build here.
 */
export const WORKER_EVENT_COLLABORATION_KIND: Record<WorkerEventType, CollaborationKind> = {
  turn_begin: 'progress',
  turn_end: 'progress',
  step_begin: 'progress',
  step_end: 'progress',
  compaction_begin: 'progress',
  compaction_end: 'progress',
  context_rewind: 'retry',
  status_update: 'progress',
  subagent_begin: 'spawn',
  subagent_end: 'completion',
  subagent_unavailable: 'failure',
  approval_request: 'approval',
  approval_response: 'approval',
  governance_action: 'review',
  notification: 'progress',
  mission_event: 'dispatch',
  phase_begin: 'progress',
  phase_end: 'progress',
  gate_evaluated: 'review',
};

/** Mission orchestration event → collaboration kind. Exhaustive by type. */
export const MISSION_ORCHESTRATION_COLLABORATION_KIND: Record<
  MissionOrchestrationEventType,
  CollaborationKind
> = {
  mission_issue_requested: 'dispatch',
  mission_team_prewarm_requested: 'spawn',
  mission_kickoff_requested: 'dispatch',
  mission_followup_requested: 'dispatch',
  mission_reconciliation_requested: 'retry',
  mission_distillation_requested: 'review',
  mission_completion_requested: 'completion',
  mission_control_requested: 'dispatch',
  surface_control_requested: 'dispatch',
};

/** Mission task event → collaboration kind. Exhaustive by type. */
export const MISSION_TASK_COLLABORATION_KIND: Record<MissionTaskEventType, CollaborationKind> = {
  task_issued: 'dispatch',
  task_submitted: 'artifact',
  task_reviewed: 'review',
  task_completed: 'completion',
  task_accepted: 'review',
  participant_context_resolved: 'progress',
};

/** Process watch kind → collaboration kind. Exhaustive by type. */
export const PROCESS_WATCH_COLLABORATION_KIND: Record<
  ManagedProcessWatchEventKind,
  CollaborationKind
> = {
  output: 'progress',
  exited: 'completion',
  expired: 'failure',
  lost: 'failure',
  quiet: 'blocked',
};

/** Operator notification event → collaboration kind. Exhaustive by type. */
export const OPERATOR_EVENT_COLLABORATION_KIND: Record<OperatorEvent, CollaborationKind> = {
  question: 'waiting',
  approval_required: 'approval',
  mission_completed: 'completion',
  mission_failed: 'failure',
  deliverable_ready: 'artifact',
  ops_alert: 'failure',
};

/**
 * Every closed vocabulary in one lookup. Names are globally unique across the
 * five vocabularies today; if a future collision appears, the per-vocabulary
 * tables above stay authoritative and this merge is where it must be resolved.
 */
const CLOSED_VOCABULARY: Readonly<Record<string, CollaborationKind>> = Object.freeze({
  ...WORKER_EVENT_COLLABORATION_KIND,
  ...MISSION_ORCHESTRATION_COLLABORATION_KIND,
  ...MISSION_TASK_COLLABORATION_KIND,
  ...PROCESS_WATCH_COLLABORATION_KIND,
  ...OPERATOR_EVENT_COLLABORATION_KIND,
});

export function isKnownEventType(eventType: string): boolean {
  return Object.hasOwn(CLOSED_VOCABULARY, eventType);
}

/** All event names covered by an explicit mapping, for tests and checkers. */
export function listKnownEventTypes(): string[] {
  return Object.keys(CLOSED_VOCABULARY).sort();
}

/**
 * Ordered inference rules for open-ended `decision` strings.
 *
 * These are not a fallback for the closed vocabularies — those are looked up
 * exactly. They exist because `appendSupervisorEvent` and the journal writers
 * emit free-form decision names (`agent_runtime_prewarm_timeout`, …) that no
 * enum constrains. Order matters and is asserted by tests: the most specific
 * rule must come first, which is precisely what the old bare-`includes` chain
 * got wrong.
 */
const INFERENCE_RULES: ReadonlyArray<{ pattern: RegExp; kind: CollaborationKind }> = Object.freeze([
  // Outcome words before subject words. Decision names are built as
  // <subject>_<verb>_<outcome> (`agent_runtime_prewarm_timeout`), so testing the
  // subject first misclassifies every terminal event about that subject — this
  // is why `runtime` must not appear as a spawn token at all: it is present in
  // *every* agent_runtime_* decision, including the ones that stopped or failed.
  { pattern: /unavailable|not_available/u, kind: 'failure' },
  { pattern: /timeout|timed_out/u, kind: 'failure' },
  { pattern: /fail|error|denied|rejected/u, kind: 'failure' },
  { pattern: /approval|approve/u, kind: 'approval' },
  { pattern: /handoff/u, kind: 'handoff' },
  { pattern: /reconcil|retry|restart|repair|refresh/u, kind: 'retry' },
  { pattern: /complete|finish|success|stopped|shutdown/u, kind: 'completion' },
  { pattern: /submit|artifact|deliverable/u, kind: 'artifact' },
  { pattern: /review|accept|distill|gate/u, kind: 'review' },
  { pattern: /claim|lease/u, kind: 'claim' },
  { pattern: /subagent|spawn|prewarm|ensure/u, kind: 'spawn' },
  { pattern: /dispatch|issue|request|kickoff/u, kind: 'dispatch' },
  { pattern: /block/u, kind: 'blocked' },
  { pattern: /wait|pending/u, kind: 'waiting' },
  { pattern: /step|progress|turn|update|resolved/u, kind: 'progress' },
]);

/**
 * Resolve an event name to a collaboration kind.
 *
 * Exact mapping first, then anchored inference for open-ended decision strings,
 * then 'unknown'. A caller that needs to distinguish "no mapping" from a real
 * verdict should ask {@link isKnownEventType} — the projection surfaces the
 * difference as its `unknown_event` status flag.
 */
export function resolveCollaborationKind(eventType: unknown): CollaborationKind {
  const raw = String(eventType ?? '').trim();
  if (!raw) return 'unknown';
  const exact = CLOSED_VOCABULARY[raw];
  if (exact) return exact;

  const normalized = raw.toLowerCase();
  for (const rule of INFERENCE_RULES) {
    if (rule.pattern.test(normalized)) return rule.kind;
  }
  return 'unknown';
}
