/* eslint-disable no-restricted-imports */
/**
 * Laya-MLX provider for the `judgment-backend` seam.
 *
 * Laya is a typed decision model in the same family as TypeSafe Jev — same
 * three primitives (choice / score / noul), no text generation — but it is
 * an encoder with open weights (Apache-2.0) running locally on MLX rather
 * than a hosted API. Two consequences decide everything about how it is
 * used here, both measured on mission JUDGMENT-SEAM-20260921:
 *
 * - **It is `local-only`**, so unlike Jev it can judge `personal` and
 *   `confidential` material. That was the binding constraint on this seam:
 *   the utterances most worth classifying are the ones that may not leave
 *   the machine.
 * - **It is deterministic.** Twelve utterances judged five times each
 *   returned byte-identical choices, confidences and noul values. Jev,
 *   asked the same utterance three times, returned three answers (two
 *   different shapes). A fixed-weight forward pass with no sampling has no
 *   mechanism to vary, and that is the precondition for a fit in
 *   `judgment-calibration.json` ever meaning anything.
 *
 * Measured at 24 ms per judgment (p50, M-series, multilingual checkpoint,
 * both heads with full criteria text) against 235-278 ms for Jev over the
 * network and 294 ms for a local 4B generative model.
 *
 * ## Criteria text is load-bearing
 *
 * Passing bare option identifiers scored 1/6 on unambiguous Japanese
 * requests. The same six with a sentence of description per option scored
 * 6/6 — better than the rules (5/6) and Jev (4/6). Callers should send
 * `JudgmentQuestion.instructions` and real option descriptions, not
 * identifiers; `describeOptions` exists so that omitting them is at least
 * visible rather than silently halving accuracy.
 *
 * ## Model load is the cost, so the worker is resident
 *
 * Loading takes seconds and inference takes milliseconds, so the Python
 * side (`scripts/laya_mlx_bridge.py`) is a long-lived NDJSON worker rather
 * than a `laya-mlx predict` invocation per judgment. Same shape as
 * `silero-vad-bridge.ts`. If the worker cannot start or dies, `judge()`
 * rejects and the seam degrades to the built-in rule provider — a judgment
 * provider must never be able to stop ordinary work.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildSafeExecEnv, safeExistsSync } from './secure-io.js';
import { rootResolve } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { resolveManagedToolPythonBin } from './tool-runtime-registry.js';
import { createLogger } from './logger.js';
import {
  describeChoiceOptions,
  registerJudgmentBackend,
  type JudgmentAnswer,
  type JudgmentBackend,
  type JudgmentQuestion,
  type JudgmentRequest,
} from './judgment-backend.js';

const logger = createLogger('laya-mlx');

export const LAYA_MLX_PROVIDER = 'laya-mlx';
const LAYA_TOOL_ID = 'laya_mlx';
const DEFAULT_START_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function defaultLayaBridgeScriptPath(): string {
  return rootResolve('libs/core/scripts/laya_mlx_bridge.py');
}

interface LayaChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}
interface LayaNoulAnswer {
  type: 'noul';
  noul: number;
  confidence?: number;
}
interface LayaScoreAnswer {
  type: 'score';
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}
type LayaAnswer = LayaChoiceAnswer | LayaNoulAnswer | LayaScoreAnswer;

interface LayaWorkerReply {
  ready?: boolean;
  model?: string;
  answers?: Record<string, LayaAnswer>;
  usage?: Record<string, number>;
  error?: string;
}

export interface LayaMlxOptions {
  /** Python interpreter; defaults to the managed `laya_mlx` tool runtime. */
  pythonBin?: string;
  scriptPath?: string;
  /** Hugging Face checkpoint id; the multilingual one is the default. */
  model?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Injection seam for tests; avoids spawning a real worker. */
  spawnWorker?: () => LayaWorker;
}

/** The resident worker, reduced to what the provider needs from it. */
export interface LayaWorker {
  send(payload: unknown): Promise<LayaWorkerReply>;
  dispose(): void;
}

function questionPayload(question: JudgmentQuestion): Record<string, unknown> {
  const instructions = question.instructions || `Judge '${question.id}'.`;
  if (question.kind === 'choice') {
    if (!question.optionDescriptions) {
      // Bare identifiers are the failure mode this model is most sensitive
      // to (1/6 vs 6/6 on the same utterances), so say so rather than
      // silently halving accuracy.
      logger.warn(
        `[laya-mlx] question '${question.id}' has no optionDescriptions; ` +
          'accuracy on this model roughly halves without them'
      );
    }
    return { type: 'choice', instructions, criteria: describeChoiceOptions(question) };
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

function toJudgmentAnswer(id: string, answer: LayaAnswer): JudgmentAnswer {
  if (answer.type === 'noul') {
    const probability = Number(answer.noul);
    return {
      id,
      value: probability >= 0.5,
      confidence: Math.max(probability, 1 - probability),
      calibrated: false,
      signals: { noul: probability },
    };
  }
  return {
    id,
    value: answer.type === 'choice' ? answer.choice : Number(answer.score),
    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
    calibrated: false,
    signals: { probabilities: answer.probabilities },
  };
}

/** Spawn the Python worker and speak NDJSON to it, one request at a time. */
function spawnLayaWorker(options: LayaMlxOptions): LayaWorker {
  const scriptPath = options.scriptPath || defaultLayaBridgeScriptPath();
  if (!safeExistsSync(scriptPath)) {
    throw new Error(`[LAYA_MLX] bridge script missing at ${scriptPath}`);
  }
  const pythonBin =
    options.pythonBin ||
    getRegisteredEnvText('KYBERION_LAYA_PYTHON') ||
    resolveManagedToolPythonBin(LAYA_TOOL_ID);
  if (!pythonBin) {
    throw new Error(
      `[LAYA_MLX] no Python for '${LAYA_TOOL_ID}'; install it with the governed tool runtime first`
    );
  }

  const child: ChildProcessWithoutNullStreams = spawn(pythonBin, [scriptPath], {
    env: {
      ...buildSafeExecEnv(),
      KYBERION_LAYA_MODEL: options.model || 'aac6fef/laya-multilingual-mlx',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending: Array<(reply: LayaWorkerReply) => void> = [];
  let buffer = '';
  let fatal: string | undefined;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        let reply: LayaWorkerReply;
        try {
          reply = JSON.parse(line) as LayaWorkerReply;
        } catch {
          reply = { error: `unparseable worker line: ${line.slice(0, 200)}` };
        }
        pending.shift()?.(reply);
      }
      index = buffer.indexOf('\n');
    }
  });
  child.on('exit', (code) => {
    fatal = `worker exited with code ${code}`;
    while (pending.length) pending.shift()?.({ error: fatal });
  });
  child.on('error', (error) => {
    fatal = `worker failed to start: ${error.message}`;
    while (pending.length) pending.shift()?.({ error: fatal });
  });

  const await_ = (timeoutMs: number) =>
    new Promise<LayaWorkerReply>((resolve) => {
      if (fatal) return resolve({ error: fatal });
      const timer = setTimeout(() => {
        const at = pending.indexOf(settle);
        if (at >= 0) pending.splice(at, 1);
        resolve({ error: `worker timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      const settle = (reply: LayaWorkerReply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      pending.push(settle);
    });

  // The first line is the load handshake; it is slow and worth waiting for.
  const ready = await_(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);

  return {
    async send(payload: unknown) {
      const handshake = await ready;
      if (handshake.error) return handshake;
      if (fatal) return { error: fatal };
      const reply = await_(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return reply;
    },
    dispose() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

export function createLayaMlxBackend(options: LayaMlxOptions = {}): JudgmentBackend {
  let worker: LayaWorker | undefined;

  return {
    judgment_id: LAYA_MLX_PROVIDER,
    egress: 'local-only',
    supports(question: JudgmentQuestion) {
      if (question.kind === 'choice') return question.options.length >= 2;
      return question.kind === 'bool' || question.kind === 'score';
    },
    async judge(request: JudgmentRequest): Promise<readonly JudgmentAnswer[]> {
      if (!worker) worker = (options.spawnWorker || (() => spawnLayaWorker(options)))();
      const reply = await worker.send({
        state: request.state,
        questions: Object.fromEntries(
          request.questions.map((question) => [question.id, questionPayload(question)])
        ),
      });
      if (reply.error) {
        // A dead worker must not be reused; the next judgment starts a new one.
        worker.dispose();
        worker = undefined;
        throw new Error(`[LAYA_MLX] ${reply.error}`);
      }
      const answers = reply.answers || {};
      return request.questions.map((question) => {
        const answer = answers[question.id];
        if (!answer) {
          throw new Error(`[LAYA_MLX] worker omitted an answer for '${question.id}'`);
        }
        return toJudgmentAnswer(question.id, answer);
      });
    },
  };
}

export function registerLayaMlxBackend(options: LayaMlxOptions = {}): () => void {
  return registerJudgmentBackend(createLayaMlxBackend(options));
}
