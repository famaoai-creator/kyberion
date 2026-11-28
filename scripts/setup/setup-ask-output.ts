import { shellQuoteArg } from '@agent/core/organization/tenant-governance';
import type { resolveSetupAskGuidanceWithJudgment } from './setup-ask-judgment.js';
import { isDefaultPublicAskScope } from './setup-ask-observation.js';
import { setupAskFeedbackActions } from './setup-ask-preferences.js';
import { formatSetupLifecycleGuide } from './setup-lifecycle-guide.js';

type Guidance = NonNullable<Awaited<ReturnType<typeof resolveSetupAskGuidanceWithJudgment>>>;

export function formatAskGuidance(
  guidance: Guidance,
  { correlationId, explain, json }: { correlationId?: string; explain: boolean; json: boolean }
): string {
  const followUp =
    correlationId &&
    guidance.clarification?.choices.some(({ domain }) => domain === 'conversation') &&
    isDefaultPublicAskScope()
      ? {
          domain: 'conversation',
          argv: ['pnpm', 'kyberion', 'ask', 'MESSAGE', '--correlation-id', correlationId],
          message_arg_index: 3,
        }
      : undefined;
  const feedbackActions =
    guidance.clarification && correlationId
      ? setupAskFeedbackActions(
          guidance.clarification.kind,
          correlationId,
          guidance.recommended?.domain,
          guidance.recommendation_source
        )
      : undefined;
  const feedbackCommands = Object.values(feedbackActions ?? {}).flatMap((actions) =>
    Object.values(actions).map((argv) => `  ${argv.map(shellQuoteArg).join(' ')}`)
  );
  const feedbackHint =
    feedbackActions && guidance.clarification && correlationId
      ? [
          `  After trying a route, replace ROUTE with ${Object.keys(feedbackActions).join(', ')} and choose helpful or missed:`,
          `  pnpm kyberion ask 'guide feedback ${guidance.clarification.kind}: ROUTE helpful' --correlation-id ${shellQuoteArg(correlationId)}`,
        ]
      : [];
  const firstCheck = guidance.clarification?.readiness_command ?? guidance.explanation?.first_check;
  const recommendationStats = guidance.explanation?.feedback_evidence?.recommendations;
  return json
    ? JSON.stringify(
        {
          kind: 'lifecycle_guidance',
          ...guidance,
          correlation_id: correlationId,
          feedback_actions: feedbackActions,
          follow_up: followUp,
        },
        null,
        2
      )
    : [
        guidance.definition_ref,
        guidance.explanation &&
          `[guidance] ${guidance.explanation.domain} — ${guidance.explanation.decision}`,
        guidance.explanation?.feedback_evidence &&
          `  Feedback: ${guidance.explanation.feedback_evidence.evaluated_attempts} evaluated attempts, net score ${guidance.explanation.feedback_evidence.net_score}`,
        recommendationStats &&
          `  Evaluated recommendations: ${recommendationStats.evaluated}, chose another route: ${recommendationStats.switched}, recommendation helped: ${recommendationStats.helpful}`,
        firstCheck && `  First check: ${firstCheck}`,
        guidance.clarification?.question,
        ...(guidance.clarification?.choices.map(
          ({ domain, label, guide_command }) =>
            `  ${domain === guidance.recommended?.domain ? '→ ' : ''}${label} — ${guide_command}`
        ) ?? []),
        followUp && '  To talk with Kyberion in this terminal, replace MESSAGE with your message:',
        followUp && `  ${followUp.argv.map(shellQuoteArg).join(' ')}`,
        formatSetupLifecycleGuide(guidance),
        explain && correlationId && `  Feedback correlation ID: ${correlationId}`,
        ...(explain ? feedbackCommands : feedbackHint),
      ]
        .filter(Boolean)
        .join('\n');
}
