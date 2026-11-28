/**
 * Typed System-1 Decision Model invoke ports for `semantic_judgment`:
 * - Local deterministic MLX encoder (`laya-mlx`)
 * - Google Gemini Decisions API (`gemini-decision-1` / `POST /v1beta/decisions`)
 * - OpenAI Decisions API (`gpt-6-luna` / `POST /v1/decisions`)
 */

import { getRegisteredEnvText } from '../foundation/env.js';
import { decodeEntities } from '../foundation/text-escaping.js';
import { validateUrl } from '../secure-io.js';
import {
  createLayaMlxBackend,
  LAYA_MLX_PROVIDER,
  type DisposableJudgmentBackend,
  type LayaMlxOptions,
} from '../provider/laya-mlx-judgment-backend.js';
import {
  reportProviderHealthy,
  reportProviderTemporarilyUnhealthy,
} from '../provider/provider-health-registry.js';
import type { JudgmentQuestion } from '../reasoning/judgment-backend.js';
import { assertReasoningEgressAllowedAtEndpoint } from '../reasoning/reasoning-egress-scope.js';
import { isLocalReasoningEndpoint } from '../reasoning/reasoning-provider-registry.js';

export type SemanticVerdictDisposition = 'apply_precedent' | 'reframe' | 'escalate';

export interface LiveJudgmentInvocation {
  mode: 'live_api';
  prompt: string;
  provider: string;
  model: string;
  temperature: 0;
  maxOutputTokens: number;
  tokenAllowance: number;
  deadlineMs: number;
  signal: AbortSignal;
}

export interface LiveJudgmentInvokeMeta {
  disposition?: SemanticVerdictDisposition;
  confidence?: number;
  probabilities?: Record<string, number>;
  route?: 'primary' | 'fallback';
  route_reason?: string;
}

export interface LiveJudgmentInvokePort {
  mode: 'live_api';
  provider: string;
  model: string;
  warmup?: () => Promise<void>;
  dispose?: () => void;
  invoke(input: LiveJudgmentInvocation): Promise<{
    text: string;
    usage: { input_tokens: number; output_tokens: number };
    meta?: LiveJudgmentInvokeMeta;
  }>;
}

export const LAYA_DEFAULT_MODEL = 'aac6fef/laya-multilingual-mlx';
export const DEFAULT_GEMINI_DECISION_MODEL = 'gemini-decision-1';
export const DEFAULT_OPENAI_DECISION_MODEL = 'gpt-6-luna';

type ChoiceQuestion = Extract<JudgmentQuestion, { kind: 'choice' }>;

const LAYA_LATENCY_DISPOSITION_QUESTION: ChoiceQuestion = {
  kind: 'choice',
  id: 'semantic_judgment.disposition',
  options: ['apply_precedent', 'reframe', 'escalate'],
  optionDescriptions: {
    apply_precedent:
      'Keep all fixed goals unchanged and apply a known local fixture repair with zero added cost.',
    reframe:
      'Reject weakening target users or loosening latency limits; reframe the problem to find the root cause.',
    escalate: 'Ask a human operator to decide whether to pay positive extra monthly budget.',
  },
  instructions:
    'Choose apply_precedent, reframe, or escalate for the supplied goals, proposal, and observations.',
};

const CLOUD_LATENCY_CRITERIA: Record<SemanticVerdictDisposition, string> = {
  apply_precedent:
    'proposal.requested_goal preserves all fixed goals (target_users, max_p95_ms), incremental_monthly_cost <= max_incremental_monthly_cost, and change_scope matches permitted_change; degraded metrics in Observation only describe the symptom being repaired.',
  reframe:
    'proposal.requested_goal weakens or relaxes target_users or max_p95_ms below goal limits, so the problem must be reframed.',
  escalate:
    'proposal.requested_goal preserves target_users and max_p95_ms, but incremental_monthly_cost exceeds max_incremental_monthly_cost and requires a human value decision.',
};

const LAYA_DOT_DISPOSITION_QUESTION: ChoiceQuestion = {
  kind: 'choice',
  id: 'dot_proposal.disposition',
  options: ['apply_precedent', 'reframe', 'escalate'],
  optionDescriptions: {
    apply_precedent:
      'Well-bounded proposal aligned with the standing goal and prior approved precedent without unresolved rejection conflicts.',
    reframe:
      'Proposal conflicts with recent operator rejections, misses required goal constraints, or requires narrower scoping.',
    escalate:
      'Proposal involves operational risk, uncertainty, or a human value decision requiring explicit operator review.',
  },
  instructions:
    'Choose apply_precedent, reframe, or escalate for the standing goal, proposal, feedback, and signals.',
};

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Live judgment invocation aborted');
  }
}

export function extractFramedJsonPayload(prompt: string): Record<string, unknown> {
  const match = prompt.match(/<untrusted_data\s+source="[^"]*">([\s\S]*?)<\/untrusted_data>/u);
  if (!match) return { raw_prompt: prompt.slice(0, 2000) };
  const decoded = decodeEntities(match[1]);
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall back to bounded decoded text if payload JSON is invalid.
  }
  return { raw_payload: decoded.slice(0, 2000) };
}

function collectStringFieldValues(root: unknown, field: string, out = new Set<string>()): string[] {
  if (Array.isArray(root)) {
    for (const item of root) collectStringFieldValues(item, field, out);
  } else if (root && typeof root === 'object') {
    for (const [key, val] of Object.entries(root as Record<string, unknown>)) {
      if (key === field && typeof val === 'string' && val.trim()) {
        out.add(val.trim());
      } else {
        collectStringFieldValues(val, field, out);
      }
    }
  }
  return [...out];
}

export function formatDecisionStateText(payload: Record<string, unknown>, isDot: boolean): string {
  if (isDot) {
    return [
      `Goal: ${String(payload.goal_statement ?? '')}`,
      `Proposal: ${JSON.stringify(payload.proposal ?? {})}`,
      `Feedback: ${JSON.stringify(payload.recent_feedback ?? [])}`,
      `Signals: ${JSON.stringify(payload.signals ?? [])}`,
      `Precedents: ${JSON.stringify(payload.precedents ?? [])}`,
    ]
      .join('\n')
      .slice(0, 2400);
  }
  const sections: string[] = [];
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const untrustedReports: string[] = [];
  const observations: string[] = [];
  for (const item of evidence) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const evKey = typeof rec.evidence_key === 'string' ? rec.evidence_key : 'observation';
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!text) continue;
    if (evKey === 'untrusted-report') {
      untrustedReports.push(`Report: ${text.replace(/\b[a-f0-9]{64}\b/gu, '[hash]')}`);
    } else {
      const sanitized = text
        .replace(/"[^"]*_hash"\s*:\s*"[a-f0-9]{64}",?/gu, '')
        .replace(/\b[a-f0-9]{64}\b/gu, '[hash]');
      observations.push(`Observation (${evKey}): ${sanitized}`);
    }
  }
  sections.push(...untrustedReports);

  const goals = Array.isArray(payload.goals) ? payload.goals : [];
  for (const goal of goals) {
    if (!goal || typeof goal !== 'object') continue;
    const g = goal as Record<string, unknown>;
    sections.push(
      `Goal: target_users=${String(g.target_users ?? '')}, max_p95_ms=${String(g.max_p95_ms ?? '')}ms, max_incremental_monthly_cost=${String(g.max_incremental_monthly_cost ?? '')} ${String(g.currency ?? 'JPY')}, permitted_change=${String(g.permitted_change ?? '')}.`
    );
  }

  if (payload.proposal && typeof payload.proposal === 'object') {
    const p = payload.proposal as Record<string, unknown>;
    const rg = (
      p.requested_goal && typeof p.requested_goal === 'object' ? p.requested_goal : {}
    ) as Record<string, unknown>;
    sections.push(
      `Proposal (${String(p.proposal_key ?? '')}): requested_target_users=${String(rg.target_users ?? '')}, requested_max_p95_ms=${String(rg.max_p95_ms ?? '')}ms, incremental_monthly_cost=${String(p.incremental_monthly_cost ?? '')} ${String(p.currency ?? 'JPY')}, change_scope=${String(p.change_scope ?? '')}.`
    );
  }

  sections.push(...observations);
  return (sections.length > 0 ? sections.join('\n') : JSON.stringify(payload)).slice(0, 2400);
}

export function buildDecisionVerdictJson(
  providerLabel: string,
  payload: Record<string, unknown>,
  isDot: boolean,
  disposition: SemanticVerdictDisposition,
  confidence: number
): string {
  const rationale = `${providerLabel} classified disposition as ${disposition} (confidence=${confidence.toFixed(3)}).`;
  if (isDot) {
    const refs = collectStringFieldValues(payload.precedents, 'ref');
    return JSON.stringify({
      disposition,
      rationale,
      precedent_refs: disposition === 'apply_precedent' && refs.length > 0 ? [refs[0]] : [],
      risk_flags: disposition === 'escalate' ? ['operator_review_required'] : [],
      ...(disposition === 'reframe'
        ? {
            suggested_improvement:
              'Align proposal scope with standing goal and prior operator feedback.',
          }
        : {}),
    });
  }
  const sourceKeys = collectStringFieldValues(payload, 'source_key');
  const goalKeys = collectStringFieldValues(payload, 'goal_key');
  if (disposition === 'apply_precedent') {
    return JSON.stringify({
      disposition: 'apply_precedent',
      precedent_keys: sourceKeys.length > 0 ? [sourceKeys[0]] : [],
      rationale,
      applicability: ['isolated_fixture_only'],
    });
  }
  if (disposition === 'reframe') {
    return JSON.stringify({
      disposition: 'reframe',
      violated_goal_keys: goalKeys.length > 0 ? [goalKeys[0]] : [],
      rationale,
      revised_question:
        'How can the proposal satisfy target user count, p95 latency, and zero incremental cost?',
      evidence_needed: [],
    });
  }
  return JSON.stringify({
    disposition: 'escalate',
    rationale,
    question: 'Should the incremental monthly cost trade-off be accepted?',
    options: [
      {
        label: 'Approve incremental cost',
        consequences: 'Meets user and latency goals with positive monthly cost.',
      },
      {
        label: 'Keep zero-cost cap',
        consequences: 'Rejects incremental monthly cost and seeks a cost-neutral option.',
      },
    ],
    missing_facts: [],
  });
}

function asDisposition(value: unknown): SemanticVerdictDisposition | undefined {
  return value === 'apply_precedent' || value === 'reframe' || value === 'escalate'
    ? value
    : undefined;
}

function toNumberRecord(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

async function postDecisionEndpoint(params: {
  egressProvider: string;
  healthProvider: string;
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  fetchFn: typeof fetch;
}): Promise<Record<string, unknown>> {
  throwIfAborted(params.signal);
  assertReasoningEgressAllowedAtEndpoint(params.egressProvider, params.endpoint);
  try {
    const response = await params.fetchFn(params.endpoint, {
      method: 'POST',
      headers: params.headers,
      signal: params.signal,
      body: JSON.stringify(params.body),
    });
    const rawText = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 300)}`);
    throwIfAborted(params.signal);
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${params.healthProvider} response was not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (!params.signal.aborted) {
      reportProviderTemporarilyUnhealthy(params.healthProvider, {
        model: params.model,
        reason: `semantic_judgment:${error instanceof Error ? error.message : String(error)}`,
      });
    }
    throw error;
  }
}

/**
 * Create a local deterministic Laya-MLX encoder-backed judgment invoke port.
 */
export function createLayaMlxJudgmentInvokePort(
  options: LayaMlxOptions & { backend?: DisposableJudgmentBackend } = {}
): LiveJudgmentInvokePort {
  const model =
    options.model?.trim() ||
    getRegisteredEnvText('KYBERION_LAYA_MODEL')?.trim() ||
    LAYA_DEFAULT_MODEL;
  let backend: DisposableJudgmentBackend | null = options.backend ?? null;
  const getBackend = (): DisposableJudgmentBackend => {
    if (!backend) backend = createLayaMlxBackend({ ...options, model });
    return backend;
  };

  return {
    mode: 'live_api',
    provider: LAYA_MLX_PROVIDER,
    model,
    async warmup() {
      await getBackend().judge({
        state: 'Warmup check for bounded semantic judgment.',
        questions: [LAYA_LATENCY_DISPOSITION_QUESTION],
        tier: 'personal',
      });
    },
    dispose() {
      backend?.dispose();
      if (!options.backend) backend = null;
    },
    async invoke(input) {
      throwIfAborted(input.signal);
      assertReasoningEgressAllowedAtEndpoint(LAYA_MLX_PROVIDER, 'http://127.0.0.1');
      try {
        const payload = extractFramedJsonPayload(input.prompt);
        const isDot = payload.kind === 'dot_proposal_v1';
        const question = isDot ? LAYA_DOT_DISPOSITION_QUESTION : LAYA_LATENCY_DISPOSITION_QUESTION;
        const answers = await getBackend().judge({
          state: formatDecisionStateText(payload, isDot),
          questions: [question],
          tier: 'personal',
        });
        throwIfAborted(input.signal);
        const disposition = asDisposition(answers[0]?.value);
        if (!disposition) {
          throw new Error(`Unexpected Laya-MLX disposition: ${String(answers[0]?.value)}`);
        }
        const confidence = typeof answers[0]?.confidence === 'number' ? answers[0].confidence : 0;
        const probabilities = toNumberRecord(answers[0]?.signals?.probabilities);
        reportProviderHealthy(LAYA_MLX_PROVIDER);
        return {
          text: buildDecisionVerdictJson('Laya-MLX', payload, isDot, disposition, confidence),
          usage: { input_tokens: 0, output_tokens: 0 },
          meta: {
            disposition,
            confidence,
            ...(probabilities ? { probabilities } : {}),
          },
        };
      } catch (error) {
        if (!input.signal.aborted) {
          reportProviderTemporarilyUnhealthy(LAYA_MLX_PROVIDER, {
            model,
            reason: `semantic_judgment:${error instanceof Error ? error.message : String(error)}`,
          });
        }
        throw error;
      }
    },
  };
}

/**
 * Create a Gemini Decisions API (`gemini-decision-1` / `POST /v1beta/decisions`) invoke port.
 */
export function createGeminiDecisionJudgmentInvokePort(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): LiveJudgmentInvokePort {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('Gemini API key is required');
  const model = (options.model?.trim() || DEFAULT_GEMINI_DECISION_MODEL).replace(/^models\//u, '');
  const baseUrl = (
    options.baseUrl?.trim() || 'https://generativelanguage.googleapis.com/v1beta'
  ).replace(/\/+$/u, '');
  const endpoint = `${baseUrl}/decisions`;
  if (!isLocalReasoningEndpoint(endpoint)) validateUrl(endpoint);
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    mode: 'live_api',
    provider: 'gemini-decision',
    model,
    async invoke(input) {
      const payload = extractFramedJsonPayload(input.prompt);
      const isDot = payload.kind === 'dot_proposal_v1';
      const criteria = isDot
        ? LAYA_DOT_DISPOSITION_QUESTION.optionDescriptions!
        : CLOUD_LATENCY_CRITERIA;
      const instructions = isDot
        ? LAYA_DOT_DISPOSITION_QUESTION.instructions
        : 'Classify this latency proposal relative to fixed goals (`target_users`, `max_p95_ms`, `max_incremental_monthly_cost`).';

      const parsed = await postDecisionEndpoint({
        egressProvider: 'gemini',
        healthProvider: 'gemini-decision',
        model,
        endpoint,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: {
          model,
          input: formatDecisionStateText(payload, isDot),
          questions: {
            disposition: {
              type: 'choice',
              instructions,
              criteria,
            },
          },
        },
        signal: input.signal,
        fetchFn,
      });

      const decisions = (parsed.decisions ?? parsed.answers) as Record<string, unknown> | undefined;
      const entry = (decisions?.disposition ?? {}) as Record<string, unknown>;
      const disposition = asDisposition(
        entry.selected_option ?? entry.choice ?? entry.result ?? entry.value
      );
      if (!disposition) {
        throw new Error('Gemini Decisions response did not include a valid disposition');
      }
      const probabilities = toNumberRecord(entry.probabilities);
      const confidence =
        typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
          ? entry.confidence
          : (probabilities?.[disposition] ?? 0);
      const usageMeta = (parsed.usageMetadata ?? parsed.usage ?? {}) as Record<string, unknown>;
      const inputTokens =
        usageMeta.promptTokenCount ?? usageMeta.total_input_tokens ?? usageMeta.input_tokens;
      const outputTokens =
        usageMeta.candidatesTokenCount ??
        usageMeta.total_output_tokens ??
        usageMeta.output_tokens ??
        0;
      if (
        typeof inputTokens !== 'number' ||
        !Number.isInteger(inputTokens) ||
        inputTokens < 0 ||
        typeof outputTokens !== 'number' ||
        !Number.isInteger(outputTokens) ||
        outputTokens < 0
      ) {
        throw new Error('Gemini Decisions response did not include integer token usage');
      }
      reportProviderHealthy('gemini-decision');
      return {
        text: buildDecisionVerdictJson('Gemini-Decision', payload, isDot, disposition, confidence),
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        meta: {
          disposition,
          confidence,
          ...(probabilities ? { probabilities } : {}),
        },
      };
    },
  };
}

/**
 * Create an OpenAI Decisions API (`gpt-6-luna` / `POST /v1/decisions`) invoke port.
 */
export function createOpenAiDecisionJudgmentInvokePort(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): LiveJudgmentInvokePort {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('OpenAI API key is required');
  const model = options.model?.trim() || DEFAULT_OPENAI_DECISION_MODEL;
  const baseUrl = (options.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/u, '');
  const endpoint = `${baseUrl}/decisions`;
  if (!isLocalReasoningEndpoint(endpoint)) validateUrl(endpoint);
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    mode: 'live_api',
    provider: 'openai-decision',
    model,
    async invoke(input) {
      const payload = extractFramedJsonPayload(input.prompt);
      const isDot = payload.kind === 'dot_proposal_v1';
      const criteria = isDot
        ? LAYA_DOT_DISPOSITION_QUESTION.optionDescriptions!
        : CLOUD_LATENCY_CRITERIA;
      const questionPrompt = [
        isDot
          ? LAYA_DOT_DISPOSITION_QUESTION.instructions
          : 'Classify the latency proposal disposition:',
        ...Object.entries(criteria).map(([key, desc]) => `- ${key}: ${desc}`),
      ].join('\n');

      const parsed = await postDecisionEndpoint({
        egressProvider: 'openai',
        healthProvider: 'openai-decision',
        model,
        endpoint,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: {
          model,
          input: formatDecisionStateText(payload, isDot),
          questions: [
            {
              type: 'choice',
              name: 'disposition',
              instructions: questionPrompt,
              choices: [{ value: 'apply_precedent' }, { value: 'reframe' }, { value: 'escalate' }],
            },
          ],
        },
        signal: input.signal,
        fetchFn,
      });

      const answersArr = Array.isArray(parsed.answers)
        ? (parsed.answers as Array<Record<string, unknown>>)
        : [];
      const resultsArr = Array.isArray(parsed.results)
        ? (parsed.results as Array<Record<string, unknown>>)
        : [];
      const fromArray =
        answersArr.find((row) => row?.name === 'disposition' || row?.id === 'disposition') ??
        answersArr[0] ??
        resultsArr.find((row) => row?.name === 'disposition' || row?.id === 'disposition') ??
        resultsArr[0];
      const decisionsMap = (
        !Array.isArray(parsed.decisions) && parsed.decisions && typeof parsed.decisions === 'object'
          ? parsed.decisions
          : !Array.isArray(parsed.answers) && parsed.answers && typeof parsed.answers === 'object'
            ? parsed.answers
            : undefined
      ) as Record<string, unknown> | undefined;
      const entry = (fromArray ?? decisionsMap?.disposition ?? {}) as Record<string, unknown>;
      const rawChoice =
        entry.choice &&
        typeof entry.choice === 'object' &&
        'value' in (entry.choice as Record<string, unknown>)
          ? (entry.choice as Record<string, unknown>).value
          : entry.choice;
      const disposition = asDisposition(
        rawChoice ?? entry.result ?? entry.selected_option ?? entry.value ?? entry.answer
      );
      if (!disposition) {
        throw new Error(
          `OpenAI Decisions response did not include a valid disposition (top_keys=${Object.keys(parsed).join(',')}; entry_keys=${Object.keys(entry).join(',')})`
        );
      }
      const probabilities = toNumberRecord(
        entry.probabilities ?? entry.choice_probabilities ?? entry.scores
      );
      const confidence =
        typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
          ? entry.confidence
          : (probabilities?.[disposition] ?? 0);
      const usage = (parsed.usage ?? {}) as Record<string, unknown>;
      const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.total_input_tokens;
      const outputTokens =
        usage.output_tokens ?? usage.completion_tokens ?? usage.total_output_tokens ?? 0;
      if (
        typeof inputTokens !== 'number' ||
        !Number.isInteger(inputTokens) ||
        inputTokens < 0 ||
        typeof outputTokens !== 'number' ||
        !Number.isInteger(outputTokens) ||
        outputTokens < 0
      ) {
        throw new Error(
          `OpenAI Decisions response did not include integer token usage (top_keys=${Object.keys(parsed).join(',')}; usage_keys=${Object.keys(usage).join(',')})`
        );
      }
      reportProviderHealthy('openai-decision');
      return {
        text: buildDecisionVerdictJson('OpenAI-Decision', payload, isDot, disposition, confidence),
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        meta: {
          disposition,
          confidence,
          ...(probabilities ? { probabilities } : {}),
        },
      };
    },
  };
}
