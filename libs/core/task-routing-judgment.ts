/**
 * Judgment assist for picking how much model a task needs.
 *
 * `resolveTaskModelHint()` already routes by phase kind, risk and scope — a
 * declared mapping, not a reading of the work. This asks a bounded question
 * over the task text instead: is this mechanical enough for the small tier?
 *
 * ## Why this call site is different from the other four
 *
 * Every other integration here has the same shape of danger: a wrong
 * judgment produces a wrong outcome nobody is asked about. A misfiled error
 * category drives the wrong repair; a wrongly dropped document leaves a
 * worker short of context and silent about it. That is why they all default
 * to `requireCalibrated` and sit inert.
 *
 * Routing is not like that. Send a task to too small a model and it fails,
 * visibly, and dispatch escalates and retries. The cost of being wrong is a
 * round trip, and — this is the part that matters — **the retry is a label**.
 * "Small was chosen, small failed, large succeeded" is exactly the
 * (input, correct answer) pair that every other call site here lacks and
 * could not manufacture. `recordRoutingOutcome()` writes those down.
 *
 * So this is the one place where a corpus accumulates from real work rather
 * than from whoever wrote the bench, which makes it the first call site with
 * a route to `judgment-calibration.json` that does not depend on someone
 * finding time to label things.
 *
 * ## Which direction a judgment may move the tier
 *
 * Downward only, and only from the baseline the deterministic router chose:
 *
 * - **Down** (`standard` → `small`) is the saving, and its failure mode is a
 *   visible retry. Allowed on a confident judgment.
 * - **Up** is not this function's business. Escalation belongs to dispatch,
 *   which knows the task actually failed; a judgment guessing that something
 *   looks hard would only spend money on a suspicion.
 * - **Never below `floorTier`**, and never for a phase the caller marked
 *   as unsuitable — a downgrade that cannot be retried is not a saving.
 */

import { assistWithJudgment, choiceAnswer } from './judgment-assist.js';
import type { JudgmentQuestion } from './judgment-backend.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { isVitestProcess } from './foundation/env.js';
import { createLogger } from './logger.js';
import type { TaskModelHint } from './reasoning-model-routing.js';
import type { TaskModelPhaseKind, TaskModelTier } from './reasoning-level-policy.js';
import type { TierLevel } from './types.js';
import * as nodePath from 'node:path';

const logger = createLogger('task-routing-judgment');

export const TASK_TIER_QUESTION = 'task.model_tier';

const TIER_ORDER: TaskModelTier[] = ['small', 'standard', 'large'];

export const TASK_TIER_DESCRIPTIONS: Record<TaskModelTier, string> = {
  small:
    'mechanical work with the answer already determined: renaming, moving text, applying a stated edit, filling a known template',
  standard:
    'ordinary work needing judgement but not exploration: writing a function against a clear spec, reviewing a small diff, summarising',
  large:
    'work needing design, exploration across many files, or weighing trade-offs with no single right answer',
};

export function taskTierQuestion(): JudgmentQuestion {
  return {
    kind: 'choice',
    id: TASK_TIER_QUESTION,
    options: TIER_ORDER,
    optionDescriptions: TASK_TIER_DESCRIPTIONS,
    instructions:
      'This is a task about to be given to a coding agent. How much model does it need?',
  };
}

export interface RouteTaskInput {
  /** What the worker has been asked to do. */
  task: string;
  /** What `resolveTaskModelHint()` decided; never exceeded. */
  baseline: TaskModelHint;
  phaseKind?: TaskModelPhaseKind;
  /** Never go below this. Default 'small'. */
  floorTier?: TaskModelTier;
  /** Task text is work-in-progress material: personal unless told otherwise. */
  tier?: TierLevel;
  tenantSlug?: string;
  minConfidence?: number;
  timeoutMs?: number;
  /**
   * Unlike the other call sites this defaults to **false**, because a wrong
   * answer here costs a visible retry rather than a silent error, and the
   * retry is the label that makes calibration possible at all. A caller
   * whose dispatch cannot escalate should set it to true.
   */
  requireCalibrated?: boolean;
}

export interface RouteTaskResult {
  hint: TaskModelHint;
  source: 'baseline' | 'judgment';
  reason: string;
  /** Set when a judgment moved the tier down; dispatch must be able to retry. */
  downgradedFrom?: TaskModelTier;
}

/**
 * Narrow the model tier for a task, or keep what the router chose.
 */
export async function routeTaskWithJudgment(input: RouteTaskInput): Promise<RouteTaskResult> {
  const floor = input.floorTier ?? 'small';
  const baselineIndex = TIER_ORDER.indexOf(input.baseline.tier);
  const floorIndex = TIER_ORDER.indexOf(floor);

  if (baselineIndex <= floorIndex) {
    return {
      hint: input.baseline,
      source: 'baseline',
      reason: `already at or below the floor tier '${floor}'`,
    };
  }

  const result = await assistWithJudgment<TaskModelHint>({
    baseline: input.baseline,
    state: input.task,
    questions: [taskTierQuestion()],
    tier: input.tier ?? 'personal',
    ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    ...(input.minConfidence !== undefined ? { minConfidence: input.minConfidence } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    requireCalibrated: input.requireCalibrated === true,
    label: TASK_TIER_QUESTION,
    accept(answers, baseline) {
      const answer = choiceAnswer(answers, TASK_TIER_QUESTION);
      const proposed = answer?.value as TaskModelTier | undefined;
      if (!proposed || !TIER_ORDER.includes(proposed)) return undefined;
      const proposedIndex = TIER_ORDER.indexOf(proposed);
      // Down only, and not past the floor. Escalation is dispatch's job: it
      // knows the task failed, where this only has a hunch that it might.
      if (proposedIndex >= baselineIndex) return undefined;
      if (proposedIndex < floorIndex) return undefined;
      return {
        ...baseline,
        tier: proposed,
        route_reason: `${baseline.route_reason}; narrowed to '${proposed}' by judgment`,
      };
    },
  });

  return {
    hint: result.value,
    source: result.source,
    reason: result.reason,
    ...(result.source === 'judgment' ? { downgradedFrom: input.baseline.tier } : {}),
  };
}

// --- outcome ledger ----------------------------------------------------------

/**
 * Failures that happen before any model sees the task.
 *
 * Matched on the codes dispatch already emits. Anything unrecognised is
 * treated as attempted — misfiling a real model failure as infrastructure
 * would hide exactly the signal the corpus exists to collect, so the list
 * only grows when a code is known to fire before the model runs.
 */
const NOT_ATTEMPTED_CODES = [
  'CONTEXT_EGRESS_DENIED',
  'PROVIDER_EGRESS_DENIED',
  'EXECUTION_SURFACE_UNAVAILABLE',
  'AGENT_RUNTIME_AWAITING_HUMAN',
  // A person declined a prompt the agent stopped on. Mid-turn the model has
  // run, but what ended the turn was a person's decision, not its capability.
  'AGENT_RUNTIME_PROMPT_DECLINED',
  'MISSION_WORKITEM_SCOPE_REQUIRED',
  'SCOPE_CONTEXT_INVALID',
];

/** The code that stopped dispatch before the model, if any. */
export function classifyDispatchFailure(notes: readonly string[]): string | undefined {
  for (const note of notes) {
    for (const code of NOT_ATTEMPTED_CODES) {
      if (note.includes(`[${code}]`)) return code;
    }
  }
  return undefined;
}

export interface RoutingOutcome {
  /** Task text, truncated; the input half of a labelled pair. */
  task_excerpt: string;
  phase_kind?: TaskModelPhaseKind;
  /** What the deterministic router chose. */
  baseline_tier: TaskModelTier;
  /** What actually ran. */
  chosen_tier: TaskModelTier;
  chosen_by: 'baseline' | 'judgment';
  /** Whether the chosen tier completed the task. */
  succeeded: boolean;
  /**
   * Whether the model was ever asked.
   *
   * A dispatch that fails before the model runs says nothing about the
   * model. The first six entries this ledger ever held were all like that —
   * four with no A2A route and two refused by the egress gate — and every
   * one was recorded as the small tier failing a task it never saw. Those
   * are infrastructure and policy outcomes, and treating them as model
   * failures would teach a router that small models are bad at things they
   * were not allowed to attempt.
   *
   * `not_attempted` entries stay in the ledger, because they are useful for
   * seeing what keeps blocking dispatch, and `exportRoutingCorpus()` ignores
   * them. Absent on older entries; read as `attempted`.
   */
  outcome?: 'attempted' | 'not_attempted';
  /** Why a `not_attempted` entry never reached the model. */
  not_attempted_reason?: string;
  /** The tier that did complete it, when the chosen one did not. */
  escalated_to?: TaskModelTier;
  recorded_at: string;
}

const LEDGER_RELATIVE = nodePath.join('active', 'shared', 'runtime', 'routing-outcomes.jsonl');
const EXCERPT_LEN = 300;

function ledgerPath(): string {
  return nodePath.join(pathResolver.rootDir(), LEDGER_RELATIVE);
}

/**
 * Record what a routing decision turned out to be worth.
 *
 * This is the labelled corpus. A task that ran on `small` and succeeded is a
 * positive for `small`; one that failed and completed on `large` is a
 * positive for `large` and a labelled mistake for whatever chose `small`.
 * Both halves come from work that was going to happen anyway.
 *
 * Skipped under vitest for the same reason the unclassified-error registry
 * is: a suite that exercises routing on purpose would otherwise fill the
 * corpus with fixtures, and fixtures must not become evidence.
 */
export function recordRoutingOutcome(
  outcome: Omit<RoutingOutcome, 'recorded_at' | 'task_excerpt'> & { task: string }
): void {
  if (isVitestProcess()) return;
  try {
    const record: RoutingOutcome = {
      task_excerpt: String(outcome.task || '').slice(0, EXCERPT_LEN),
      ...(outcome.phase_kind ? { phase_kind: outcome.phase_kind } : {}),
      baseline_tier: outcome.baseline_tier,
      chosen_tier: outcome.chosen_tier,
      chosen_by: outcome.chosen_by,
      succeeded: outcome.succeeded,
      ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
      ...(outcome.not_attempted_reason
        ? { not_attempted_reason: outcome.not_attempted_reason }
        : {}),
      ...(outcome.escalated_to ? { escalated_to: outcome.escalated_to } : {}),
      recorded_at: nowIso(),
    };
    const file = ledgerPath();
    safeMkdir(nodePath.dirname(file), { recursive: true });
    const existing = safeExistsSync(file) ? String(safeReadFile(file, { encoding: 'utf8' })) : '';
    safeWriteFile(file, `${existing}${JSON.stringify(record)}\n`, { encoding: 'utf8' });
  } catch (error: unknown) {
    // Losing a label must never fail the work that produced it.
    logger.warn(
      `[task-routing-judgment] could not record routing outcome: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * The accumulated outcomes, as evaluation or calibration input.
 *
 * `expected_tier` is the smallest tier observed to succeed for that task —
 * which is what a correct router would have chosen.
 */
export function loadRoutingOutcomes(): RoutingOutcome[] {
  try {
    const file = ledgerPath();
    if (!safeExistsSync(file)) return [];
    return String(safeReadFile(file, { encoding: 'utf8' }))
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RoutingOutcome);
  } catch (error: unknown) {
    logger.warn(
      `[task-routing-judgment] routing outcome ledger unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

export interface RoutingCorpusItem {
  task_excerpt: string;
  phase_kind?: TaskModelPhaseKind;
  /** The smallest tier observed to complete this task. */
  expected_tier: TaskModelTier;
  observations: number;
}

/** Collapse the ledger into one labelled item per task. */
export function exportRoutingCorpus(): RoutingCorpusItem[] {
  const byTask = new Map<string, RoutingOutcome[]>();
  for (const outcome of loadRoutingOutcomes()) {
    // A policy refusal or a missing route is not evidence about any tier.
    if (outcome.outcome === 'not_attempted') continue;
    const list = byTask.get(outcome.task_excerpt) || [];
    list.push(outcome);
    byTask.set(outcome.task_excerpt, list);
  }

  const items: RoutingCorpusItem[] = [];
  for (const [task, outcomes] of byTask) {
    const succeeded = outcomes
      .map((outcome) =>
        outcome.succeeded ? outcome.chosen_tier : outcome.escalated_to || undefined
      )
      .filter((tier): tier is TaskModelTier => Boolean(tier));
    if (succeeded.length === 0) continue;
    const smallest = succeeded.reduce((best, tier) =>
      TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(best) ? tier : best
    );
    const phase = outcomes.find((outcome) => outcome.phase_kind)?.phase_kind;
    items.push({
      task_excerpt: task,
      ...(phase ? { phase_kind: phase } : {}),
      expected_tier: smallest,
      observations: outcomes.length,
    });
  }
  return items;
}
