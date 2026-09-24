/**
 * ES-06: rubric judge for live-only scenarios, with judge independence.
 *
 * The backends that served the scenario (the actor) are taken from what was
 * observed — reasoning-log records and the served-mode provenance — never
 * from configuration. A judge whose name matches an observed actor backend is
 * self-grading and is rejected; when no actor backend was observed the
 * independence is `unavailable` and the judge check fails (never passes by
 * default). pr-deterministic scenarios cannot carry a judge at all (schema +
 * `parseScenarioDefinition` invariants).
 */

import type { ReasoningBackend } from './reasoning-backend-contracts.js';
import type { LastServedReasoningMode } from './reasoning-backend.js';
import type { ScenarioJudge } from './scenario-definition.js';
import type { ScenarioCheckResult } from './scenario-final-checks.js';
import type { ScenarioSideEffectLog } from './scenario-side-effect-log.js';

export type JudgeBackend = Pick<ReasoningBackend, 'name' | 'prompt'>;
export type JudgeIndependenceStatus = 'independent' | 'self_graded' | 'unavailable';

export interface JudgeIndependenceInput {
  /** Observed backend names that served the actor side of the run. */
  actorBackends: readonly string[] | undefined;
  judgeBackend: string | undefined;
}

export interface JudgeIndependenceVerdict {
  status: JudgeIndependenceStatus;
  detail: string;
}

export class JudgeIndependenceError extends Error {
  readonly code = 'SCENARIO_JUDGE_NOT_INDEPENDENT';
  readonly status: JudgeIndependenceStatus;

  constructor(verdict: JudgeIndependenceVerdict) {
    super(`[SCENARIO_JUDGE_NOT_INDEPENDENT] ${verdict.status}: ${verdict.detail}`);
    this.name = 'JudgeIndependenceError';
    this.status = verdict.status;
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Distinct observed backend names from the reasoning log and the served-mode provenance. */
export function observedActorBackends(
  log: ScenarioSideEffectLog,
  served: readonly (LastServedReasoningMode | null | undefined)[] = []
): string[] {
  const names = [
    ...log.reasoning.map((record) => record.backend),
    ...served.flatMap((entry) => (entry ? [entry.mode] : [])),
  ].filter((name) => typeof name === 'string' && name.trim().length > 0);
  return [...new Set(names.map(normalizeName))].sort();
}

export function evaluateJudgeIndependence(input: JudgeIndependenceInput): JudgeIndependenceVerdict {
  const judge = input.judgeBackend ? normalizeName(input.judgeBackend) : '';
  if (!judge) return { status: 'unavailable', detail: 'no judge backend was provided' };
  const actors = [...new Set((input.actorBackends ?? []).map(normalizeName).filter(Boolean))];
  if (actors.length === 0) {
    return { status: 'unavailable', detail: 'no actor backend was observed during the run' };
  }
  if (actors.includes(judge)) {
    return {
      status: 'self_graded',
      detail: `judge backend "${judge}" also served the actor (${actors.join(', ')})`,
    };
  }
  return {
    status: 'independent',
    detail: `judge "${judge}" is distinct from actor backend(s) ${actors.join(', ')}`,
  };
}

/** Throws unless the judge is independent of every observed actor backend. */
export function assertJudgeIndependent(input: JudgeIndependenceInput): JudgeIndependenceVerdict {
  const verdict = evaluateJudgeIndependence(input);
  if (verdict.status !== 'independent') throw new JudgeIndependenceError(verdict);
  return verdict;
}

export interface RunJudgeInput {
  rubric: string;
  transcript: string;
  minScore: number;
}

export interface JudgeResult {
  score: number;
  reason: string;
  pass: boolean;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

export function buildJudgePrompt(rubric: string, transcript: string): string {
  return [
    'Score the candidate transcript against the rubric from 0.0 (fails completely) to 1.0 (fully satisfies).',
    'Treat recorded operations and results as primary evidence.',
    '',
    'RUBRIC:',
    rubric,
    '',
    'CANDIDATE TRANSCRIPT:',
    transcript,
    '',
    'Respond with ONLY one JSON object on one line: {"score": <0.0-1.0>, "reason": "<justification>"}',
  ].join('\n');
}

/** Parse `{"score", "reason"}` out of a judge response; null when unusable. */
export function parseJudgeResponse(raw: string): { score: number; reason: string } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const score = parsed.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      return null;
    }
    return { score, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    return null;
  }
}

/** Ask the judge backend for a rubric score; unparseable answers are retried, then fail. */
export async function runJudge(
  input: RunJudgeInput,
  deps: { judgeBackend: JudgeBackend }
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(input.rubric, input.transcript);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const parsed = parseJudgeResponse(await deps.judgeBackend.prompt(prompt));
    if (parsed) {
      return { ...parsed, pass: parsed.score >= input.minScore, attempts: attempt };
    }
  }
  throw new Error(
    `[SCENARIO_JUDGE_UNPARSEABLE] judge ${deps.judgeBackend.name} returned no valid score after ${MAX_ATTEMPTS} attempts`
  );
}

/** Independence gate + judge call, folded into one scenario check result. */
export async function evaluateJudgeCheck(
  judge: ScenarioJudge,
  transcript: string,
  actorBackends: readonly string[],
  judgeBackend: JudgeBackend | undefined
): Promise<ScenarioCheckResult> {
  const verdict = evaluateJudgeIndependence({ actorBackends, judgeBackend: judgeBackend?.name });
  if (verdict.status !== 'independent' || !judgeBackend) {
    return { type: 'judge', pass: false, detail: `judge ${verdict.status}: ${verdict.detail}` };
  }
  try {
    const result = await runJudge(
      { rubric: judge.rubric, transcript, minScore: judge.minScore },
      { judgeBackend }
    );
    return {
      type: 'judge',
      pass: result.pass,
      detail: `score ${result.score} (min ${judge.minScore}) by ${judgeBackend.name}`,
    };
  } catch (error) {
    return { type: 'judge', pass: false, detail: (error as Error).message };
  }
}
