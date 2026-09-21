/**
 * Judgment backend seam.
 *
 * A *judgment* is a bounded, typed question asked over a piece of state —
 * "which of these six shapes is this?", "is this done?", "how risky is
 * this?" — answered with a value and a confidence, and nothing else. It is
 * deliberately not a reasoning call: no prose, no explanation, no tool use.
 * `reasoning-backend` (`delegateTask(instruction, context) => string`) is
 * the wrong shape for this and must not be used as one.
 *
 * Two things this seam exists to fix, both measured on mission
 * JUDGMENT-SEAM-20260921 (`evidence/A1-baseline-confidence-audit.md`):
 *
 * - **Confidence in this repo is not a probability.** The organization-work
 *   classifier returned one of nine hard-coded constants; the values below
 *   the `< 0.7` human-confirmation threshold (0.40 / 0.58 / 0.62) and the
 *   values at or above it (0.80 … 0.93) were completely disjoint, so the
 *   threshold was exactly equivalent to "did any regex match" and could be
 *   moved anywhere in (0.62, 0.80] without changing behavior.
 * - **Nothing recorded that.** A caller reading `confidence` could not tell
 *   a fitted estimate from a table lookup.
 *
 * So `JudgmentAnswer.calibrated` is the load-bearing field here, and a
 * provider is **not allowed to declare it**. It is derived from
 * `judgment-calibration.json` by `resolveCalibration()`: a provider is
 * calibrated only where a fitted entry exists for it, and `false`
 * otherwise. A model that reports "0.95" about everything (observed:
 * `evidence/A2-local-candidate-comparison.md`, F-5) therefore cannot buy
 * its way past a caller that requires calibration.
 *
 * Providers register as named entries. Callers never name one: they pass
 * the data tier, and `selectJudgmentBackend()` filters by
 * `checkProviderEgress()` so `personal` material can only reach a
 * `local-only` provider and `confidential` only a tenant-approved one. When
 * nothing survives the filter the call degrades to the built-in provider
 * with a reason rather than throwing — a judgment seam must never be able
 * to stop ordinary work.
 *
 * This seam scores. It does not decide. Route selection stays deterministic
 * and fail-closed in `judge-route.ts`; a missing, slow or wrong provider can
 * only move a confidence, never a branch.
 */

import { coreSeamCatalog, createSeam } from './seam.js';
import { checkProviderEgress, type ProviderEgressLabel } from './provider-egress-gate.js';
import { pathResolver } from './path-resolver.js';
import { readJsonIfPresent } from './foundation/json.js';
import { createLogger } from './logger.js';
import type { TierLevel } from './types.js';

const logger = createLogger('judgment-backend');

/** Built-in provider id. Always present, always `local-only`, never calibrated. */
export const BUILTIN_JUDGMENT_PROVIDER = 'builtin-rules';

/**
 * `instructions` states what is being asked in one line. A rule provider can
 * ignore it — its question is baked into its patterns — but a model provider
 * needs it, so it belongs on the question rather than in provider config.
 *
 * `optionDescriptions` gives each choice option a sentence, and is worth far
 * more than its optionality suggests: asked with bare identifiers, the
 * Laya-MLX provider got 1 of 6 unambiguous Japanese requests right; asked
 * with a description per option, 6 of 6. Options named `incident_response` /
 * `routine_operation` are legible to whoever named them and to nobody else.
 */
export type JudgmentQuestion =
  | {
      kind: 'choice';
      id: string;
      options: readonly string[];
      /** One sentence per option; keys outside `options` are ignored. */
      optionDescriptions?: Readonly<Record<string, string>>;
      instructions?: string;
    }
  | { kind: 'bool'; id: string; instructions?: string }
  | { kind: 'score'; id: string; range: readonly [number, number]; instructions?: string };

/**
 * `{option: description}` for a model provider, falling back to an option's
 * own identifier where no description was supplied.
 */
export function describeChoiceOptions(
  question: JudgmentQuestion & { kind: 'choice' }
): Record<string, string> {
  return Object.fromEntries(
    question.options.map((option) => [option, question.optionDescriptions?.[option] || option])
  );
}

/**
 * The material being judged.
 *
 * Text was the only shape for a while, and it was a real limit rather than an
 * omission: `judgePageReadiness` can read a page's words but cannot see a
 * spinner, a half-painted layout, or a modal covering the content — exactly
 * the cases a screenshot settles at a glance. Providers that take pixels
 * exist (PlayJev reads one 448px frame and returns a distribution over the
 * options in a single forward pass), so the type carries an image now and
 * `acceptsImages` decides who may see it.
 */
export type JudgmentState =
  | string
  | {
      text?: string;
      /** Raw image bytes, base64, without a data: prefix. */
      imageBase64: string;
      /** Media type of `imageBase64`, e.g. 'image/png'. */
      imageMediaType?: string;
    };

/** Whether this state carries anything a text-only provider cannot read. */
export function stateHasImage(state: JudgmentState): boolean {
  return typeof state !== 'string' && Boolean(state?.imageBase64);
}

/** The text of a state, for a provider or a log that only handles words. */
export function stateText(state: JudgmentState): string {
  return typeof state === 'string' ? state : state?.text || '';
}

export interface JudgmentRequest {
  /** The material being judged; a string, or text and an image. */
  state: JudgmentState;
  /** Independent questions asked together over the same `state`. */
  questions: readonly JudgmentQuestion[];
  /** Highest data tier represented in `state`; drives provider eligibility. */
  tier: TierLevel;
  /** Optional tenant upper bound; can only narrow the allowed provider set. */
  tenantSlug?: string;
}

export interface JudgmentAnswer {
  /** Matches the `id` of the question this answers. */
  id: string;
  value: string | boolean | number;
  /** 0..1. Meaningful as a probability only when `calibrated` is true. */
  confidence: number;
  /**
   * Whether `confidence` is a fitted estimate. Derived from the calibration
   * registry, never from the provider's own claim.
   */
  calibrated: boolean;
  /** Provider-supplied detail for audit; never interpreted as authorization. */
  signals?: Record<string, unknown>;
}

export interface JudgmentResult {
  answers: readonly JudgmentAnswer[];
  provider_id: string;
  /** DH-03: deterministic explanation of why this provider answered. */
  reason: string;
}

export interface JudgmentBackend {
  readonly judgment_id: string;
  readonly egress: ProviderEgressLabel;
  /**
   * Whether this provider can see an image in the state.
   *
   * Absent means no, which is the safe default: a text-only provider handed
   * an image would answer from the text alone and look like it had looked at
   * the picture. `selectJudgmentBackend` filters on this, so a caller that
   * sends a screenshot to a repository where nothing accepts one gets its
   * baseline back rather than a confident answer about the caption.
   */
  readonly acceptsImages?: boolean;
  /** Whether this provider can answer a given question shape at all. */
  supports(question: JudgmentQuestion): boolean;
  /**
   * Answer every question in `request`. Implementations return raw
   * confidence; the seam overwrites `calibrated` from the registry.
   */
  judge(request: JudgmentRequest): Promise<readonly JudgmentAnswer[]>;
}

const judgmentSeam = createSeam<JudgmentBackend>({
  key: 'judgment-backend',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

const registeredDisposers = new Map<string, () => void>();

export function registerJudgmentBackend(backend: JudgmentBackend): () => void {
  const id = String(backend?.judgment_id || '').trim();
  if (!id) throw new TypeError('JudgmentBackend.judgment_id is required');
  if (backend.egress !== 'local-only' && backend.egress !== 'external-api') {
    throw new TypeError(
      `JudgmentBackend '${id}' must declare egress as 'local-only' or 'external-api'`
    );
  }
  registeredDisposers.get(id)?.();
  const dispose = judgmentSeam.register(id, backend, {
    provenance: 'builtin',
    source: 'judgment-backend',
  });
  registeredDisposers.set(id, dispose);
  return dispose;
}

export function resetJudgmentBackends(): void {
  for (const dispose of registeredDisposers.values()) {
    try {
      dispose();
    } catch {
      /* a disposer that already ran must not block the rest */
    }
  }
  registeredDisposers.clear();
  calibrationCache = undefined;
}

export function listJudgmentBackends(): readonly JudgmentBackend[] {
  return judgmentSeam.list().map((entry) => entry.implementation);
}

// --- calibration registry ---------------------------------------------------

export interface JudgmentCalibrationEntry {
  /** Question ids this fit covers; '*' covers every question. */
  questions: readonly string[];
  /** Bench the fit was produced from; recorded for audit, not read back. */
  fitted_from: string;
  fitted_at: string;
}

interface JudgmentCalibrationFile {
  version?: string;
  providers?: Record<string, JudgmentCalibrationEntry>;
}

let calibrationCache: JudgmentCalibrationFile | undefined;

function loadCalibrationFile(): JudgmentCalibrationFile {
  if (calibrationCache) return calibrationCache;
  const file = pathResolver.knowledge('product/governance/judgment-calibration.json');
  try {
    const parsed = readJsonIfPresent<JudgmentCalibrationFile>(file);
    calibrationCache = parsed && typeof parsed === 'object' ? parsed : { providers: {} };
  } catch (error: unknown) {
    // An unreadable calibration file must not make anything *look* calibrated.
    logger.warn(
      `[judgment-backend] calibration registry unreadable; treating every provider as uncalibrated: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    calibrationCache = { providers: {} };
  }
  return calibrationCache;
}

/**
 * Whether `providerId` has a fitted calibration for `questionId`.
 * The built-in rule provider can never be calibrated: its confidence is a
 * table lookup, not an estimate, and saying otherwise is the bug this seam
 * was built to stop.
 */
export function resolveCalibration(providerId: string, questionId: string): boolean {
  if (providerId === BUILTIN_JUDGMENT_PROVIDER) return false;
  const entry = loadCalibrationFile().providers?.[providerId];
  if (!entry || !Array.isArray(entry.questions)) return false;
  return entry.questions.includes('*') || entry.questions.includes(questionId);
}

// --- selection --------------------------------------------------------------

export interface JudgmentSelection {
  backend: JudgmentBackend;
  reason: string;
}

/**
 * Pick the provider that may see `tier` material and can answer every
 * question asked. Registration order decides between equals; the built-in
 * provider is the floor and is returned with a reason when nothing else
 * qualifies.
 */
export function selectJudgmentBackend(request: JudgmentRequest): JudgmentSelection {
  const builtin = judgmentSeam.getOptional(BUILTIN_JUDGMENT_PROVIDER);
  const candidates = judgmentSeam
    .list()
    .map((entry) => entry.implementation)
    .filter((backend) => backend.judgment_id !== BUILTIN_JUDGMENT_PROVIDER);

  const needsImage = stateHasImage(request.state);
  const rejected: string[] = [];
  for (const backend of candidates) {
    if (needsImage && !backend.acceptsImages) {
      rejected.push(`${backend.judgment_id}: cannot see images`);
      continue;
    }
    const unsupported = request.questions.filter((question) => !backend.supports(question));
    if (unsupported.length > 0) {
      rejected.push(`${backend.judgment_id}: cannot answer ${unsupported[0].kind}`);
      continue;
    }
    const egress = checkProviderEgress({
      provider: backend.judgment_id,
      dataTier: request.tier,
      ...(request.tenantSlug ? { tenant_slug: request.tenantSlug } : {}),
    });
    if (!egress.allowed) {
      rejected.push(`${backend.judgment_id}: ${egress.reason || 'egress denied'}`);
      continue;
    }
    return {
      backend,
      reason: `selected '${backend.judgment_id}' (${backend.egress}) for tier=${request.tier}`,
    };
  }

  const why = rejected.length > 0 ? `; rejected: ${rejected.join('; ')}` : '';

  if (!builtin) {
    // Registration is explicit rather than an import side effect, so this is
    // reachable from a caller that never registered anything. Name the fix.
    throw new Error(
      `[JUDGMENT_BACKEND] no provider available: '${BUILTIN_JUDGMENT_PROVIDER}' is not registered. ` +
        `Call registerOrganizationWorkJudgment() (or register your own floor provider) during setup.${why}`
    );
  }

  // The floor is a floor, not a universal answerer. It was possible for the
  // built-in rules to receive a question they do not support and answer it
  // anyway — an organization work shape at 0.40 in reply to a question about
  // error categories. A provider that cannot answer must produce no answer,
  // because a wrong one is worse than none: the whole point of this seam is
  // that callers keep their deterministic result when judgment is not
  // available, and a confident-looking wrong answer denies them that.
  if (needsImage && !builtin.acceptsImages) {
    throw new Error(
      `[JUDGMENT_BACKEND] no provider can see images at tier=${request.tier}${why}`
    );
  }

  const unsupported = request.questions.filter((question) => !builtin.supports(question));
  if (unsupported.length > 0) {
    throw new Error(
      `[JUDGMENT_BACKEND] no provider can answer ${unsupported
        .map((question) => `'${question.id}' (${question.kind})`)
        .join(', ')} at tier=${request.tier}${why}`
    );
  }

  return {
    backend: builtin,
    reason: `fell back to '${BUILTIN_JUDGMENT_PROVIDER}' for tier=${request.tier}${why}`,
  };
}

/**
 * Ask every question in `request` and return typed answers.
 *
 * `calibrated` on each answer is overwritten from the registry, so a
 * provider cannot report its own confidence as fitted. A provider that
 * throws degrades to the built-in one rather than failing the caller.
 */
export async function judge(request: JudgmentRequest): Promise<JudgmentResult> {
  if (!request || (typeof request.state !== 'string' && !request.state?.imageBase64)) {
    throw new TypeError('JudgmentRequest.state must be a string or carry an image');
  }
  if (!Array.isArray(request.questions) || request.questions.length === 0) {
    throw new TypeError('JudgmentRequest.questions must be a non-empty array');
  }

  const selection = selectJudgmentBackend(request);
  let backend = selection.backend;
  let reason = selection.reason;
  let answers: readonly JudgmentAnswer[];

  try {
    answers = await backend.judge(request);
  } catch (error: unknown) {
    const builtin = judgmentSeam.getOptional(BUILTIN_JUDGMENT_PROVIDER);
    if (!builtin || backend.judgment_id === BUILTIN_JUDGMENT_PROVIDER) throw error;
    // Same rule as selection, and it has to be repeated here because this is
    // a second way to reach the floor. Degrading to a provider that cannot
    // answer the question produces an answer to a different question — the
    // rules replied to 'test.category' with an organization work shape —
    // which is worse than the failure being degraded from.
    if (request.questions.some((question) => !builtin.supports(question))) throw error;
    if (stateHasImage(request.state) && !builtin.acceptsImages) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[judgment-backend] provider '${backend.judgment_id}' failed; degrading to '${BUILTIN_JUDGMENT_PROVIDER}': ${message}`
    );
    reason = `${reason}; then '${backend.judgment_id}' failed (${message}) and degraded to '${BUILTIN_JUDGMENT_PROVIDER}'`;
    backend = builtin;
    answers = await builtin.judge(request);
  }

  const providerId = backend.judgment_id;
  return {
    provider_id: providerId,
    reason,
    answers: answers.map((answer) => ({
      ...answer,
      confidence: clampConfidence(answer.confidence),
      calibrated: resolveCalibration(providerId, answer.id),
    })),
  };
}

function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}
