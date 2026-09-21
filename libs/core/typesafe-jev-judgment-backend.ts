/**
 * TypeSafe Jev provider for the `judgment-backend` seam.
 *
 * Jev is a "System One" model: it takes a state plus a map of typed
 * questions and returns typed answers with probability distributions, and
 * it cannot produce prose. That is the exact shape this seam wants, which is
 * why it registers here and not as a reasoning backend — `delegateTask()`
 * returns text and Jev has none to give.
 *
 * `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`.
 * Questions are a map keyed by question id; answers come back keyed the same
 * way. A `choice` answer carries `choice`, `probabilities` and `confidence`;
 * a `noul` answer carries a single `noul` probability and no confidence of
 * its own, so this maps it to value + margin.
 *
 * **This provider is `external-api`.** Registering it does not make it
 * reachable: `selectJudgmentBackend()` still filters through
 * `checkProviderEgress()`, so `personal` material never reaches it and
 * `confidential` needs tenant approval. Public-tier state only, unless a
 * tenant has explicitly approved it.
 *
 * Its confidence is reported by the vendor as calibrated. That claim is not
 * honored here: like every provider, it reports `calibrated: false` until a
 * fitted entry for it exists in `judgment-calibration.json`, measured on a
 * bench in this repo.
 */

import {
  describeChoiceOptions,
  registerJudgmentBackend,
  type JudgmentAnswer,
  type JudgmentBackend,
  type JudgmentQuestion,
  type JudgmentRequest,
} from './judgment-backend.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { createLogger } from './logger.js';

const logger = createLogger('typesafe-jev');

export const TYPESAFE_JEV_PROVIDER = 'typesafe-jev';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';

interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}
interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}
interface JevScoreAnswer {
  type: 'score';
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}
type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

interface JevResponse {
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface TypeSafeJevOptions {
  /** Overrides the registered env key; used by tests and one-off benches. */
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function questionPayload(question: JudgmentQuestion): Record<string, unknown> {
  const instructions = question.instructions || `Judge '${question.id}'.`;
  if (question.kind === 'choice') {
    return {
      type: 'choice',
      instructions,
      // Jev wants a description per option. Measured on the Laya provider,
      // which takes the same shape, bare identifiers cost most of the
      // accuracy (1/6 vs 6/6 on the same six utterances) — so callers should
      // supply `optionDescriptions`, and the identifier is only a fallback.
      criteria: describeChoiceOptions(question),
    };
  }
  if (question.kind === 'bool') {
    return {
      type: 'noul',
      instructions,
      criteria: { true: 'the statement holds', false: 'the statement does not hold' },
    };
  }
  const [low, high] = question.range;
  return {
    type: 'score',
    instructions,
    criteria: Array.from({ length: Math.max(2, Math.round(high - low) + 1) }, (_, index) =>
      String(low + index)
    ),
  };
}

function toJudgmentAnswer(id: string, answer: JevAnswer): JudgmentAnswer {
  if (answer.type === 'noul') {
    const probability = Number(answer.noul);
    return {
      id,
      value: probability >= 0.5,
      // A noul is a single probability with no separate confidence; how far
      // it sits from 0.5 is the only confidence available.
      confidence: Math.max(probability, 1 - probability),
      calibrated: false,
      signals: { noul: probability },
    };
  }
  const value = answer.type === 'choice' ? answer.choice : Number(answer.score);
  return {
    id,
    value,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
    calibrated: false,
    signals: { probabilities: answer.probabilities },
  };
}

export function createTypeSafeJevBackend(options: TypeSafeJevOptions = {}): JudgmentBackend {
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const doFetch = options.fetchImpl || fetch;

  return {
    judgment_id: TYPESAFE_JEV_PROVIDER,
    egress: 'external-api',
    supports(question: JudgmentQuestion) {
      if (question.kind === 'choice') return question.options.length >= 2;
      return question.kind === 'bool' || question.kind === 'score';
    },
    async judge(request: JudgmentRequest): Promise<readonly JudgmentAnswer[]> {
      const apiKey = options.apiKey || getRegisteredEnvText('KYBERION_TYPESAFE_API_KEY');
      if (!apiKey) {
        throw new Error(
          '[TYPESAFE_JEV] KYBERION_TYPESAFE_API_KEY is not set; cannot reach the TypeSafe API.'
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            state: request.state,
            model,
            // Independent questions over the same state go in one call; that
            // is the shape Jev is built for and it costs one round trip.
            questions: Object.fromEntries(
              request.questions.map((question) => [question.id, questionPayload(question)])
            ),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`[TYPESAFE_JEV] ${response.status} ${detail.slice(0, 400)}`);
        }
        const body = (await response.json()) as JevResponse;
        const answers = body?.answers || {};
        return request.questions.map((question) => {
          const answer = answers[question.id];
          if (!answer) {
            throw new Error(`[TYPESAFE_JEV] response omitted an answer for '${question.id}'`);
          }
          return toJudgmentAnswer(question.id, answer);
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function registerTypeSafeJevBackend(options: TypeSafeJevOptions = {}): () => void {
  logger.info(
    `[typesafe-jev] registering external-api judgment provider; personal-tier state will not reach it`
  );
  return registerJudgmentBackend(createTypeSafeJevBackend(options));
}
