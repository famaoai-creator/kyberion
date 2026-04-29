import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type { GuidedCoordinationBrief } from './src/types/guided-coordination-brief.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const GUIDED_COORDINATION_BRIEF_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/guided-coordination-brief.schema.json'
);

export interface GuidedCoordinationBriefSeed {
  requestText: string;
  intentId?: string;
  goalSummary?: string;
  audienceOrCounterpart?: string;
  approvalBoundary?: string;
  serviceBindings?: string[];
  coordinationKind?:
    | 'meeting'
    | 'presentation'
    | 'narrated_video'
    | 'booking'
    | 'travel'
    | 'schedule'
    | 'onboarding'
    | 'proposal'
    | 'decision_support'
    | 'service_operation'
    | 'general';
  tier?: 'personal' | 'confidential' | 'public';
  locale?: string;
  preferenceProfileRefs?: string[];
  summaryHint?: string;
}

export interface GuidedCoordinationQuestion {
  id: string;
  question: string;
  reason: string;
  default_assumption?: string;
  impact?: string;
  [k: string]: unknown;
}

let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, GUIDED_COORDINATION_BRIEF_SCHEMA_PATH);
  return validateFn;
}

function sanitizeQuestion(value: unknown, fallbackId: string): GuidedCoordinationQuestion {
  const question = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    id: typeof question.id === 'string' && question.id.trim().length > 0 ? question.id : fallbackId,
    question:
      typeof question.question === 'string' && question.question.trim().length > 0
        ? question.question
        : `Please provide ${fallbackId.replace(/_/g, ' ')}.`,
    reason:
      typeof question.reason === 'string' && question.reason.trim().length > 0
        ? question.reason
        : 'The request cannot be coordinated safely without this input.',
    default_assumption:
      typeof question.default_assumption === 'string' && question.default_assumption.trim().length > 0
        ? question.default_assumption
        : undefined,
    impact:
      typeof question.impact === 'string' && question.impact.trim().length > 0
        ? question.impact
        : undefined,
  };
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function inferCoordinationKind(seed: GuidedCoordinationBriefSeed): GuidedCoordinationBrief['coordination_kind'] {
  if (seed.coordinationKind) return seed.coordinationKind;
  const text = seed.requestText;
  if (/会議|ミーティング|打ち合わせ|Teams|Zoom|Meet|meeting|call|facilitate|進行|議事録|アクションアイテム|代理参加/i.test(text)) {
    return 'meeting';
  }
  if (/パワーポイント|powerpoint|ppt|スライド|deck|briefing pack|presentation|提案書/i.test(text)) {
    return 'presentation';
  }
  if (/動画|video|movie|ナレーション|narrated/i.test(text)) return 'narrated_video';
  if (/予約|booking|reservation|purchase|order|appointment|apply/i.test(text)) return 'booking';
  if (/旅行|travel|trip|tour|宿泊|hotel|flight/i.test(text)) return 'travel';
  if (/スケジュール|予定|日程|リスケ|resched|reschedule|calendar|調整|変更|空き時間|availability/i.test(text)) {
    return 'schedule';
  }
  if (/オンボーディング|onboarding|初回設定|初期設定|setup/i.test(text)) return 'onboarding';
  if (/proposal|提案|ストーリー|storyline|稟議|decision support|意思決定/i.test(text)) return 'proposal';
  if (/比較|compare|strategy|優先順位|priorit/i.test(text)) return 'decision_support';
  if (/service|運用|operation|diagnos|inspec/i.test(text)) return 'service_operation';
  return 'general';
}

function inferObjective(seed: GuidedCoordinationBriefSeed): string {
  return normalizeText(seed.goalSummary) || normalizeText(seed.summaryHint) || seed.requestText.trim();
}

function inferDomainOverlayId(kind: GuidedCoordinationBrief['coordination_kind']): string {
  return `${kind}-overlay`;
}

function inferExpectedOutputs(kind: GuidedCoordinationBrief['coordination_kind']): string[] {
  const outputsByKind: Record<GuidedCoordinationBrief['coordination_kind'], string[]> = {
    meeting: ['meeting_brief', 'action_item_summary', 'tracking_package'],
    presentation: ['presentation_brief', 'slide_outline', 'theme_selection'],
    narrated_video: ['narrated_video_brief', 'video_composition_adf', 'final_rendered_video'],
    booking: ['booking_packet', 'ranked_candidates', 'approval_preview'],
    travel: ['travel_planning_brief', 'ranked_candidates', 'itinerary'],
    schedule: ['schedule_coordination_summary', 'follow_up_path', 'approval_preview'],
    onboarding: ['onboarding_plan', 'toolchain_setup', 'preference_registration'],
    proposal: ['proposal_storyline', 'evidence_pack', 'approval_preview'],
    decision_support: ['decision_brief', 'options_comparison', 'recommendation'],
    service_operation: ['service_summary', 'resolution_plan', 'approval_request'],
    general: ['coordination_plan', 'clarification_packet', 'result_package'],
  };

  return outputsByKind[kind] || outputsByKind.general;
}

function inferSuggestedTargetActuators(kind: GuidedCoordinationBrief['coordination_kind']): string[] {
  const byKind: Record<GuidedCoordinationBrief['coordination_kind'], string[]> = {
    meeting: ['meeting-actuator', 'meeting-browser-driver'],
    presentation: ['orchestrator-actuator', 'media-actuator'],
    narrated_video: ['video-composition-actuator', 'voice-actuator'],
    booking: ['browser-actuator', 'orchestrator-actuator'],
    travel: ['browser-actuator', 'orchestrator-actuator'],
    schedule: ['browser-actuator', 'service-actuator'],
    onboarding: ['orchestrator-actuator', 'artifact-actuator'],
    proposal: ['orchestrator-actuator', 'media-actuator'],
    decision_support: ['task-session-manager', 'wisdom-actuator'],
    service_operation: ['service-orchestrator', 'task-session-manager'],
    general: ['orchestrator-actuator', 'intent-compiler'],
  };

  return byKind[kind] || byKind.general;
}

function inferSuggestedDeliverables(kind: GuidedCoordinationBrief['coordination_kind']): string[] {
  const byKind: Record<GuidedCoordinationBrief['coordination_kind'], string[]> = {
    meeting: ['meeting_operations_summary', 'action_items'],
    presentation: ['presentation_brief', 'artifact:pptx'],
    narrated_video: ['narrated_video_brief', 'artifact:mp4'],
    booking: ['booking_packet', 'calendar_or_reservation_plan'],
    travel: ['travel_booklet', 'approval_ready_booking_packet'],
    schedule: ['schedule_coordination_summary', 'calendar_update_plan'],
    onboarding: ['onboarding_plan', 'organization_toolchain_configured'],
    proposal: ['proposal_storyline', 'executive_summary'],
    decision_support: ['decision_brief', 'recommendation'],
    service_operation: ['service_summary', 'approval_request'],
    general: ['coordination_brief', 'execution_plan'],
  };

  return byKind[kind] || byKind.general;
}

function inferMissingInputs(kind: GuidedCoordinationBrief['coordination_kind']): string[] {
  const byKind: Record<GuidedCoordinationBrief['coordination_kind'], string[]> = {
    meeting: ['meeting_url', 'meeting_role_boundary', 'meeting_purpose'],
    presentation: ['audience', 'decision_goal', 'theme_preference'],
    narrated_video: ['audience', 'runtime', 'publish_boundary'],
    booking: ['goal', 'participants', 'approval_boundary'],
    travel: ['destination', 'dates', 'budget'],
    schedule: ['schedule_scope', 'date_range', 'fixed_constraints', 'calendar_action_boundary'],
    onboarding: ['workspace', 'organization_goals', 'toolchain_requirements'],
    proposal: ['decision_goal', 'audience', 'source_materials'],
    decision_support: ['decision_question', 'alternatives', 'success_criteria'],
    service_operation: ['service_scope', 'approval_boundary', 'environment_constraints'],
    general: ['objective', 'approval_boundary'],
  };

  return byKind[kind] || byKind.general;
}

function inferApprovalBoundary(kind: GuidedCoordinationBrief['coordination_kind']): string {
  switch (kind) {
    case 'meeting':
      return 'Do not speak, assign action items, or decide without explicit authority.';
    case 'presentation':
      return 'Do not generate the final deck without confirming audience fit and source constraints.';
    case 'narrated_video':
      return 'Do not publish publicly without explicit approval of title, thumbnail, captions, and rights.';
    case 'booking':
    case 'travel':
      return 'Do not log in, reserve, or pay without explicit approval.';
    case 'schedule':
      return 'Do not move calendar commitments without explicit authority.';
    case 'onboarding':
      return 'Do not mutate org tooling or personal preferences without explicit approval.';
    case 'proposal':
    case 'decision_support':
      return 'Do not mark a recommendation as final without review of alternatives and evidence.';
    case 'service_operation':
      return 'Do not make service changes without the required approval gate.';
    default:
      return 'Do not execute external side effects without approval.';
  }
}

function buildClarificationQuestions(missingInputs: string[]): GuidedCoordinationQuestion[] {
  return missingInputs.map((input) =>
    sanitizeQuestion(
      {
        id: input,
        question: `Please provide ${input.replace(/_/g, ' ')}.`,
        reason: 'The request cannot be coordinated safely without this input.',
        default_assumption: 'Use governed defaults until clarified.',
        impact: 'This changes the work shape or the approval boundary.',
      },
      input
    )
  );
}

function inferPreferenceProfileRefs(kind: GuidedCoordinationBrief['coordination_kind']): string[] {
  switch (kind) {
    case 'meeting':
      return ['meeting-operations-profile'];
    case 'presentation':
      return ['presentation-preference-profile'];
    case 'narrated_video':
      return ['narrated-video-preference-profile'];
    case 'booking':
    case 'travel':
      return ['booking-preference-profile'];
    default:
  return [];
}

function inferServiceBindingRefs(seed: GuidedCoordinationBriefSeed): string[] {
  return Array.isArray(seed.serviceBindings)
    ? Array.from(new Set(seed.serviceBindings.map((value) => value.trim()).filter(Boolean)))
    : [];
  }
}

function inferServiceBindingRefs(seed: GuidedCoordinationBriefSeed): string[] {
  return Array.isArray(seed.serviceBindings)
    ? Array.from(new Set(seed.serviceBindings.map((value) => value.trim()).filter(Boolean)))
    : [];
}

function inferAssumptions(kind: GuidedCoordinationBrief['coordination_kind'], seed: GuidedCoordinationBriefSeed): string[] {
  const assumptions = [`Treat the request as a governed ${kind} coordination flow.`];
  if (seed.tier) assumptions.push(`Operate within the ${seed.tier} knowledge tier.`);
  if (seed.locale) assumptions.push(`Prefer ${seed.locale} for operator-facing outputs.`);
  return assumptions;
}

function inferRecommendedNextStep(missingInputs: string[]): string {
  return missingInputs.length > 0
    ? 'Collect the missing inputs before compiling the specialized brief.'
    : 'Compile the specialized brief and execution contract.';
}

export function buildGuidedCoordinationBrief(seed: GuidedCoordinationBriefSeed): GuidedCoordinationBrief {
  const coordination_kind = inferCoordinationKind(seed);
  const missing_inputs = inferMissingInputs(coordination_kind);
  return {
    kind: 'guided-coordination-brief',
    request_text: seed.requestText,
    coordination_kind,
    objective: inferObjective(seed),
    domain_overlay_id: inferDomainOverlayId(coordination_kind),
    audience_or_counterpart: seed.audienceOrCounterpart,
    approval_boundary: seed.approvalBoundary || inferApprovalBoundary(coordination_kind),
    missing_inputs,
    expected_outputs: inferExpectedOutputs(coordination_kind),
    suggested_target_actuators: inferSuggestedTargetActuators(coordination_kind),
    suggested_deliverables: inferSuggestedDeliverables(coordination_kind),
    preference_profile_refs: seed.preferenceProfileRefs?.length ? seed.preferenceProfileRefs : inferPreferenceProfileRefs(coordination_kind),
    service_binding_refs: inferServiceBindingRefs(seed),
    assumptions: inferAssumptions(coordination_kind, seed),
    clarification_questions: buildClarificationQuestions(missing_inputs),
    recommended_next_step: inferRecommendedNextStep(missing_inputs),
  };
}

export function validateGuidedCoordinationBrief(value: unknown): {
  valid: boolean;
  errors: string[];
  value?: GuidedCoordinationBrief;
} {
  const validate = ensureValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: (validate.errors || []).map((error) =>
      `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
    ),
    value: valid ? (value as GuidedCoordinationBrief) : undefined,
  };
}

export function normalizeGuidedCoordinationBrief(
  rawValue: unknown,
  seed: GuidedCoordinationBriefSeed
): GuidedCoordinationBrief {
  const fallback = buildGuidedCoordinationBrief(seed);
  const raw = rawValue && typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : {};
  const candidate: GuidedCoordinationBrief = {
    ...fallback,
    kind: 'guided-coordination-brief',
    request_text:
      typeof raw.request_text === 'string' && raw.request_text.trim().length > 0
        ? raw.request_text
        : fallback.request_text,
    coordination_kind:
      raw.coordination_kind === 'meeting' ||
      raw.coordination_kind === 'presentation' ||
      raw.coordination_kind === 'narrated_video' ||
      raw.coordination_kind === 'booking' ||
      raw.coordination_kind === 'travel' ||
      raw.coordination_kind === 'schedule' ||
      raw.coordination_kind === 'onboarding' ||
      raw.coordination_kind === 'proposal' ||
      raw.coordination_kind === 'decision_support' ||
      raw.coordination_kind === 'service_operation' ||
      raw.coordination_kind === 'general'
        ? raw.coordination_kind
        : fallback.coordination_kind,
    objective:
      typeof raw.objective === 'string' && raw.objective.trim().length > 0
        ? raw.objective
        : fallback.objective,
    domain_overlay_id:
      typeof raw.domain_overlay_id === 'string' && raw.domain_overlay_id.trim().length > 0
        ? raw.domain_overlay_id
        : fallback.domain_overlay_id,
    audience_or_counterpart:
      typeof raw.audience_or_counterpart === 'string' && raw.audience_or_counterpart.trim().length > 0
        ? raw.audience_or_counterpart
        : fallback.audience_or_counterpart,
    approval_boundary:
      typeof raw.approval_boundary === 'string' && raw.approval_boundary.trim().length > 0
        ? raw.approval_boundary
        : fallback.approval_boundary,
    missing_inputs:
      Array.isArray(raw.missing_inputs) && raw.missing_inputs.length > 0
        ? raw.missing_inputs.map((item) => String(item).trim()).filter(Boolean)
        : fallback.missing_inputs,
    expected_outputs:
      Array.isArray(raw.expected_outputs) && raw.expected_outputs.length > 0
        ? raw.expected_outputs.map((item) => String(item).trim()).filter(Boolean)
        : fallback.expected_outputs,
    suggested_target_actuators:
      Array.isArray(raw.suggested_target_actuators) && raw.suggested_target_actuators.length > 0
        ? raw.suggested_target_actuators.map((item) => String(item).trim()).filter(Boolean)
        : fallback.suggested_target_actuators,
    suggested_deliverables:
      Array.isArray(raw.suggested_deliverables) && raw.suggested_deliverables.length > 0
        ? raw.suggested_deliverables.map((item) => String(item).trim()).filter(Boolean)
        : fallback.suggested_deliverables,
    preference_profile_refs:
      Array.isArray(raw.preference_profile_refs) && raw.preference_profile_refs.length > 0
        ? raw.preference_profile_refs.map((item) => String(item).trim()).filter(Boolean)
        : fallback.preference_profile_refs,
    assumptions:
      Array.isArray(raw.assumptions) && raw.assumptions.length > 0
        ? raw.assumptions.map((item) => String(item).trim()).filter(Boolean)
        : fallback.assumptions,
    clarification_questions:
      Array.isArray(raw.clarification_questions) && raw.clarification_questions.length > 0
        ? raw.clarification_questions.map((question, index) =>
            sanitizeQuestion(question, fallback.missing_inputs[index] || `missing_input_${index + 1}`)
          )
        : fallback.clarification_questions,
    recommended_next_step:
      typeof raw.recommended_next_step === 'string' && raw.recommended_next_step.trim().length > 0
        ? raw.recommended_next_step
        : fallback.recommended_next_step,
  };

  const validation = validateGuidedCoordinationBrief(candidate);
  return validation.valid && validation.value ? validation.value : fallback;
}
