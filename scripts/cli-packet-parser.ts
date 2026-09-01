interface OperatorPacketAction {
  id: string;
  priority?: 'now' | 'next' | 'later';
  next_action_type?: 'execute_now' | 'inspect' | 'clarify' | 'start_mission' | 'resume_mission';
  action: string;
  reason?: string;
  suggested_command?: string;
  suggested_pipeline_path?: string;
  suggested_followup_request?: string;
}

interface OperatorInteractionPacket {
  kind: 'operator-interaction-packet';
  interaction_type: 'clarification' | 'execution-preview' | 'status-summary' | 'delivery-summary';
  headline: string;
  summary: string;
  readiness?: string;
  confidence?: number;
  missing_inputs?: string[];
  omitted_question_count?: number;
  questions?: Array<{
    id: string;
    question: string;
    reason: string;
    default_assumption?: string;
    impact?: string;
  }>;
  next_actions?: OperatorPacketAction[];
  suggested_response_style?: 'clarify-first' | 'preview-and-confirm' | 'status-summary';
  refresh_command?: string;
  refresh_packet_path?: string;
}

interface SystemStatusReportLike {
  kind: 'system-status-report';
  headline: string;
  summary: string;
  findings?: Array<{ id: string; severity: string; message: string; detail?: string }>;
  next_actions?: OperatorPacketAction[];
}

interface OperatorResponsePreview {
  kind: 'operator-response-preview';
  format: 'plain-text';
  text: string;
}

export type ParsedPacket =
  OperatorInteractionPacket | SystemStatusReportLike | OperatorResponsePreview;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ACTION_PRIORITIES = new Set(['now', 'next', 'later']);
const ACTION_TYPES = new Set([
  'execute_now',
  'inspect',
  'clarify',
  'start_mission',
  'resume_mission',
]);
const INTERACTION_TYPES = new Set([
  'clarification',
  'execution-preview',
  'status-summary',
  'delivery-summary',
]);
const RESPONSE_STYLES = new Set(['clarify-first', 'preview-and-confirm', 'status-summary']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => !DANGEROUS_KEYS.has(key))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || nonEmptyString(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !nonEmptyString(entry))) return undefined;
  return value;
}

function parseAction(value: unknown): OperatorPacketAction | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.action) ||
    !optionalString(value.reason) ||
    !optionalString(value.suggested_command) ||
    !optionalString(value.suggested_pipeline_path) ||
    !optionalString(value.suggested_followup_request) ||
    (value.priority !== undefined && !ACTION_PRIORITIES.has(String(value.priority))) ||
    (value.next_action_type !== undefined && !ACTION_TYPES.has(String(value.next_action_type)))
  ) {
    return undefined;
  }
  return {
    id: value.id,
    action: value.action,
    ...(value.priority !== undefined
      ? { priority: value.priority as OperatorPacketAction['priority'] }
      : {}),
    ...(value.next_action_type !== undefined
      ? { next_action_type: value.next_action_type as OperatorPacketAction['next_action_type'] }
      : {}),
    ...(value.reason !== undefined ? { reason: value.reason as string } : {}),
    ...(value.suggested_command !== undefined
      ? { suggested_command: value.suggested_command as string }
      : {}),
    ...(value.suggested_pipeline_path !== undefined
      ? { suggested_pipeline_path: value.suggested_pipeline_path as string }
      : {}),
    ...(value.suggested_followup_request !== undefined
      ? { suggested_followup_request: value.suggested_followup_request as string }
      : {}),
  };
}

function parseActions(value: unknown): OperatorPacketAction[] | undefined {
  if (value === undefined || !Array.isArray(value))
    return value === undefined ? undefined : undefined;
  const actions = value.map(parseAction);
  return actions.every((action): action is OperatorPacketAction => action !== undefined)
    ? actions
    : undefined;
}

function parseQuestions(
  value: unknown
): NonNullable<OperatorInteractionPacket['questions']> | undefined {
  if (value === undefined || !Array.isArray(value))
    return value === undefined ? undefined : undefined;
  const questions = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !nonEmptyString(candidate.id) ||
      !nonEmptyString(candidate.question) ||
      !nonEmptyString(candidate.reason) ||
      !optionalString(candidate.default_assumption) ||
      !optionalString(candidate.impact)
    ) {
      return undefined;
    }
    return {
      id: candidate.id,
      question: candidate.question,
      reason: candidate.reason,
      ...(candidate.default_assumption !== undefined
        ? { default_assumption: candidate.default_assumption as string }
        : {}),
      ...(candidate.impact !== undefined ? { impact: candidate.impact as string } : {}),
    };
  });
  return questions.every((question) => question !== undefined) ? questions : undefined;
}

function parseFindings(value: unknown): SystemStatusReportLike['findings'] | undefined {
  if (value === undefined || !Array.isArray(value))
    return value === undefined ? undefined : undefined;
  const findings = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !nonEmptyString(candidate.id) ||
      !nonEmptyString(candidate.severity) ||
      !nonEmptyString(candidate.message) ||
      !optionalString(candidate.detail)
    ) {
      return undefined;
    }
    return {
      id: candidate.id,
      severity: candidate.severity,
      message: candidate.message,
      ...(candidate.detail !== undefined ? { detail: candidate.detail as string } : {}),
    };
  });
  return findings.every((finding) => finding !== undefined) ? findings : undefined;
}

/** Validate packet files before display or next-action execution. */
export function parseInteractionPacket(value: unknown): ParsedPacket | undefined {
  if (!isRecord(value) || !nonEmptyString(value.kind)) return undefined;
  if (value.kind === 'operator-response-preview') {
    return value.format === 'plain-text' && nonEmptyString(value.text)
      ? { kind: value.kind, format: value.format, text: value.text }
      : undefined;
  }
  if (value.kind === 'system-status-report') {
    const findings = parseFindings(value.findings);
    const nextActions = parseActions(value.next_actions);
    if (
      !nonEmptyString(value.headline) ||
      !nonEmptyString(value.summary) ||
      (value.findings !== undefined && !findings) ||
      (value.next_actions !== undefined && !nextActions)
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      headline: value.headline,
      summary: value.summary,
      ...(findings ? { findings } : {}),
      ...(nextActions ? { next_actions: nextActions } : {}),
    };
  }
  if (value.kind !== 'operator-interaction-packet') return undefined;
  const missingInputs = stringArray(value.missing_inputs);
  const questions = parseQuestions(value.questions);
  const nextActions = parseActions(value.next_actions);
  if (
    !nonEmptyString(value.headline) ||
    !nonEmptyString(value.summary) ||
    !INTERACTION_TYPES.has(String(value.interaction_type)) ||
    !optionalString(value.readiness) ||
    (value.confidence !== undefined &&
      (typeof value.confidence !== 'number' ||
        !Number.isFinite(value.confidence) ||
        value.confidence < 0 ||
        value.confidence > 1)) ||
    (value.omitted_question_count !== undefined &&
      (typeof value.omitted_question_count !== 'number' ||
        !Number.isInteger(value.omitted_question_count) ||
        value.omitted_question_count < 0)) ||
    !optionalString(value.refresh_command) ||
    !optionalString(value.refresh_packet_path) ||
    (value.suggested_response_style !== undefined &&
      !RESPONSE_STYLES.has(String(value.suggested_response_style))) ||
    (value.missing_inputs !== undefined && !missingInputs) ||
    (value.questions !== undefined && !questions) ||
    (value.next_actions !== undefined && !nextActions)
  ) {
    return undefined;
  }
  return {
    kind: value.kind,
    interaction_type: value.interaction_type as OperatorInteractionPacket['interaction_type'],
    headline: value.headline,
    summary: value.summary,
    ...(value.readiness !== undefined ? { readiness: value.readiness as string } : {}),
    ...(value.confidence !== undefined ? { confidence: value.confidence as number } : {}),
    ...(missingInputs ? { missing_inputs: missingInputs } : {}),
    ...(value.omitted_question_count !== undefined
      ? { omitted_question_count: value.omitted_question_count as number }
      : {}),
    ...(questions ? { questions } : {}),
    ...(nextActions ? { next_actions: nextActions } : {}),
    ...(value.suggested_response_style !== undefined
      ? {
          suggested_response_style:
            value.suggested_response_style as OperatorInteractionPacket['suggested_response_style'],
        }
      : {}),
    ...(value.refresh_command !== undefined
      ? { refresh_command: value.refresh_command as string }
      : {}),
    ...(value.refresh_packet_path !== undefined
      ? { refresh_packet_path: value.refresh_packet_path as string }
      : {}),
  };
}
