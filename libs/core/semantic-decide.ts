import { createLogger } from './logger.js';
import { tryRepairJson } from './json-repair.js';

// AR-07: in-loop semantic decision primitive. Deterministic ops distill an
// observation (DOM inventory, UI tree, log tail); this helper asks the
// reasoning backend for ONE decision about it. Selection is preferred over
// generation: when `options` are provided, any reply outside the list is
// rejected and the caller falls back deterministically. A null return must
// never fail a pipeline — callers keep their legacy path.

const logger = createLogger('semantic-decide');

export interface DecideFromObservationInput {
  /** What the caller needs decided, e.g. "pick the selector for the submit button". */
  goal: string;
  /** Distilled observation (already size-capped by the producing op). */
  observation: string;
  /** When present, the decision MUST be one of these values (selection mode). */
  options?: string[];
  /** Extra instruction appended to the prompt (output shape hints etc.). */
  guidance?: string;
  /** Injectable for tests / stub environments. */
  generate?: (prompt: string) => Promise<string>;
}

export interface SemanticDecision {
  decision: string;
  reason?: string;
}

/**
 * LC-09: degradation registry. A null decision is a designed soft-fallback,
 * but it must be observable — pipelines that silently ride the deterministic
 * fallback on every step are indistinguishable from working ones otherwise.
 */
export type SemanticDecideDegradationReason = 'model_error' | 'option_rejected' | 'empty_decision';

export interface SemanticDecideDegradation {
  reason: SemanticDecideDegradationReason;
  goal: string;
  at: number;
}

const degradations: SemanticDecideDegradation[] = [];
const DEGRADATION_CAP = 200;
let consecutiveModelErrors = 0;

function recordDegradation(reason: SemanticDecideDegradationReason, goal: string): void {
  if (degradations.length < DEGRADATION_CAP) {
    degradations.push({ reason, goal: goal.slice(0, 120), at: Date.now() });
  }
  consecutiveModelErrors = reason === 'model_error' ? consecutiveModelErrors + 1 : 0;
}

export function getSemanticDecideDegradations(): readonly SemanticDecideDegradation[] {
  return degradations;
}

export function consecutiveSemanticDecideModelErrors(): number {
  return consecutiveModelErrors;
}

export function resetSemanticDecideDegradations(): void {
  degradations.length = 0;
  consecutiveModelErrors = 0;
}

const OBSERVATION_CAP = 12000;

export async function decideFromObservation(
  input: DecideFromObservationInput
): Promise<SemanticDecision | null> {
  const selection = Array.isArray(input.options) && input.options.length > 0;
  if (selection && input.options!.length === 1) {
    return { decision: input.options![0], reason: 'only candidate' };
  }
  const prompt = [
    'You are a precise automation assistant making ONE decision inside a running pipeline.',
    `Goal: ${input.goal}`,
    'Observation:',
    input.observation.slice(0, OBSERVATION_CAP),
    '',
    selection
      ? `Pick exactly one of these options (verbatim):\n${input.options!.map((option) => `- ${option}`).join('\n')}`
      : 'Answer concisely.',
    input.guidance ?? '',
    'Reply with ONLY a JSON object: { "decision": string, "reason": string }',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const generate =
      input.generate ??
      (async (p: string) => {
        const { getReasoningBackend } = await import('./reasoning-backend.js');
        return String(await getReasoningBackend().prompt(p));
      });
    const raw = await generate(prompt);
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    const decision = String(parsed?.decision ?? '').trim();
    if (!decision) {
      recordDegradation('empty_decision', input.goal);
      return null;
    }
    if (selection && !input.options!.includes(decision)) {
      logger.warn(
        `decision "${decision.slice(0, 80)}" is not among the offered options — rejected`
      );
      recordDegradation('option_rejected', input.goal);
      return null;
    }
    consecutiveModelErrors = 0;
    return {
      decision,
      ...(parsed?.reason ? { reason: String(parsed.reason).slice(0, 300) } : {}),
    };
  } catch (error: any) {
    logger.warn(`decideFromObservation failed (caller falls back): ${error?.message || error}`);
    recordDegradation('model_error', input.goal);
    return null;
  }
}

/**
 * AR-07 rollout helper: the shared `llm_decide` op body used by actuator
 * pipeline executors (browser / android / terminal). Extracts goal /
 * observation / options from step params, runs one decision, exports it and
 * its degradation reason, and honors `on_degraded: 'fail'` after N
 * consecutive model errors (LC-09).
 */
export async function executeLlmDecideOp(input: {
  params: Record<string, any>;
  ctx: Record<string, any>;
  resolve: (value: any) => any;
  /** Where the distilled observation lives when params.from is not given. */
  defaultFromKey: string;
}): Promise<Record<string, any>> {
  const { params, ctx, resolve } = input;
  const goal = String(resolve(params.goal) || '');
  if (!goal) throw new Error('llm_decide requires params.goal');
  const fromKey = String(params.from || input.defaultFromKey);
  const observationRaw = params.observation != null ? resolve(params.observation) : ctx[fromKey];
  const observation =
    typeof observationRaw === 'string' ? observationRaw : JSON.stringify(observationRaw ?? '');
  const options = Array.isArray(params.options)
    ? params.options.map((option: unknown) => String(resolve(option)))
    : undefined;

  const degradationsBefore = getSemanticDecideDegradations().length;
  const decision = await decideFromObservation({ goal, observation, options });
  let degradedReason: string | null = null;
  if (!decision) {
    const record = getSemanticDecideDegradations()[degradationsBefore];
    degradedReason = record?.reason ?? 'model_error';
    const onDegraded = String(params.on_degraded || 'continue');
    const threshold =
      typeof params.degraded_threshold === 'number' && params.degraded_threshold > 0
        ? params.degraded_threshold
        : 3;
    if (
      onDegraded === 'fail' &&
      degradedReason === 'model_error' &&
      consecutiveModelErrors >= threshold
    ) {
      throw new Error(
        `llm_decide degraded ${consecutiveModelErrors} consecutive time(s) on model errors (on_degraded: fail, threshold ${threshold}) — goal: ${goal}`
      );
    }
  }
  const exportAs = String(params.export_as || 'llm_decision');
  return {
    ...ctx,
    [exportAs]: decision,
    [`${exportAs}_degraded`]: degradedReason,
  };
}
