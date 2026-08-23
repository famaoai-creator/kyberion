import { createHash } from 'node:crypto';
import { assessContextualClarification } from './contextual-intent-clarification-policy.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import { classifyTaskSessionIntent } from './task-session.js';
import {
  loadStandardIntentCatalog,
  resolveIntentResolutionPacket,
  type IntentResolutionPacket,
  type StandardIntentDefinition,
} from './intent-resolution.js';

export type IntentResolutionShape =
  'direct_answer' | 'task_session' | 'mission' | 'project_bootstrap';
export type IntentOutcomeKind =
  'answer' | 'artifact' | 'approval_ready_plan' | 'service_change' | 'status_report';
export type IntentAuthorityLevel =
  'autonomous' | 'approval_required' | 'human_clarification_required';

export interface IntentResolutionContract {
  request_id: string;
  normalized_intent: string;
  missing_inputs: string[];
  resolution_shape: IntentResolutionShape;
  outcome_kind: IntentOutcomeKind;
  authority_level: IntentAuthorityLevel;
  project_context?: {
    project_id?: string;
    confidence: number;
  };
  rationale: string;
}

export interface IntentResolutionContractOptions {
  packet?: IntentResolutionPacket;
  tier?: 'personal' | 'confidential' | 'public';
  tenantId?: string;
}

function normalizeShape(shape?: string): IntentResolutionShape {
  if (shape === 'project_bootstrap') return 'project_bootstrap';
  if (shape === 'mission') return 'mission';
  if (shape === 'direct_reply') return 'direct_answer';
  if (shape === 'task_session' || shape === 'browser_session') return 'task_session';
  return 'task_session';
}

function inferOutcomeKind(
  intent?: StandardIntentDefinition,
  resultShape?: string
): IntentOutcomeKind {
  const outcomeIds = intent?.outcome_ids || [];
  if (resultShape === 'artifact' || outcomeIds.some((id) => String(id).startsWith('artifact:'))) {
    return 'artifact';
  }
  if (resultShape === 'plan') {
    return 'approval_ready_plan';
  }
  if (resultShape === 'service_change' || outcomeIds.includes('service_change')) {
    return 'service_change';
  }
  if (
    resultShape === 'summary' ||
    resultShape === 'browser_navigation' ||
    resultShape === 'browser_step' ||
    outcomeIds.includes('calendar_agenda_summary') ||
    outcomeIds.includes('service_summary')
  ) {
    return 'status_report';
  }
  return 'answer';
}

function requestIdFrom(text: string): string {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `ir_${digest}`;
}

function inferProjectContext(
  shape: IntentResolutionShape
): IntentResolutionContract['project_context'] | undefined {
  if (shape === 'project_bootstrap') {
    return { confidence: 0.8 };
  }
  return undefined;
}

function uniqueInputs(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))
  );
}

function resolveRequiredInputs(
  packet: IntentResolutionPacket,
  selectedIntent?: StandardIntentDefinition,
  taskSessionIntent?: ReturnType<typeof classifyTaskSessionIntent>
): string[] {
  if (!packet.selected_intent_id) return [];

  return uniqueInputs([
    ...(taskSessionIntent?.requirements?.missing || []),
    ...(selectedShapeForIntent(packet) === 'direct_answer'
      ? []
      : selectedIntent?.intake_requirements || []),
    packet.selected_intent_id === 'setup-messaging-bridge' &&
    !packet.selected_parameters?.platform_id
      ? 'platform_id'
      : undefined,
  ]);
}

function selectedShapeForIntent(packet: IntentResolutionPacket): IntentResolutionShape {
  return normalizeShape(packet.selected_resolution?.shape);
}

export function resolveIntentResolutionContract(
  utterance: string,
  options: IntentResolutionContractOptions = {}
): IntentResolutionContract {
  const trimmed = utterance.trim();
  const packet =
    options.packet ||
    resolveIntentResolutionPacket(trimmed, {
      tier: options.tier,
      tenantId: options.tenantId,
    });
  const catalog = loadStandardIntentCatalog();
  const selectedIntent = catalog.find((intent) => intent.id === packet.selected_intent_id);
  const selectedShape = normalizeShape(packet.selected_resolution?.shape);
  const taskSessionIntent =
    packet.selected_intent_id &&
    ['task_session', 'mission', 'project_bootstrap'].includes(selectedShape)
      ? classifyTaskSessionIntent(trimmed)
      : undefined;
  const requiredInputs = resolveRequiredInputs(packet, selectedIntent, taskSessionIntent);
  const clarificationShape = selectedShape === 'direct_answer' ? 'direct_reply' : selectedShape;
  const clarification = packet.selected_intent_id
    ? assessContextualClarification({
        intentId: packet.selected_intent_id,
        text: trimmed,
        executionShape: clarificationShape,
        requiredInputs,
        confidence: taskSessionIntent?.executionBrief?.confidence ?? packet.selected_confidence,
        contextualFrame: buildContextualIntentFrame(trimmed),
      })
    : undefined;
  const missingInputs = packet.selected_intent_id
    ? clarification?.shouldClarify
      ? uniqueInputs([
          ...requiredInputs,
          requiredInputs.length === 0 ? 'intent_confirmation' : undefined,
        ])
      : []
    : ['intent_or_goal'];
  const authorityLevel: IntentAuthorityLevel =
    missingInputs.length > 0
      ? 'human_clarification_required'
      : selectedIntent?.risk_profile === 'approval_required' ||
          selectedIntent?.risk_profile === 'high_stakes' ||
          (selectedIntent?.outcome_ids || []).includes('approval_request')
        ? 'approval_required'
        : 'autonomous';
  const resolutionShape: IntentResolutionShape = packet.selected_intent_id
    ? selectedShape
    : 'direct_answer';
  const rationale = packet.selected_intent_id
    ? `resolved from intent '${packet.selected_intent_id}' with confidence ${String(packet.selected_confidence || 0)}`
    : 'no confident intent match; clarification required';

  return {
    request_id: requestIdFrom(trimmed),
    normalized_intent: packet.selected_intent_id || 'unresolved_intent',
    missing_inputs: missingInputs,
    resolution_shape: resolutionShape,
    outcome_kind: inferOutcomeKind(selectedIntent, packet.selected_resolution?.result_shape),
    authority_level: authorityLevel,
    project_context: inferProjectContext(resolutionShape),
    rationale,
  };
}
