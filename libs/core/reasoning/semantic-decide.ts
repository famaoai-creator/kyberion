import { createLogger } from '../logger.js';
import { tryRepairJson } from '../foundation/json-repair.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isRecord } from '../foundation/text.js';
import type { TierLevel } from '../types.js';
import { assistWithJudgment, choiceAnswer } from './judgment-assist.js';
import { BUILTIN_JUDGMENT_PROVIDER, listJudgmentBackends } from './judgment-backend.js';
import { ensureJudgmentBackendsRegistered } from './judgment-provider-bootstrap.js';

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
  /** Optional descriptions keyed by option value to boost System-1 accuracy. */
  optionDescriptions?: Readonly<Record<string, string>>;
  /** Extra instruction appended to the prompt (output shape hints etc.). */
  guidance?: string;
  /** Highest data tier present in observation; defaults fail-closed to confidential. */
  tier?: TierLevel;
  /** Optional tenant slug for provider egress checks. */
  tenantSlug?: string;
  /** Minimum confidence accepted from System-1 judgment-backend. Default 0.65. */
  minJudgmentConfidence?: number;
  /** Timeout budget in ms for System-1 judgment-backend lookup. Default 4000. */
  timeoutMs?: number;
  /** Whether to consult registered System-1 judgment-backend providers first. Default true. */
  useJudgmentBackend?: boolean;
  /** Injectable for tests / stub environments. */
  generate?: (prompt: string) => Promise<string>;
}

export interface SemanticDecision {
  decision: string;
  reason?: string;
  source?: 'singleton' | 'judgment' | 'reasoning';
  provider_id?: string;
  confidence?: number;
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
const DEFAULT_MIN_JUDGMENT_CONFIDENCE = 0.65;
const DEFAULT_JUDGMENT_TIMEOUT_MS = 4_000;
export const SEMANTIC_DECIDE_QUESTION = 'semantic_decide.option';

async function tryJudgmentSelection(
  input: DecideFromObservationInput,
  options: readonly string[]
): Promise<SemanticDecision | null> {
  if (options.length < 2 || input.generate || input.useJudgmentBackend === false) {
    return null;
  }
  ensureJudgmentBackendsRegistered();
  const hasNonFloor = listJudgmentBackends().some(
    (backend) => backend.judgment_id !== BUILTIN_JUDGMENT_PROVIDER
  );
  if (!hasNonFloor) return null;

  const assisted = await assistWithJudgment<string | null>({
    baseline: null,
    state: input.observation.slice(0, OBSERVATION_CAP),
    questions: [
      {
        kind: 'choice',
        id: SEMANTIC_DECIDE_QUESTION,
        options,
        instructions: input.guidance ? `${input.goal}\n${input.guidance}` : input.goal,
        ...(input.optionDescriptions ? { optionDescriptions: input.optionDescriptions } : {}),
      },
    ],
    tier: input.tier ?? 'confidential',
    ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    minConfidence: input.minJudgmentConfidence ?? DEFAULT_MIN_JUDGMENT_CONFIDENCE,
    timeoutMs: input.timeoutMs ?? DEFAULT_JUDGMENT_TIMEOUT_MS,
    requireCalibrated: false,
    label: 'semantic-decide',
    accept: (answers) => {
      const answer = choiceAnswer(answers, SEMANTIC_DECIDE_QUESTION);
      if (!answer || typeof answer.value !== 'string') return undefined;
      return options.includes(answer.value) ? answer.value : undefined;
    },
  });

  if (assisted.source !== 'judgment' || !assisted.value) {
    logger.debug(
      `[semantic-decide] judgment declined (${assisted.reason}); falling back to reasoning backend`
    );
    return null;
  }
  consecutiveModelErrors = 0;
  const confidence = assisted.answers?.[0]?.confidence;
  return {
    decision: assisted.value,
    reason: assisted.reason.slice(0, 300),
    source: 'judgment',
    ...(assisted.provider_id ? { provider_id: assisted.provider_id } : {}),
    ...(typeof confidence === 'number' && Number.isFinite(confidence) ? { confidence } : {}),
  };
}

export async function decideFromObservation(
  input: DecideFromObservationInput
): Promise<SemanticDecision | null> {
  const uniqueOptions = Array.isArray(input.options)
    ? Array.from(new Set(input.options))
    : undefined;
  const selection = Array.isArray(uniqueOptions) && uniqueOptions.length > 0;
  if (selection && uniqueOptions.length === 1) {
    return { decision: uniqueOptions[0], reason: 'only candidate' };
  }
  const judgmentHit = uniqueOptions ? await tryJudgmentSelection(input, uniqueOptions) : null;
  if (judgmentHit) return judgmentHit;
  const prompt = [
    'You are a precise automation assistant making ONE decision inside a running pipeline.',
    `Goal: ${input.goal}`,
    'Observation:',
    input.observation.slice(0, OBSERVATION_CAP),
    '',
    selection
      ? `Pick exactly one of these options (verbatim):\n${uniqueOptions.map((option) => `- ${option}`).join('\n')}`
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
    let parsed: unknown;
    try {
      parsed = parseSafeJsonInput(jsonText, 'semantic decision response');
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    const parsedRecord = isRecord(parsed) ? parsed : undefined;
    const decision = typeof parsedRecord?.decision === 'string' ? parsedRecord.decision.trim() : '';
    if (!decision) {
      recordDegradation('empty_decision', input.goal);
      return null;
    }
    if (selection && !uniqueOptions.includes(decision)) {
      logger.warn(
        `decision "${decision.slice(0, 80)}" is not among the offered options — rejected`
      );
      recordDegradation('option_rejected', input.goal);
      return null;
    }
    consecutiveModelErrors = 0;
    return {
      decision,
      ...(typeof parsedRecord?.reason === 'string' && parsedRecord.reason
        ? { reason: parsedRecord.reason.slice(0, 300) }
        : {}),
    };
  } catch (error: unknown) {
    logger.warn(
      `decideFromObservation failed (caller falls back): ${error instanceof Error ? error.message : String(error)}`
    );
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
  params: Record<string, unknown>;
  ctx: Record<string, unknown>;
  resolve: (value: unknown) => unknown;
  /** Where the distilled observation lives when params.from is not given. */
  defaultFromKey: string;
}): Promise<Record<string, unknown>> {
  const { params, ctx, resolve } = input;
  const goal = String(resolve(params.goal) || '');
  if (!goal) throw new Error('llm_decide requires params.goal');
  const fromKey = String(params.from || input.defaultFromKey);
  const observationRaw = params.observation != null ? resolve(params.observation) : ctx[fromKey];
  const observation =
    typeof observationRaw === 'string' ? observationRaw : JSON.stringify(observationRaw ?? '');
  const options = Array.isArray(params.options)
    ? params.options.map((option) => String(resolve(option)))
    : undefined;
  const tierRaw = params.tier !== undefined ? String(resolve(params.tier) ?? '').trim() : '';
  const tier: TierLevel | undefined =
    tierRaw === 'public' || tierRaw === 'confidential' || tierRaw === 'personal'
      ? tierRaw
      : undefined;
  const tenantRaw =
    params.tenant_slug !== undefined ? String(resolve(params.tenant_slug) ?? '').trim() : '';
  const rawDescriptions =
    params.option_descriptions !== undefined ? resolve(params.option_descriptions) : undefined;
  const optionDescriptions = isRecord(rawDescriptions)
    ? Object.fromEntries(
        Object.entries(rawDescriptions).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : undefined;

  const degradationsBefore = getSemanticDecideDegradations().length;
  const decision = await decideFromObservation({
    goal,
    observation,
    options,
    ...(tier ? { tier } : {}),
    ...(tenantRaw ? { tenantSlug: tenantRaw } : {}),
    ...(optionDescriptions && Object.keys(optionDescriptions).length > 0
      ? { optionDescriptions }
      : {}),
  });
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
    [`${exportAs}_source`]: decision ? (decision.source ?? 'reasoning') : null,
    [`${exportAs}_degraded`]: degradedReason,
  };
}
