import {
  loadExecutionFeedbackStore,
  type ExecutionFeedbackRecord,
  recordExecutionFeedback,
} from '@agent/core/execution-feedback';
import {
  detectCliAgentPrincipal,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import { nowIso } from '@agent/core/foundation/time';
import { currentScope } from '@agent/core/scope-context';

import { setupAskClarifications } from './setup-ask-guidance.js';

type Topic = keyof typeof setupAskClarifications;
function choicesFor(topic: Topic) {
  return setupAskClarifications[topic].choices.map(({ domain }) => domain);
}

const preferenceIntent = 'lifecycle-guidance-preference';
const feedbackIntent = 'lifecycle-guidance-feedback';
const receiptIntent = 'lifecycle-guidance-issued';
const feedbackWindow = 8;
const feedbackMaxAgeMs = 30 * 24 * 60 * 60 * 1000;

function isRecentAttempt(issuedAt: string, now: number): boolean {
  const age = now - Date.parse(issuedAt);
  return age >= 0 && age <= feedbackMaxAgeMs;
}

function preferenceScope() {
  if (detectCliAgentPrincipal()) return undefined;
  const scope = currentScope();
  const owner = resolveCliOperatorIdentity({ tenantSlug: scope.tenant_slug });
  if (!owner.principalId || (scope.tenant_slug && !owner.tenantRole)) return undefined;
  return {
    scope: { ...scope, tier: 'personal' as const, owner_nhi: owner.principalId },
    sourceTier: scope.tier,
  };
}

const recommendationSources = [
  'recommended',
  'operator_preference',
  'feedback_preference',
] as const;
export type RecommendationSource = (typeof recommendationSources)[number];

export function setupAskFeedbackActions(
  topic: Topic,
  correlationId: string,
  recommended?: string,
  recommendationSource?: RecommendationSource
) {
  try {
    const partition = preferenceScope();
    if (!partition) return undefined;
    recordExecutionFeedback(
      {
        scenario_id: `${receiptIntent}-${topic}-${partition.sourceTier}`,
        intent_id: receiptIntent,
        surface: 'cli',
        outcome: 'partially_satisfied',
        source: 'operator',
        correlation_id: correlationId,
        ...(choicesFor(topic).some((choice) => choice === recommended)
          ? { correction: recommended, comment: recommendationSource }
          : {}),
        scope: partition.scope,
      },
      (entries) => checkFeedbackAttempt(topicEntries(entries, topic, partition.sourceTier))
    );
    return Object.fromEntries(
      choicesFor(topic).map((target) => [
        target,
        Object.fromEntries(
          (['helpful', 'missed'] as const).map((outcome) => [
            outcome,
            [
              'pnpm',
              'kyberion',
              'ask',
              `guide feedback ${topic}: ${target} ${outcome}`,
              '--correlation-id',
              correlationId,
            ],
          ])
        ),
      ])
    );
  } catch {
    return undefined;
  }
}

function topicEntries(
  entries: readonly ExecutionFeedbackRecord[],
  topic: Topic,
  sourceTier: string
) {
  return entries.filter(
    (entry) =>
      entry.source === 'operator' &&
      entry.surface === 'cli' &&
      entry.scenario_id === `${entry.intent_id}-${topic}-${sourceTier}`
  );
}

function latestPreference(entries: ReturnType<typeof topicEntries>) {
  return entries
    .slice()
    .reverse()
    .find((entry) => entry.intent_id === preferenceIntent)?.correction;
}

function lastLearningReset(entries: ReturnType<typeof topicEntries>): number {
  return entries
    .map(
      (entry) =>
        entry.intent_id === preferenceIntent &&
        (entry.correction === 'clear' || entry.correction === 'off')
    )
    .lastIndexOf(true);
}

export function readSetupAskLearning(topic: Topic) {
  try {
    const partition = preferenceScope();
    if (!partition) return undefined;
    const entries = topicEntries(
      loadExecutionFeedbackStore(partition.scope).entries,
      topic,
      partition.sourceTier
    );
    const resetIndex = lastLearningReset(entries);
    const setting = latestPreference(entries);
    const enabled = setting !== 'off';
    const preferred = choicesFor(topic).find((choice) => choice === setting);

    const now = Date.parse(nowIso());
    const issued = new Map<
      string,
      { at: string; index: number; recommended?: string; source?: string }
    >();
    const verifiedFeedback = entries.flatMap((entry, index) => {
      const id = entry.correlation_id;
      if (!id) return [];
      if (entry.intent_id === receiptIntent && !issued.has(id))
        issued.set(id, {
          at: entry.recorded_at,
          index,
          recommended: entry.correction,
          source: entry.comment,
        });
      const receipt = issued.get(id);
      return entry.intent_id === feedbackIntent &&
        receipt &&
        receipt.index > resetIndex &&
        isRecentAttempt(receipt.at, now)
        ? [{ ...entry, recommended: receipt.recommended, recommendationSource: receipt.source }]
        : [];
    });
    const seen = new Set<string>();
    const recentFeedback = verifiedFeedback
      .reverse()
      .filter((entry) => {
        const id = entry.correlation_id;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, feedbackWindow);
    const [first, second] = choicesFor(topic)
      .map((target) => ({
        target,
        score: recentFeedback
          .filter((entry) => entry.correction === target)
          .reduce((score, entry) => score + (entry.outcome === 'satisfied' ? 1 : -1), 0),
      }))
      .sort((left, right) => right.score - left.score);
    const learned =
      enabled && first && second && first.score >= 2 && first.score > second.score
        ? first
        : undefined;
    const evaluatedRecommendations = recentFeedback.filter((entry) => entry.recommended);
    const summarize = (evaluations: typeof evaluatedRecommendations) => ({
      evaluated: evaluations.length,
      switched: evaluations.filter((entry) => entry.correction !== entry.recommended).length,
      helpful: evaluations.filter(
        (entry) => entry.correction === entry.recommended && entry.outcome === 'satisfied'
      ).length,
    });
    const recommendations = summarize(evaluatedRecommendations);
    const recommendationBreakdown = Object.fromEntries(
      recommendationSources.map((source) => [
        source,
        summarize(
          evaluatedRecommendations.filter((entry) => entry.recommendationSource === source)
        ),
      ])
    );
    return {
      status: {
        learning_enabled: enabled,
        explicit_preference: preferred ?? null,
        learned_preference: learned?.target ?? null,
        evaluated_attempts: recentFeedback.length,
        recommendations,
        recommendations_by_source: recommendationBreakdown,
        feedback_coverage: {
          issued: [...issued.values()].filter(
            (receipt) => receipt.index > resetIndex && isRecentAttempt(receipt.at, now)
          ).length,
          reported: seen.size,
        },
      },
      preference: preferred
        ? { target: preferred, decision: 'operator_preference' as const }
        : learned
          ? {
              target: learned.target,
              decision: 'feedback_preference' as const,
              evidence: {
                evaluated_attempts: recentFeedback.length,
                net_score: learned.score,
                ...(recommendations.evaluated ? { recommendations } : {}),
              },
            }
          : undefined,
    };
  } catch {
    return undefined;
  }
}

class GuidanceFeedbackRejection extends Error {}

function checkFeedbackAttempt(entries: ReturnType<typeof topicEntries>, attemptId?: string) {
  if (latestPreference(entries) === 'off')
    throw new GuidanceFeedbackRejection('guidance_learning_disabled');
  if (!attemptId) return;
  const receiptIndex = entries.findIndex(
    (entry) => entry.intent_id === receiptIntent && entry.correlation_id === attemptId
  );
  const receipt = entries[receiptIndex];
  if (!receipt) throw new GuidanceFeedbackRejection('unknown_guidance_attempt');
  if (receiptIndex <= lastLearningReset(entries))
    throw new GuidanceFeedbackRejection('guidance_attempt_before_reset');
  if (!isRecentAttempt(receipt.recorded_at, Date.parse(nowIso())))
    throw new GuidanceFeedbackRejection('expired_guidance_attempt');
}

export function recordSetupAskPreference(text: string, correlationId?: string) {
  const statusRequest = /^guide\s+status\s+([a-z-]+)$/iu.exec(text.trim());
  if (statusRequest) {
    const topic = statusRequest[1]!.toLowerCase() as Topic;
    const kind = 'lifecycle_learning_status';
    if (!Object.prototype.hasOwnProperty.call(setupAskClarifications, topic))
      return { kind, ok: false, reason: 'invalid_syntax' };
    const learning = readSetupAskLearning(topic);
    return learning
      ? { kind, ok: true, topic, ...learning.status }
      : { kind, ok: false, reason: 'operator_learning_unavailable' };
  }
  const prefix = /^guide\s+(preference|feedback|status)\b/iu.exec(text.trim());
  if (!prefix) return undefined;
  const operation = prefix[1]!.toLowerCase();
  if (operation === 'status')
    return { kind: 'lifecycle_learning_status', ok: false, reason: 'invalid_syntax' };
  const isFeedback = operation === 'feedback';
  const intent = isFeedback ? feedbackIntent : preferenceIntent;
  const kind = isFeedback ? 'lifecycle_feedback' : 'lifecycle_preference';
  const request = /^([a-z-]+)\s*:\s*([a-z-]+)(?:\s+(helpful|missed))?$/iu.exec(
    text.trim().slice(prefix[0].length).trim()
  );
  if (!request || isFeedback !== Boolean(request[3]))
    return { kind, ok: false, reason: 'invalid_syntax' };
  const topic = request[1]!.toLowerCase() as Topic;
  if (!Object.prototype.hasOwnProperty.call(setupAskClarifications, topic))
    return { kind, ok: false, reason: 'invalid_syntax' };
  const target = request[2]!.toLowerCase();
  const reset = !isFeedback && (target === 'clear' || target === 'off');
  if (!reset && !choicesFor(topic).some((choice) => choice === target))
    return { kind, ok: false, choices: choicesFor(topic) };
  const outcome = request[3]?.toLowerCase() === 'missed' ? 'dissatisfied' : 'satisfied';
  const attemptId = isFeedback ? correlationId?.trim() || undefined : undefined;
  try {
    const partition = preferenceScope();
    if (!partition) return { kind, ok: false, reason: 'operator_scope_required' };
    recordExecutionFeedback(
      {
        scenario_id: `${intent}-${topic}-${partition.sourceTier}`,
        intent_id: intent,
        surface: 'cli',
        outcome,
        source: 'operator',
        correction: target,
        ...(!isFeedback ? { retention_key: reset ? 'reset' : 'preference' } : {}),
        ...(attemptId ? { correlation_id: attemptId } : {}),
        scope: partition.scope,
      },
      isFeedback
        ? (entries) =>
            checkFeedbackAttempt(topicEntries(entries, topic, partition.sourceTier), attemptId)
        : undefined
    );
    if (isFeedback) {
      const status = attemptId ? readSetupAskLearning(topic)?.status : undefined;
      return {
        kind,
        ok: true,
        topic,
        target,
        outcome,
        correlation_id: attemptId,
        counts_toward_recommendation: Boolean(attemptId),
        ...(status
          ? {
              learning: {
                evaluated_attempts: status.evaluated_attempts,
                suggested_route: status.explicit_preference ?? status.learned_preference,
                source: status.explicit_preference
                  ? 'operator_preference'
                  : status.learned_preference
                    ? 'feedback_preference'
                    : null,
              },
            }
          : {}),
      };
    }
    return {
      kind,
      ok: true,
      topic,
      preferred: reset ? null : target,
      learning_enabled: target !== 'off',
    };
  } catch (error) {
    return {
      kind,
      ok: false,
      reason:
        error instanceof GuidanceFeedbackRejection ? error.message : 'feedback_store_unavailable',
    };
  }
}
