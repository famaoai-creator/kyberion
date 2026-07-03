import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { loadStandardIntentCatalog } from './intent-resolution.js';
import {
  assessContextualClarification,
  type ContextualClarificationExecutionShape,
} from './contextual-intent-clarification-policy.js';
import { getMeetingBriefQuestions } from './meeting-operations-profile.js';
import { getNarratedVideoBriefQuestions } from './narrated-video-preference-profile.js';
import { getPresentationPreferenceProfile } from './presentation-preference-registry.js';
import { getPresentationBriefQuestions } from './presentation-preference-profile.js';
import type { ActuatorExecutionBrief } from './src/types/actuator-execution-brief.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/question-resolution-policy.schema.json'
);
const POLICY_PATH = pathResolver.knowledge('product/governance/question-resolution-policy.json');

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

function slugifyQuestion(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'question'
  );
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

type QuestionLocale = 'en' | 'ja';

function resolveQuestionLocale(inputLocale?: string): QuestionLocale {
  const normalized = String(inputLocale || process.env.KYBERION_UI_LOCALE || process.env.LANG || '')
    .trim()
    .replace(/_/g, '-')
    .toLowerCase();
  return normalized.startsWith('ja') ? 'ja' : 'en';
}

function localizedQuestionText(
  locale: QuestionLocale,
  key: 'provide' | 'reason' | 'confirm' | 'headline' | 'summary' | 'unresolved' | 'clear',
  input?: string
): string {
  switch (key) {
    case 'provide':
      return locale === 'ja' ? `${input} を指定してください。` : `Please provide ${input}.`;
    case 'reason':
      return locale === 'ja'
        ? 'この入力がないと安全に実行できません。'
        : 'The request cannot be executed safely without this input.';
    case 'confirm':
      return locale === 'ja' ? `${input} を確認してください。` : `Please confirm ${input}.`;
    case 'headline':
      return locale === 'ja'
        ? '実行前に追加の確認が必要です'
        : 'More context is required before execution';
    case 'summary':
      return locale === 'ja'
        ? '実行を続ける前に入力内容の確認が必要です。'
        : 'The request needs clarification before Kyberion can proceed safely.';
    case 'unresolved':
      return locale === 'ja'
        ? '未解決の入力があります。'
        : 'The request still has unresolved inputs.';
    case 'clear':
      return locale === 'ja'
        ? 'この依頼は追加確認なしで進められます。'
        : 'The request can proceed without clarification.';
  }
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

let policyValidateFn: ValidateFunction | null = null;

function ensurePolicyValidator(): ValidateFunction {
  if (policyValidateFn) return policyValidateFn;
  policyValidateFn = compileSchemaFromPath(ajv, POLICY_SCHEMA_PATH);
  return policyValidateFn;
}

function loadPolicyFile(): QuestionResolutionPolicyFile {
  const parsed = JSON.parse(
    safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string
  ) as QuestionResolutionPolicyFile;
  const validate = ensurePolicyValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid question-resolution-policy: ${errors}`);
  }
  return parsed;
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
          id: `meeting_profile_${index + 1}_${slugifyQuestion(question)}`,
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
        id: `presentation_profile_${index + 1}_${slugifyQuestion(question)}`,
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
        id: `video_profile_${index + 1}_${slugifyQuestion(question)}`,
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

function getMeetingProfileFallback(): any {
  return JSON.parse(
    safeReadFile(
      pathResolver.knowledge('product/schemas/meeting-operations-profile.example.json'),
      {
        encoding: 'utf8',
      }
    ) as string
  ) as any;
}

function getNarratedVideoProfileFallback(): any {
  return JSON.parse(
    safeReadFile(
      pathResolver.knowledge('product/schemas/narrated-video-preference-profile.example.json'),
      {
        encoding: 'utf8',
      }
    ) as string
  ) as any;
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
          : locale === 'ja'
            ? 'Kyberion は何を実行し、何を成功とみなせばよいですか?'
            : 'What should Kyberion do, and what outcome should count as success?',
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
