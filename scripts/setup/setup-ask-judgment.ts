import { assistWithJudgment, choiceAnswer } from '@agent/core/reasoning/judgment-assist';
import { judgmentAssistReady } from '@agent/core/reasoning/judgment-provider-bootstrap';
import { readSetupAskLearning, type RecommendationSource } from './setup-ask-preferences.js';
export { recordSetupAskPreference } from './setup-ask-preferences.js';
import { resolveSetupAskGuidance, setupAskClarifications } from './setup-ask-guidance.js';

const unclear = 'unclear';
type Guidance = NonNullable<ReturnType<typeof resolveSetupAskGuidance>>;
type GuideDecision =
  | 'direct_match'
  | 'no_hint'
  | 'conflicting_hints'
  | 'negated_request'
  | 'assist_not_ready'
  | 'baseline_retained'
  | 'recommended'
  | 'operator_preference'
  | 'feedback_preference';
type Explanation = {
  decision: GuideDecision;
  domain: string;
  first_check?: string;
  feedback_evidence?: {
    evaluated_attempts: number;
    net_score: number;
    recommendations?: { evaluated: number; switched: number; helpful: number };
  };
};
type Choice = NonNullable<Guidance['clarification']>['choices'][number];

const negatedDestination =
  /(?:では|じゃ)なく|ではない|以外|\b(?:not(?!\s+only\b)|except|without|rather than)\b/iu;

const destinationHints = [
  ['kyberion-interface', 'conversation', /対話画面|相棒|companion|terminal chat/iu],
  ['team-chat', 'channel', /チーム内|社内チャット|team chat|team members/iu],
  [
    'agent-runtime',
    'coordination',
    /別ランタイム|別ホスト|別のエージェント|remote agent|another agent/iu,
  ],
] as const;
const judgmentTopics = {
  conversation: {
    id: 'setup.ask.conversation_destination',
    hints: destinationHints,
    unclear: 'The user has not identified a counterparty or conversation surface.',
  },
  installation: {
    id: 'setup.ask.onboarding_destination',
    hints: [
      [
        'local-identity',
        'installation',
        /ローカル環境|本人設定|local identity|local installation/iu,
      ],
      ['tenant-access', 'tenant', /テナント|tenant|organization access/iu],
      ['service-runtime', 'runtime', /サービス|service runtime|managed runtime/iu],
    ],
    unclear: 'The user has not identified what they want to set up.',
  },
  recovery: {
    id: 'setup.ask.recovery_destination',
    hints: [
      ['mission-execution', 'mission', /実行途中|ミッション|execution|mission/iu],
      ['project-track', 'track', /トラック|リリース工程|project track|release lane/iu],
      ['resident-service', 'surface', /画面|常駐サービス|daemon|surface/iu],
    ] as const,
    unclear: 'The user has not identified which unit stopped.',
  },
} as const;

export function setupAskJudgmentQuestion(kind: keyof typeof judgmentTopics) {
  const { id, unclear: unclearDescription } = judgmentTopics[kind];
  const choices = setupAskClarifications[kind].choices;
  return {
    id,
    kind: 'choice' as const,
    options: [...choices.map(({ domain }) => domain), unclear],
    optionDescriptions: {
      ...Object.fromEntries(choices.map(({ domain, en }) => [domain, en])),
      [unclear]: unclearDescription,
    },
  };
}

function serializeSetupAskHints(hints: readonly string[]): string {
  return JSON.stringify({ destination_hints: hints });
}

export function setupAskJudgmentSmoke(kind: keyof typeof judgmentTopics) {
  const question = setupAskJudgmentQuestion(kind);
  const hints: readonly (readonly [string, string, RegExp])[] = judgmentTopics[kind].hints;
  const cases = hints.flatMap(([hint, domain], index) => [
    { id: hint, state: serializeSetupAskHints([hint]), expected: domain },
    ...hints.slice(index + 1).map(([other]) => ({
      id: `${hint}+${other}`,
      state: serializeSetupAskHints([hint, other]),
      expected: unclear,
    })),
  ]);
  return { questionId: question.id, question: () => question, cases };
}

export async function resolveSetupAskGuidanceWithJudgment(
  text: string,
  explain = false
): Promise<
  | (Guidance & {
      recommended?: Choice;
      recommendation_source?: RecommendationSource;
      explanation?: Explanation;
    })
  | undefined
> {
  const guidance = resolveSetupAskGuidance(text);
  if (!guidance) return undefined;
  const route = guidance.routes[0]!;
  const firstCheck = guidance.clarification?.readiness_command ?? route.inspection_commands[0];
  const report = (
    decision: GuideDecision,
    recommended?: Choice,
    feedbackEvidence?: Explanation['feedback_evidence']
  ) => ({
    ...guidance,
    ...(recommended ? { recommended } : {}),
    ...(decision === 'recommended' ||
    decision === 'operator_preference' ||
    decision === 'feedback_preference'
      ? { recommendation_source: decision }
      : {}),
    ...(explain
      ? {
          explanation: {
            decision,
            domain: route.id,
            ...(feedbackEvidence ? { feedback_evidence: feedbackEvidence } : {}),
            ...(firstCheck ? { first_check: firstCheck } : {}),
          },
        }
      : {}),
  });
  const clarification = guidance.clarification;
  if (!clarification) return report('direct_match');
  if (negatedDestination.test(text.normalize('NFKC'))) return report('negated_request');

  const topic = judgmentTopics[clarification.kind];
  const matchedHints = topic.hints.filter(([, , pattern]) => pattern.test(text));
  if (new Set(matchedHints.map(([, domain]) => domain)).size > 1)
    return report('conflicting_hints');
  const preferred = readSetupAskLearning(clarification.kind)?.preference;
  const matchingPreference = clarification.choices.find(
    ({ domain }) => domain === preferred?.target
  );
  if (
    preferred &&
    matchingPreference &&
    matchedHints.every(([, domain]) => domain === matchingPreference.domain)
  ) {
    return report(preferred.decision, matchingPreference, preferred.evidence);
  }

  const questionId = topic.id;
  const hints = matchedHints.map(([hint]) => hint);
  if (!hints.length) return report('no_hint');
  if (!judgmentAssistReady(questionId)) return report('assist_not_ready');

  const result = await assistWithJudgment<string | null>({
    baseline: null,
    // Send only enumerated interface hints; the user's raw prompt stays in the CLI.
    state: serializeSetupAskHints(hints),
    tier: 'personal',
    questions: [setupAskJudgmentQuestion(clarification.kind)],
    timeoutMs: 250,
    minConfidence: 0.8,
    requireCalibrated: true,
    accept(answers) {
      const answer = choiceAnswer(answers, questionId)?.value;
      return typeof answer === 'string' && matchedHints.some(([, domain]) => domain === answer)
        ? answer
        : undefined;
    },
  });
  const recommended = clarification.choices.find(({ domain }) => domain === result.value);
  return report(recommended ? 'recommended' : 'baseline_retained', recommended);
}
