/**
 * Cloud System-1 Decision Model providers (`gemini-decision` & `openai-decision`)
 * for the shared `judgment-backend` seam.
 *
 * Unlike generative LLM backends (`delegateTask`), these models perform no text
 * generation and answer typed `choice` / `bool` / `score` questions in a single
 * forward pass with zero output tokens:
 * - `gemini-decision`: `gemini-decision-1` (`POST /v1beta/decisions`)
 * - `openai-decision`: `gpt-6-luna` (`POST /v1/decisions`)
 *
 * **Both providers are `external-api`.** `selectJudgmentBackend()` filters every
 * call through `checkProviderEgress()`, so `personal` data never leaves the
 * machine and `confidential` requires explicit tenant approval. Until a fitted
 * entry exists in `judgment-calibration.json`, `judge()` enforces `calibrated: false`.
 */

import { selectProviderCredential } from '../foundation/credential-binding.js';
import { getRegisteredEnvText, isVitestProcess } from '../foundation/env.js';
import { withSecretResolutionSession } from '../foundation/secret-resolution-session.js';
import { trimEndChars, trimStartChars } from '../foundation/text.js';
import { frameUntrustedInput } from '../governance/untrusted-input-framing.js';
import { createLogger } from '../logger.js';
import { validateUrl } from '../secure-io.js';
import {
  describeChoiceOptions,
  registerJudgmentBackend,
  stateText,
  type JudgmentAnswer,
  type JudgmentBackend,
  type JudgmentQuestion,
  type JudgmentRequest,
  type JudgmentState,
} from '../reasoning/judgment-backend.js';
import { resolveReasoningApiKey } from '../reasoning/reasoning-api-credentials.js';
import { assertReasoningEgressAllowedAtEndpoint } from '../reasoning/reasoning-egress-scope.js';
import { isLocalReasoningEndpoint } from '../reasoning/reasoning-provider-registry.js';
import {
  reportProviderHealthy,
  reportProviderTemporarilyUnhealthy,
} from './provider-health-registry.js';

const logger = createLogger('decision-api-judgment');

export const GEMINI_DECISION_PROVIDER = 'gemini-decision';
export const OPENAI_DECISION_PROVIDER = 'openai-decision';
export const DEFAULT_GEMINI_DECISION_MODEL = 'gemini-decision-1';
export const DEFAULT_OPENAI_DECISION_MODEL = 'gpt-6-luna';
export const MAX_DECISION_INPUT_BYTES = 32 * 1024;
const DEFAULT_GEMINI_DECISION_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/decisions';
const DEFAULT_OPENAI_DECISION_ENDPOINT = 'https://api.openai.com/v1/decisions';
const DEFAULT_TIMEOUT_MS = 20_000;

export interface DecisionApiJudgmentOptions {
  /** Overrides registered env/connection credentials; used in tests and one-off evals. */
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolveSecretKey?: () => string | undefined;
}

function redactSecretFragments(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{12,}/g, 'AIza[REDACTED]');
}

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '\n[truncated]';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + suffix;
}

function formatBoundedDecisionInput(state: JudgmentState): string {
  const bounded = truncateUtf8ToBytes(stateText(state), MAX_DECISION_INPUT_BYTES);
  return frameUntrustedInput({ source: 'judgment state', data: bounded });
}

const DECISION_PROVIDER_CREDENTIALS: Record<
  'gemini' | 'openai',
  {
    apiProvider: 'gemini-api' | 'openai';
    envKeys: readonly string[];
  }
> = {
  gemini: {
    apiProvider: 'gemini-api',
    envKeys: ['KYBERION_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  openai: {
    apiProvider: 'openai',
    envKeys: ['OPENAI_API_KEY'],
  },
};

function createDecisionKeyAccessor(
  provider: 'gemini' | 'openai',
  options: DecisionApiJudgmentOptions
): { getKey(): string; invalidate(): void } {
  const credentialSpec = DECISION_PROVIDER_CREDENTIALS[provider];
  let cachedManagedKey: string | undefined;
  return {
    getKey(): string {
      const explicit = options.apiKey?.trim();
      if (explicit) return explicit;

      const rawEnvValue =
        credentialSpec.envKeys.map((key) => getRegisteredEnvText(key)?.trim()).find(Boolean) ?? '';
      const envValue = selectProviderCredential([...credentialSpec.envKeys], rawEnvValue);
      if (envValue) return envValue;

      if (cachedManagedKey) return cachedManagedKey;

      const injected = options.resolveSecretKey?.()?.trim();
      if (injected) {
        cachedManagedKey = injected;
        return cachedManagedKey;
      }

      if (isVitestProcess()) return '';
      try {
        const resolved =
          withSecretResolutionSession(() =>
            resolveReasoningApiKey(credentialSpec.apiProvider)
          )?.trim() ?? '';
        if (resolved) cachedManagedKey = resolved;
        return resolved;
      } catch (error) {
        logger.debug(
          `[decision-api-judgment] managed secret lookup skipped for ${provider}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return '';
      }
    },
    invalidate(): void {
      cachedManagedKey = undefined;
    },
  };
}

function scoreLevels(question: Extract<JudgmentQuestion, { kind: 'score' }>): number[] {
  const low = Math.ceil(question.range[0]);
  const high = Math.floor(question.range[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return [];
  const count = high - low + 1;
  if (count <= 21) {
    return Array.from({ length: count }, (_, idx) => low + idx);
  }
  const step = Math.ceil((high - low) / 20);
  const levels: number[] = [];
  for (let value = low; value < high; value += step) levels.push(value);
  levels.push(high);
  return levels;
}

function supportsDecisionQuestion(question: JudgmentQuestion): boolean {
  if (question.kind === 'choice') return question.options.length >= 2;
  if (question.kind === 'bool') return true;
  return scoreLevels(question).length >= 2;
}

function questionCriteriaMap(question: JudgmentQuestion): Record<string, string> {
  if (question.kind === 'choice') return describeChoiceOptions(question);
  if (question.kind === 'bool') {
    return { true: 'the statement holds', false: 'the statement does not hold' };
  }
  const [low, high] = question.range;
  return Object.fromEntries(
    scoreLevels(question).map((level) => [String(level), `Score ${level} on scale ${low}..${high}`])
  );
}

function toNumberRecord(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseAnswerValue(
  question: JudgmentQuestion,
  rawValue: unknown,
  providerId: string
): string | boolean | number {
  if (question.kind === 'choice') {
    const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
    if (!question.options.includes(value)) {
      throw new Error(`[${providerId}] invalid choice '${value}' for '${question.id}'`);
    }
    return value;
  }
  if (question.kind === 'bool') {
    if (typeof rawValue === 'boolean') return rawValue;
    const normalized = String(rawValue ?? '')
      .trim()
      .toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new Error(`[${providerId}] invalid boolean '${String(rawValue)}' for '${question.id}'`);
  }
  const numeric = typeof rawValue === 'number' ? rawValue : Number(String(rawValue ?? '').trim());
  if (!Number.isFinite(numeric) || numeric < question.range[0] || numeric > question.range[1]) {
    throw new Error(`[${providerId}] invalid score '${String(rawValue)}' for '${question.id}'`);
  }
  return numeric;
}

function buildJudgmentAnswer(params: {
  question: JudgmentQuestion;
  entry: Record<string, unknown>;
  rawValue: unknown;
  providerId: string;
  model: string;
}): JudgmentAnswer {
  const value = parseAnswerValue(params.question, params.rawValue, params.providerId);
  const probabilities = toNumberRecord(
    params.entry.probabilities ?? params.entry.choice_probabilities ?? params.entry.scores
  );
  const valueKey = String(value);
  const confidence =
    typeof params.entry.confidence === 'number' && Number.isFinite(params.entry.confidence)
      ? params.entry.confidence
      : (probabilities?.[valueKey] ?? 0);
  return {
    id: params.question.id,
    value,
    confidence,
    calibrated: false,
    signals: {
      model: params.model,
      ...(probabilities ? { probabilities } : {}),
    },
  };
}

async function postDecisionRequest(params: {
  providerId: string;
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  onAuthRejected?: () => void;
  fetchFn: typeof fetch;
}): Promise<Record<string, unknown>> {
  if (params.signal?.aborted) {
    throw new Error(`[${params.providerId}] request aborted before dispatch`);
  }
  assertReasoningEgressAllowedAtEndpoint(params.providerId, params.endpoint);

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(params.signal?.reason);
  params.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), params.timeoutMs);
  timer.unref?.();

  try {
    const response = await params.fetchFn(params.endpoint, {
      method: 'POST',
      headers: params.headers,
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const rawText = await response.text().catch(() => '');
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        params.onAuthRejected?.();
      }
      throw new Error(
        `[${params.providerId}] HTTP ${response.status}: ${redactSecretFragments(rawText.slice(0, 400))}`
      );
    }
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`[${params.providerId}] response was not a JSON object`);
    }
    reportProviderHealthy(params.providerId);
    return parsed as Record<string, unknown>;
  } catch (error) {
    const safeMessage = redactSecretFragments(
      error instanceof Error ? error.message : String(error)
    );
    if (!params.signal?.aborted) {
      reportProviderTemporarilyUnhealthy(params.providerId, {
        reason: `judgment_backend(${params.model}): ${safeMessage}`,
      });
    }
    if (error instanceof Error && error.message === safeMessage) {
      throw error;
    }
    throw new Error(safeMessage);
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onCallerAbort);
  }
}

function toGeminiWireQuestionKey(questionId: string, index: number, used: Set<string>): string {
  const sanitized = trimStartChars(
    trimEndChars(questionId.replace(/[^A-Za-z0-9_-]+/g, '_'), '_'),
    '_'
  ).slice(0, 64);
  const base = sanitized || `q_${index}`;
  let candidate = base;
  let disambiguator = index;
  while (used.has(candidate)) {
    const suffix = `_${disambiguator}`;
    candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    disambiguator += 1;
  }
  used.add(candidate);
  return candidate;
}

function toOpenAiWireQuestionName(questionId: string, index: number, used: Set<string>): string {
  if (/^[A-Za-z0-9_.:-]{1,64}$/u.test(questionId) && !used.has(questionId)) {
    used.add(questionId);
    return questionId;
  }
  return toGeminiWireQuestionKey(questionId, index, used);
}

export function createGeminiDecisionBackend(
  options: DecisionApiJudgmentOptions = {}
): JudgmentBackend {
  const endpoint = trimEndChars(options.endpoint?.trim() || DEFAULT_GEMINI_DECISION_ENDPOINT, '/');
  if (!isLocalReasoningEndpoint(endpoint)) validateUrl(endpoint);
  const model = (options.model?.trim() || DEFAULT_GEMINI_DECISION_MODEL).replace(/^models\//u, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchImpl ?? fetch;
  const keyAccessor = createDecisionKeyAccessor('gemini', options);

  return {
    judgment_id: GEMINI_DECISION_PROVIDER,
    egress: 'external-api',
    supports: supportsDecisionQuestion,
    async judge(request: JudgmentRequest): Promise<readonly JudgmentAnswer[]> {
      const apiKey = keyAccessor.getKey();
      if (!apiKey) {
        throw new Error(
          `[${GEMINI_DECISION_PROVIDER}] Gemini API key is not configured; cannot reach Gemini Decisions API.`
        );
      }
      const usedWireKeys = new Set<string>();
      const wireKeys = request.questions.map((question, idx) =>
        toGeminiWireQuestionKey(question.id, idx, usedWireKeys)
      );
      const questionsPayload = Object.fromEntries(
        request.questions.map((question, idx) => [
          wireKeys[idx],
          {
            type: 'choice',
            instructions: question.instructions || `Judge '${question.id}'.`,
            criteria: questionCriteriaMap(question),
          },
        ])
      );
      const parsed = await postDecisionRequest({
        providerId: GEMINI_DECISION_PROVIDER,
        model,
        endpoint,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: {
          model,
          input: formatBoundedDecisionInput(request.state),
          questions: questionsPayload,
        },
        timeoutMs,
        signal: request.signal,
        onAuthRejected: () => keyAccessor.invalidate(),
        fetchFn,
      });

      const decisions = (parsed.decisions ?? parsed.answers ?? {}) as Record<string, unknown>;
      return request.questions.map((question, idx) => {
        const entry = (decisions[wireKeys[idx]] ?? decisions[question.id]) as
          Record<string, unknown> | undefined;
        if (!entry || typeof entry !== 'object') {
          throw new Error(
            `[${GEMINI_DECISION_PROVIDER}] response omitted an answer for '${question.id}'`
          );
        }
        const rawValue = entry.selected_option ?? entry.choice ?? entry.result ?? entry.value;
        return buildJudgmentAnswer({
          question,
          entry,
          rawValue,
          providerId: GEMINI_DECISION_PROVIDER,
          model,
        });
      });
    },
  };
}

export function createOpenAiDecisionBackend(
  options: DecisionApiJudgmentOptions = {}
): JudgmentBackend {
  const endpoint = trimEndChars(options.endpoint?.trim() || DEFAULT_OPENAI_DECISION_ENDPOINT, '/');
  if (!isLocalReasoningEndpoint(endpoint)) validateUrl(endpoint);
  const model = options.model?.trim() || DEFAULT_OPENAI_DECISION_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchImpl ?? fetch;
  const keyAccessor = createDecisionKeyAccessor('openai', options);

  return {
    judgment_id: OPENAI_DECISION_PROVIDER,
    egress: 'external-api',
    supports: supportsDecisionQuestion,
    async judge(request: JudgmentRequest): Promise<readonly JudgmentAnswer[]> {
      const apiKey = keyAccessor.getKey();
      if (!apiKey) {
        throw new Error(
          `[${OPENAI_DECISION_PROVIDER}] OpenAI API key is not configured; cannot reach OpenAI Decisions API.`
        );
      }
      const usedWireNames = new Set<string>();
      const wireNames = request.questions.map((question, idx) =>
        toOpenAiWireQuestionName(question.id, idx, usedWireNames)
      );
      const questionsPayload = request.questions.map((question, idx) => {
        const criteria = questionCriteriaMap(question);
        const instructions = [
          question.instructions || `Judge '${question.id}'.`,
          ...Object.entries(criteria).map(([key, desc]) => `- ${key}: ${desc}`),
        ].join('\n');
        return {
          type: 'choice',
          name: wireNames[idx],
          instructions,
          choices: Object.keys(criteria).map((value) => ({ value })),
        };
      });
      const parsed = await postDecisionRequest({
        providerId: OPENAI_DECISION_PROVIDER,
        model,
        endpoint,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: {
          model,
          input: formatBoundedDecisionInput(request.state),
          questions: questionsPayload,
        },
        timeoutMs,
        signal: request.signal,
        onAuthRejected: () => keyAccessor.invalidate(),
        fetchFn,
      });

      const answersArr = Array.isArray(parsed.answers)
        ? (parsed.answers as Array<Record<string, unknown>>)
        : [];
      const resultsArr = Array.isArray(parsed.results)
        ? (parsed.results as Array<Record<string, unknown>>)
        : [];
      const decisionsMap = (
        !Array.isArray(parsed.decisions) && parsed.decisions && typeof parsed.decisions === 'object'
          ? parsed.decisions
          : !Array.isArray(parsed.answers) && parsed.answers && typeof parsed.answers === 'object'
            ? parsed.answers
            : undefined
      ) as Record<string, unknown> | undefined;

      return request.questions.map((question, idx) => {
        const wireName = wireNames[idx];
        const matchesId = (row: Record<string, unknown> | undefined) =>
          row?.name === wireName ||
          row?.id === wireName ||
          row?.name === question.id ||
          row?.id === question.id;
        const fromArr =
          answersArr.find(matchesId) ??
          resultsArr.find(matchesId) ??
          (request.questions.length === 1 ? (answersArr[0] ?? resultsArr[0]) : answersArr[idx]);
        const entry = (fromArr ?? decisionsMap?.[wireName] ?? decisionsMap?.[question.id]) as
          Record<string, unknown> | undefined;
        if (!entry || typeof entry !== 'object') {
          throw new Error(
            `[${OPENAI_DECISION_PROVIDER}] response omitted an answer for '${question.id}'`
          );
        }
        const rawChoice =
          entry.choice &&
          typeof entry.choice === 'object' &&
          'value' in (entry.choice as Record<string, unknown>)
            ? (entry.choice as Record<string, unknown>).value
            : entry.choice;
        const rawValue =
          rawChoice ?? entry.result ?? entry.selected_option ?? entry.value ?? entry.answer;
        return buildJudgmentAnswer({
          question,
          entry,
          rawValue,
          providerId: OPENAI_DECISION_PROVIDER,
          model,
        });
      });
    },
  };
}

export function registerGeminiDecisionBackend(
  options: DecisionApiJudgmentOptions = {}
): () => void {
  logger.info(
    `[${GEMINI_DECISION_PROVIDER}] registering external-api judgment provider; personal-tier state will not reach it`
  );
  return registerJudgmentBackend(createGeminiDecisionBackend(options));
}

export function registerOpenAiDecisionBackend(
  options: DecisionApiJudgmentOptions = {}
): () => void {
  logger.info(
    `[${OPENAI_DECISION_PROVIDER}] registering external-api judgment provider; personal-tier state will not reach it`
  );
  return registerJudgmentBackend(createOpenAiDecisionBackend(options));
}
