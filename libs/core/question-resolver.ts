import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { loadStandardIntentCatalog } from './intent-resolution.js';
import { renderVocabularyText } from './ux-vocabulary.js';
import { resolveLocale, type SupportedLocale } from './locale.js';
import {
  assessContextualClarification,
  type ContextualClarificationExecutionShape,
} from './contextual-intent-clarification-policy.js';
import { getMeetingBriefQuestions } from './meeting-operations-profile.js';
import { notifyOperator } from './operator-notifications.js';
import { getNarratedVideoBriefQuestions } from './narrated-video-preference-profile.js';
import { getPresentationPreferenceProfile } from './presentation-preference-registry.js';
import { getPresentationBriefQuestions } from './presentation-preference-profile.js';
import { slugify } from './foundation/text.js';
import type { ActuatorExecutionBrief } from './src/types/actuator-execution-brief.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';
import type { MeetingOperationsProfile } from './src/types/meeting-operations-profile.js';
import type { NarratedVideoPreferenceProfile } from './src/types/narrated-video-preference-profile.js';
import { logger } from './core.js';

const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/question-resolution-policy.schema.json'
);
const POLICY_PATH = pathResolver.knowledge('product/governance/question-resolution-policy.json');
const MEETING_PROFILE_PATH = pathResolver.knowledge(
  'product/schemas/meeting-operations-profile.example.json'
);
const MEETING_PROFILE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/meeting-operations-profile.schema.json'
);
const NARRATED_VIDEO_PROFILE_PATH = pathResolver.knowledge(
  'product/schemas/narrated-video-preference-profile.example.json'
);
const NARRATED_VIDEO_PROFILE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/narrated-video-preference-profile.schema.json'
);

export interface QuestionResolutionQuestion {
  id: string;
  question: string;
  reason: string;
  required_input?: string;
  default_assumption?: string;
  impact?: string;
  source: 'policy' | 'execution_brief' | 'intent_requirement' | 'supplemental' | 'profile';
  blocking: boolean;
}

interface QuestionLike {
  id: string;
  question: string;
  reason: string;
  required_input?: string;
  default_assumption?: string;
  impact?: string;
}

export interface QuestionResolutionRule {
  id?: string;
  intent_id: string;
  shapes?: ContextualClarificationExecutionShape[];
  max_questions_per_turn?: number;
  min_confidence_to_skip?: number;
  always_ask_for?: string[];
  questions?: Array<{
    id: string;
    question: string;
    reason: string;
    required_input?: string;
    default_assumption?: string;
    impact?: string;
  }>;
  source_label?: string;
  rationale?: string;
}

export interface QuestionResolutionPolicyFile {
  version: string;
  defaults: {
    max_questions_per_turn: number;
    min_confidence_to_skip: number;
    always_ask_for: string[];
  };
  intent_rules: QuestionResolutionRule[];
}

export interface ResolveQuestionInput {
  text: string;
  intentId?: string;
  executionShape?: ContextualClarificationExecutionShape;
  locale?: string;
  requiredInputs?: string[];
  confidence?: number;
  executionBrief?: ActuatorExecutionBrief;
  supplementalQuestions?: Array<{
    id: string;
    question: string;
    reason: string;
    default_assumption?: string;
    impact?: string;
  }>;
  maxQuestions?: number;
}

type SupplementalQuestion = NonNullable<ResolveQuestionInput['supplementalQuestions']>[number];

/** @deprecated Use `SupportedLocale` from `./locale.js` instead. */
type QuestionLocale = SupportedLocale;

/**
 * @deprecated Thin wrapper over `./locale.js`. `inputLocale` takes the
 * `explicit` slot of the unified precedence chain; when absent, resolution
 * now falls through identity → `KYBERION_LOCALE` → `KYBERION_UI_LOCALE`
 * (deprecated) → `LANG` → catalog default, instead of the old
 * env-var-only chain (`KYBERION_UI_LOCALE` → `LANG` → `'en'`). This is the
 * I18N-01 unification: every locale resolver now agrees.
 */
function resolveQuestionLocale(inputLocale?: string): QuestionLocale {
  return resolveLocale({ explicit: inputLocale });
}

function localizedQuestionText(
  locale: QuestionLocale,
  key:
    | 'provide'
    | 'reason'
    | 'confirm'
    | 'headline'
    | 'summary'
    | 'unresolved'
    | 'clear'
    | 'goal_prompt',
  input?: string
): string {
  const keyMap = {
    provide: 'question_provide',
    reason: 'question_reason',
    confirm: 'question_confirm',
    headline: 'question_headline',
    summary: 'question_summary',
    unresolved: 'question_unresolved',
    clear: 'question_clear',
    goal_prompt: 'question_goal_prompt',
  } as const;
  const rendered = renderVocabularyText(keyMap[key], locale);
  return input ? rendered.replace('{input}', input) : rendered;
}

function localizeContextualReason(
  locale: QuestionLocale,
  reason: string,
  fallback: string
): string {
  if (locale !== 'ja') return reason;
  if (reason.startsWith('Missing inputs remain above the clarification threshold')) {
    return `不足している入力は確認しきい値を超えています${reason.match(/\(([^)]+)\)/)?.[0] || ''}`;
  }
  if (reason.startsWith('Missing critical inputs:')) {
    return `重要な不足入力があります: ${reason.replace(/^Missing critical inputs:\s*/u, '').replace(/\.$/u, '。')}`;
  }
  if (reason === 'No clarification is required because no inputs are missing.') {
    return '入力の不足がないため、追加の確認は不要です。';
  }
  if (reason === 'The request matches a force-clarification ambiguity pattern.') {
    return '依頼が強制確認の曖昧性パターンに一致しました。';
  }
  if (reason === 'The missing inputs are covered by policy defaults.') {
    return '不足入力はポリシーの既定値で補完できます。';
  }
  if (reason.startsWith('The request can proceed with policy defaults because confidence is')) {
    return `confidence ${reason.match(/([0-9.]+)\./u)?.[1] || ''} なので、ポリシーの既定値で進められます。`;
  }
  return fallback;
}

export interface QuestionResolutionResult {
  kind: 'question-resolution-packet';
  intent_id?: string;
  execution_shape?: ContextualClarificationExecutionShape;
  should_clarify: boolean;
  reason: string;
  missing_inputs: string[];
  omitted_question_count: number;
  questions: QuestionResolutionQuestion[];
  sources: string[];
  learning: {
    candidate_created: boolean;
    promote_eligible: boolean;
    sample_count: number;
    note: string;
  };
}

const policyCatalog = defineCatalog<QuestionResolutionPolicyFile>({
  id: 'question-resolution-policy',
  path: POLICY_PATH,
  schema: POLICY_SCHEMA_PATH,
});

const meetingProfileCatalog = defineCatalog<MeetingOperationsProfile>({
  id: 'meeting-operations-profile-example',
  path: MEETING_PROFILE_PATH,
  schema: MEETING_PROFILE_SCHEMA_PATH,
});

const narratedVideoProfileCatalog = defineCatalog<NarratedVideoPreferenceProfile>({
  id: 'narrated-video-preference-profile-example',
  path: NARRATED_VIDEO_PROFILE_PATH,
  schema: NARRATED_VIDEO_PROFILE_SCHEMA_PATH,
});

function loadPolicyFile(): QuestionResolutionPolicyFile {
  return policyCatalog.load();
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function toSet(values: string[] | undefined): Set<string> {
  return new Set((values || []).map((value) => value.trim()).filter(Boolean));
}

function normalizeMissingInputs(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function inferQuestionsFromIntentRequirements(
  requiredInputs: string[],
  missingInputs: Set<string>,
  locale: QuestionLocale
): QuestionResolutionQuestion[] {
  return requiredInputs
    .filter((input) => missingInputs.has(input))
    .map((input) => ({
      id: input,
      question: localizedQuestionText(locale, 'provide', input.replace(/_/g, ' ')),
      reason: localizedQuestionText(locale, 'reason'),
      required_input: input,
      source: 'intent_requirement' as const,
      blocking: true,
    }));
}

function normalizeQuestion(
  question: QuestionResolutionQuestion | SupplementalQuestion | QuestionLike,
  source: QuestionResolutionQuestion['source'],
  blocking: boolean
): QuestionResolutionQuestion {
  return {
    id: question.id,
    question: question.question,
    reason: question.reason,
    ...('required_input' in question && question.required_input
      ? { required_input: question.required_input }
      : {}),
    ...('default_assumption' in question && question.default_assumption
      ? { default_assumption: question.default_assumption }
      : {}),
    ...('impact' in question && question.impact ? { impact: question.impact } : {}),
    source,
    blocking,
  };
}

function buildOperatorInteractionPacket(
  result: QuestionResolutionResult,
  headline: string,
  summary: string,
  briefSummary?: string,
  confidence?: number
): OperatorInteractionPacket {
  return {
    kind: 'operator-interaction-packet',
    interaction_type: 'clarification',
    headline,
    summary,
    missing_inputs: result.missing_inputs,
    omitted_question_count: result.omitted_question_count,
    ...(briefSummary ? { execution_brief_summary: briefSummary } : {}),
    ...(typeof confidence === 'number' ? { confidence } : {}),
    questions: result.questions.map((question) => ({
      id: question.id,
      question: question.question,
      reason: question.reason,
      ...(question.default_assumption ? { default_assumption: question.default_assumption } : {}),
      ...(question.impact ? { impact: question.impact } : {}),
    })),
    suggested_response_style: 'clarify-first',
    llm_touchpoints: [
      {
        stage: 'question_resolution',
        purpose:
          'Resolve missing intent slots through governed clarification instead of ad hoc prompting.',
        output_contract: 'question-resolution-packet',
      },
      {
        stage: 'execution_brief',
        purpose: 'Extract the request into a governed execution brief',
        output_contract: 'actuator-execution-brief',
      },
      {
        stage: 'intent_contract',
        purpose: 'Resolve the request into a governed execution contract',
        output_contract: 'intent-contract',
      },
    ],
    next_actions: [
      {
        id: 'provide_missing_inputs',
        action: 'Provide the missing inputs and rerun the clarification flow.',
        next_action_type: 'clarify',
        priority: 'now',
      },
    ],
    readiness: result.should_clarify ? 'needs_clarification' : 'fully_automatable',
  };
}

function buildProfileQuestions(intentId: string | undefined): QuestionResolutionQuestion[] {
  switch (intentId) {
    case 'meeting-operations':
      return getMeetingBriefQuestions(getMeetingProfileFallback(), undefined, 3).questions.map(
        (question, index) => ({
          id: `meeting_profile_${index + 1}_${slugify(question, { maxLength: 48, fallback: 'question' })}`,
          question,
          reason:
            'The meeting profile provides reusable preflight questions for this coordination flow.',
          source: 'profile' as const,
          blocking: false,
        })
      );
    case 'generate-presentation':
      return getPresentationBriefQuestions(
        getPresentationPreferenceProfile(),
        undefined,
        3
      ).questions.map((question, index) => ({
        id: `presentation_profile_${index + 1}_${slugify(question, { maxLength: 48, fallback: 'question' })}`,
        question,
        reason: 'The presentation profile provides reusable brief questions for this deck flow.',
        source: 'profile' as const,
        blocking: false,
      }));
    case 'generate-narrated-video':
      return getNarratedVideoBriefQuestions(
        getNarratedVideoProfileFallback(),
        undefined,
        3
      ).questions.map((question, index) => ({
        id: `video_profile_${index + 1}_${slugify(question, { maxLength: 48, fallback: 'question' })}`,
        question,
        reason:
          'The narrated video profile provides reusable preflight questions for this media flow.',
        source: 'profile' as const,
        blocking: false,
      }));
    default:
      return [];
  }
}

function getMeetingProfileFallback(): MeetingOperationsProfile {
  return meetingProfileCatalog.load();
}

function getNarratedVideoProfileFallback(): NarratedVideoPreferenceProfile {
  return narratedVideoProfileCatalog.load();
}

export function resolveQuestionResolution(input: ResolveQuestionInput): QuestionResolutionResult {
  const locale = resolveQuestionLocale(input.locale);
  const policy = loadPolicyFile();
  const intentCatalog = loadStandardIntentCatalog();
  const intent = input.intentId
    ? intentCatalog.find((entry) => entry.id === input.intentId)
    : undefined;
  const rule = policy.intent_rules.find((entry) => entry.intent_id === input.intentId);

  const requiredInputs = normalizeMissingInputs([
    ...(intent?.intake_requirements || []),
    ...(input.requiredInputs || []),
    ...(input.executionBrief?.missing_inputs || []),
    ...(rule?.always_ask_for || []),
  ]);
  const missingInputs = toSet(requiredInputs);
  const contextualDecision = assessContextualClarification({
    intentId: input.intentId,
    text: input.text,
    executionShape: input.executionShape,
    requiredInputs,
    confidence: input.confidence,
  });

  const maxQuestions = Math.max(
    1,
    input.maxQuestions || rule?.max_questions_per_turn || policy.defaults.max_questions_per_turn
  );
  const minConfidenceToSkip =
    rule?.min_confidence_to_skip ?? policy.defaults.min_confidence_to_skip;
  const confidence = clampConfidence(input.confidence, 0.5);

  const questions: QuestionResolutionQuestion[] = [];
  const seenKeys = new Set<string>();
  let omittedQuestionCount = 0;
  const addQuestion = (question: QuestionResolutionQuestion) => {
    const key = `${question.id}::${question.question.trim().toLowerCase()}`;
    if (seenKeys.has(key)) return;
    if (questions.length >= maxQuestions) {
      omittedQuestionCount += 1;
      return;
    }
    seenKeys.add(key);
    questions.push(question);
  };

  for (const question of buildProfileQuestions(input.intentId)) {
    addQuestion(question);
  }

  for (const question of rule?.questions || []) {
    if (questions.length >= maxQuestions) break;
    if (question.required_input && !missingInputs.has(question.required_input)) continue;
    addQuestion(
      normalizeQuestion(
        {
          id: question.id,
          question: question.question,
          reason: question.reason,
          required_input: question.required_input,
          default_assumption: question.default_assumption,
          impact: question.impact,
        },
        'policy',
        Boolean(question.required_input ? missingInputs.has(question.required_input) : true)
      )
    );
  }

  for (const question of input.executionBrief?.clarification_questions || []) {
    if (questions.length >= maxQuestions) break;
    addQuestion(
      normalizeQuestion(
        {
          id: question.id,
          question: question.question,
          reason: question.reason,
          default_assumption: question.default_assumption,
          impact: question.impact,
        },
        'execution_brief',
        true
      )
    );
  }

  for (const question of input.supplementalQuestions || []) {
    if (questions.length >= maxQuestions) break;
    addQuestion(
      normalizeQuestion(
        {
          id: question.id,
          question: question.question,
          reason: question.reason,
          default_assumption: question.default_assumption,
          impact: question.impact,
        },
        'supplemental',
        true
      )
    );
  }

  for (const question of inferQuestionsFromIntentRequirements(
    intent?.intake_requirements || [],
    missingInputs,
    locale
  )) {
    addQuestion(question);
  }

  if (questions.length === 0 && contextualDecision.shouldClarify) {
    addQuestion({
      id: missingInputs.values().next().value || 'confirm_goal',
      question:
        missingInputs.size > 0
          ? localizedQuestionText(
              locale,
              'confirm',
              String(missingInputs.values().next().value).replace(/_/g, ' ')
            )
          : localizedQuestionText(locale, 'goal_prompt'),
      reason: localizeContextualReason(
        locale,
        contextualDecision.reason,
        localizedQuestionText(locale, 'reason')
      ),
      ...(missingInputs.size > 0
        ? { required_input: String(missingInputs.values().next().value) }
        : {}),
      source: 'policy',
      blocking: true,
    });
  }

  const shouldClarify =
    contextualDecision.shouldClarify || questions.length > 0 || confidence < minConfidenceToSkip;

  const sources = Array.from(
    new Set([
      ...(intent ? ['standard-intent-catalog'] : []),
      ...(rule?.source_label ? [rule.source_label] : []),
      ...(input.executionBrief?.clarification_questions?.length ? ['execution-brief'] : []),
      'contextual-intent-clarification-policy',
    ])
  );

  const result: QuestionResolutionResult = {
    kind: 'question-resolution-packet',
    ...(input.intentId ? { intent_id: input.intentId } : {}),
    ...(input.executionShape ? { execution_shape: input.executionShape } : {}),
    should_clarify: shouldClarify,
    reason: rule?.rationale
      ? rule.rationale
      : localizeContextualReason(
          locale,
          contextualDecision.reason,
          questions.length > 0
            ? localizedQuestionText(locale, 'unresolved')
            : localizedQuestionText(locale, 'clear')
        ),
    missing_inputs:
      contextualDecision.missingInputs.length > 0
        ? contextualDecision.missingInputs
        : requiredInputs,
    omitted_question_count: omittedQuestionCount,
    questions,
    sources,
    learning: {
      candidate_created: questions.length > 0,
      promote_eligible: questions.length > 0 && questions.length < maxQuestions,
      sample_count: questions.length,
      note: rule?.rationale || 'Clarification pattern observed through governed intake.',
    },
  };

  if (omittedQuestionCount > 0) {
    logger.info(
      `[question-resolver] omitted ${omittedQuestionCount} clarification question(s) for intent=${input.intentId || 'default'}`
    );
  }

  return result;
}

export function resolveQuestionInteractionPacket(
  input: ResolveQuestionInput,
  headline,
  summary
): OperatorInteractionPacket | undefined {
  const locale = resolveQuestionLocale(input.locale);
  const result = resolveQuestionResolution(input);
  if (!result.should_clarify || result.questions.length === 0) return undefined;
  // E2E-04 Task 2: push the clarification to the operator's channel so the
  // question does not sit unnoticed in a surface (rate-limited per intent).
  void notifyOperator('question', {
    title: result.questions[0]?.question || 'Kyberion has a question',
    body: result.questions
      .slice(0, 3)
      .map((question) => `- ${question.question}`)
      .join('\n'),
    correlation_id: input.intentId || result.questions[0]?.question,
  });
  return buildOperatorInteractionPacket(
    result,
    headline || localizedQuestionText(locale, 'headline'),
    summary || localizedQuestionText(locale, 'summary'),
    input.executionBrief?.user_facing_summary || input.executionBrief?.summary,
    clampConfidence(input.confidence, 0.5)
  );
}

export function getQuestionResolutionPolicyPath(): string {
  return POLICY_PATH;
}
