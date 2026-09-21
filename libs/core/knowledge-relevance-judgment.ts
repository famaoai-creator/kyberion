/**
 * Judgment assist for narrowing a context pack.
 *
 * A role-scoped pack is assembled by tags and affinity, then handed whole to
 * a worker, where every document costs input tokens on every turn it stays
 * in context. Asking a model "is this relevant?" per candidate used to be
 * absurd — it meant a model call to save a model call. At 24ms on-device it
 * is not: the judgment costs no tokens at all, and each dropped document
 * saves its own length on every subsequent turn.
 *
 * ## The safety direction is the opposite of error classification
 *
 * There, the baseline was `unknown` and a judgment could only add
 * information. Here the baseline is *keep everything*, so a judgment can
 * only remove — and removing a document a worker needed is a silent harm
 * nobody is asked about. So the guards are deliberately asymmetric:
 *
 * - A document is dropped only on **confident irrelevance**. "Not
 *   confidently relevant" is not the same claim and keeps the document.
 * - `pinned` documents are never dropped, whatever the answer.
 * - Never below `minKeep`; if the judgment would empty the pack, the pack
 *   stands.
 * - Any failure — no provider, a timeout, a malformed answer — keeps
 *   everything, which is exactly today's behaviour.
 *
 * Questions are asked in chunks so one call covers several candidates,
 * which is the shape these models are built for, without building a single
 * enormous request for a large pack.
 */

import { assistWithJudgment } from './judgment-assist.js';
import type { JudgmentQuestion } from './judgment-backend.js';
import { createLogger } from './logger.js';
import type { TierLevel } from './types.js';

const logger = createLogger('knowledge-relevance');

const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_EXCERPT_CHARS = 600;

export interface RelevanceCandidate {
  id: string;
  title?: string;
  /** The text the judgment sees; long documents should be excerpted. */
  excerpt: string;
  /** Never dropped, whatever a judgment says. */
  pinned?: boolean;
  /** Full length, for reporting what narrowing saved. */
  fullLength?: number;
}

export interface SelectRelevantKnowledgeInput {
  candidates: readonly RelevanceCandidate[];
  /** What the worker is about to do; the thing relevance is relative to. */
  task: string;
  tier: TierLevel;
  tenantSlug?: string;
  /** Never drop below this many documents. Default 1. */
  minKeep?: number;
  /** Confidence needed to drop. Default 0.7. */
  minConfidence?: number;
  /** Candidates per judgment call. Default 8. */
  chunkSize?: number;
  timeoutMs?: number;
  /**
   * Require a fitted provider before dropping anything.
   *
   * **Defaults to true, from measurement rather than caution.** Evaluated on
   * twelve hand-labelled cases per call site with the Laya provider:
   *
   * | question | accuracy | above floor | of those, wrong | unstable |
   * | --- | --- | --- | --- | --- |
   * | `error.category` | 42% | 5/12 | 2 (40%) | 0 |
   * | `browser.failure_kind` | 58% | 5/12 | 1 (20%) | 0 |
   * | `knowledge.relevant` | 67% | 5/12 | 2 (40%) | 0 |
   *
   * Every site exceeded its tolerated confidently-wrong rate, and every site
   * had too few confident answers for the rate to be worth much either — so
   * both halves of `recommendRequireCalibrated` agree. Accuracy tracked
   * distance from the provider's training domain, and determinism did not:
   * 36 cases over 3 runs each produced zero disagreements while being wrong
   * a third of the time. Being deterministic is a precondition for a fit, not
   * evidence of one.
   *
   * Turning a site on is therefore a measurement landing in
   * `judgment-calibration.json`, not an edit here.
   */
  requireCalibrated?: boolean;
}

export interface SelectRelevantKnowledgeResult {
  kept: RelevanceCandidate[];
  dropped: RelevanceCandidate[];
  source: 'baseline' | 'judgment';
  /** Deterministic explanation, including why nothing was dropped. */
  reason: string;
  /** Characters removed from the pack; a proxy for tokens saved per turn. */
  charsSaved: number;
}

function relevanceQuestion(candidate: RelevanceCandidate, task: string): JudgmentQuestion {
  return {
    kind: 'bool',
    id: `knowledge.relevant.${candidate.id}`,
    instructions:
      `作業: ${task}\n` +
      `この資料はその作業に必要ですか。` +
      `直接役立つ場合のみ true、関係がない場合は false。` +
      (candidate.title ? `\n資料タイトル: ${candidate.title}` : ''),
  };
}

function candidateLength(candidate: RelevanceCandidate): number {
  return candidate.fullLength ?? candidate.excerpt.length;
}

/**
 * Narrow a candidate set, or keep it whole.
 *
 * Returns today's behaviour — every candidate kept — unless a provider is
 * confidently sure a document is irrelevant.
 */
export async function selectRelevantKnowledge(
  input: SelectRelevantKnowledgeInput
): Promise<SelectRelevantKnowledgeResult> {
  const candidates = [...(input.candidates || [])];
  const keepAll = (reason: string): SelectRelevantKnowledgeResult => ({
    kept: candidates,
    dropped: [],
    source: 'baseline',
    reason,
    charsSaved: 0,
  });

  if (candidates.length === 0) return keepAll('no candidates');
  const minKeep = Math.max(1, input.minKeep ?? 1);
  if (candidates.length <= minKeep) return keepAll(`at or below minKeep=${minKeep}`);
  if (!input.task?.trim()) return keepAll('no task to judge relevance against');

  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const chunkSize = Math.max(1, input.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const droppable = candidates.filter((candidate) => !candidate.pinned);
  if (droppable.length === 0) return keepAll('every candidate is pinned');

  const dropIds = new Set<string>();
  const reasons: string[] = [];

  for (let start = 0; start < droppable.length; start += chunkSize) {
    const chunk = droppable.slice(start, start + chunkSize);
    const questions = chunk.map((candidate) => relevanceQuestion(candidate, input.task));
    // One state per chunk: the excerpts, labelled, so each question is
    // answered against the same material in a single call.
    const state = chunk
      .map(
        (candidate) =>
          `--- ${candidate.id}${candidate.title ? ` (${candidate.title})` : ''} ---\n` +
          candidate.excerpt.slice(0, DEFAULT_EXCERPT_CHARS)
      )
      .join('\n\n');

    const result = await assistWithJudgment<Set<string>>({
      baseline: new Set<string>(),
      state,
      questions,
      tier: input.tier,
      ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
      minConfidence,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      // Opt-out rather than opt-in; see the option's documentation.
      requireCalibrated: input.requireCalibrated !== false,
      label: 'knowledge.relevance',
      accept(answers) {
        const drops = new Set<string>();
        for (const candidate of chunk) {
          const answer = answers.find(
            (each) => each.id === `knowledge.relevant.${candidate.id}`
          );
          // Only an explicit, confident "not relevant" drops a document.
          // A missing answer, a non-boolean, or a weak one keeps it.
          if (answer && answer.value === false && answer.confidence >= minConfidence) {
            drops.add(candidate.id);
          }
        }
        return drops.size > 0 ? drops : undefined;
      },
    });

    reasons.push(result.reason);
    for (const id of result.value) dropIds.add(id);
  }

  if (dropIds.size === 0) {
    return keepAll(`nothing confidently irrelevant; ${reasons[0] ?? 'no answers'}`);
  }

  let kept = candidates.filter((candidate) => !dropIds.has(candidate.id));
  let dropped = candidates.filter((candidate) => dropIds.has(candidate.id));

  if (kept.length < minKeep) {
    // Restore the longest-kept ordering rather than emptying the pack: a
    // judgment that wants to drop everything is a judgment to distrust.
    logger.warn(
      `[knowledge-relevance] judgment would keep ${kept.length} of ${candidates.length}, below minKeep=${minKeep}; keeping the pack`
    );
    kept = candidates;
    dropped = [];
    return {
      kept,
      dropped,
      source: 'baseline',
      reason: `judgment would have kept only ${kept.length}, below minKeep=${minKeep}`,
      charsSaved: 0,
    };
  }

  return {
    kept,
    dropped,
    source: 'judgment',
    reason: `dropped ${dropped.length} of ${candidates.length} as confidently irrelevant`,
    charsSaved: dropped.reduce((sum, candidate) => sum + candidateLength(candidate), 0),
  };
}
