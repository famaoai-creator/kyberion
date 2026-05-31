import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { buildGuidedCoordinationBrief } from './guided-coordination-brief.js';
import { buildContextualIntentFrame, type ContextualIntentFrame } from './contextual-intent-frame.js';
import { assessContextualClarification } from './contextual-intent-clarification-policy.js';
import { resolveDefaultApprovalSystem, resolveDefaultScheduleSource } from './contextual-intent-memory.js';
import type { GuidedCoordinationBrief } from './src/types/guided-coordination-brief.js';
import type { ActuatorExecutionBrief } from './src/types/actuator-execution-brief.js';
import { resolveInputBindings, type InputBinding } from './input-binding.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const EXECUTION_BRIEF_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/actuator-execution-brief.schema.json'
);

export interface ExecutionBriefSeed {
  requestText: string;
  intentId?: string;
  goalSummary?: string;
  taskType?: string;
  executionShape?: 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
  requiredInputs?: string[];
  outcomeIds?: string[];
  confidence?: number;
  tier?: 'personal' | 'confidential' | 'public';
  locale?: string;
  projectName?: string;
  trackName?: string;
  serviceBindings?: string[];
  summaryHint?: string;
  contextualFrame?: ContextualIntentFrame;
  approvalSystemHint?: string;
  approvalScopeHint?: string;
}

export interface ExecutionBriefQuestion {
  id: string;
  question: string;
  reason: string;
  default_assumption?: string;
  impact?: string;
  [k: string]: unknown;
}

export interface ApprovalWorkflowStep {
  id: string;
  label: string;
  description: string;
  actuator: string;
  phase: 'resolve_system' | 'authenticate' | 'list_pending' | 'review_item' | 'decide' | 'summarize';
  requires_confirmation?: boolean;
  input_refs?: string[];
  output_refs?: string[];
}

let executionBriefValidateFn: ValidateFunction | null = null;

function ensureExecutionBriefValidator(): ValidateFunction {
  if (executionBriefValidateFn) return executionBriefValidateFn;
  executionBriefValidateFn = compileSchemaFromPath(ajv, EXECUTION_BRIEF_SCHEMA_PATH);
  return executionBriefValidateFn;
}

function clampConfidence(value: unknown, fallback = 0.65): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function isMeetingRequest(text: string): boolean {
  return /会議|ミーティング|打ち合わせ|Teams|Zoom|Meet|meeting|call|facilitate|進行|議事録|アクションアイテム|代理参加/i.test(
    text
  );
}

function isScheduleRequest(text: string): boolean {
  return /スケジュール|予定|日程|リスケ|resched|reschedule|calendar|カレンダー|調整|変更|空き時間|availability/i.test(
    text
  );
}

function isScheduleReadAgendaRequest(text: string): boolean {
  return (
    /(予定|スケジュール|日程|空き時間|会議|ミーティング|打ち合わせ|アポイント|agenda|availability|calendar)/i.test(
      text
    ) &&
    /(教えて|見せて|確認|見る|空き|agenda|available|availability|今週|来週|今日|明日)/i.test(text) &&
    !/(調整|変更|リスケ|ずら|移動|修正|update|change|resched|reschedule|入れ替え|前倒し|後ろ|見直し|再調整|詰め直し)/i.test(
      text
    )
  );
}

function isMeetingScheduleRequest(text: string): boolean {
  return isMeetingRequest(text) && isScheduleRequest(text);
}

function isMeetingScheduleCoordination(seed: ExecutionBriefSeed): boolean {
  return seed.intentId === 'schedule-coordination' && isMeetingScheduleRequest(seed.requestText);
}

function isScheduleAgendaRead(seed: ExecutionBriefSeed): boolean {
  return seed.intentId === 'schedule-read-agenda' || isScheduleReadAgendaRequest(seed.requestText);
}

function isProjectBootstrapRequest(text: string): boolean {
  return /Webサービス|webサービス|新しいプロジェクト|新規プロジェクト|プロジェクト.*(作って|立ち上げ|始め)|新規事業|build a service|create a service/i.test(
    text
  );
}

function isApprovalRequestCreation(text: string): boolean {
  return /(承認を依頼|承認を申請|承認依頼|稟議.*依頼|request approval|approval request)/i.test(text);
}

function isApprovalRequestResolution(text: string): boolean {
  return /(稟議|決裁|承認して|承認し|承認待ち|approve|approved?|通して|処理して)/i.test(text);
}

function isApprovalWorkflowRequest(text: string): boolean {
  return isApprovalRequestCreation(text) || isApprovalRequestResolution(text);
}

function inferApprovalSystemCandidates(seed: ExecutionBriefSeed): string[] {
  const text = seed.requestText;
  const candidates: string[] = [];
  if (seed.approvalSystemHint?.trim()) candidates.push(seed.approvalSystemHint.trim());
  if (seed.serviceBindings?.length) {
    for (const binding of seed.serviceBindings) {
      if (/ringi|approval|workflow|稟議/i.test(binding)) candidates.push(binding.trim());
    }
  }
  const defaults = resolveDefaultApprovalSystem();
  if (defaults.system) candidates.push(defaults.system);
  if (/(kintone|サイボウズ|cybozu|garoon|desknet's|workflow|稟議システム|intra-mart|SAP|oracle|freee|ジョブカン|salesforce|notion)/i.test(text)) {
    const match = text.match(/(kintone|サイボウズ|cybozu|garoon|desknet's|workflow|稟議システム|intra-mart|SAP|oracle|freee|ジョブカン|salesforce|notion)/i);
    if (match?.[1]) candidates.push(match[1]);
  }
  if (candidates.length === 0) candidates.push('operator_default_approval_system');
  return uniqueStrings(candidates);
}

function inferApprovalWorkflowSteps(seed: ExecutionBriefSeed, selectedSystem?: string): ApprovalWorkflowStep[] {
  const system = selectedSystem || inferApprovalSystemCandidates(seed)[0] || 'operator_default_approval_system';
  const approvalScope = seed.approvalScopeHint || resolveDefaultApprovalSystem().scope || 'pending_items';
  return [
    {
      id: 'resolve_approval_system',
      label: 'Identify approval system',
      description: `Resolve the company approval system to use (${system}).`,
      actuator: 'service-actuator',
      phase: 'resolve_system',
      output_refs: ['approval_system'],
    },
    {
      id: 'authenticate',
      label: 'Log in',
      description: 'Open the approval system and authenticate with the governed browser surface.',
      actuator: 'browser-actuator',
      phase: 'authenticate',
      input_refs: ['approval_system'],
      output_refs: ['approval_session'],
    },
    {
      id: 'list_pending',
      label: 'List pending approvals',
      description: `Open the pending approvals queue for scope: ${approvalScope}.`,
      actuator: 'approval-actuator',
      phase: 'list_pending',
      input_refs: ['approval_system', 'approval_scope'],
      output_refs: ['pending_approval_items'],
    },
    {
      id: 'review_item',
      label: 'Review target items',
      description: 'Inspect the target approval items and extract the details needed for a decision.',
      actuator: 'browser-actuator',
      phase: 'review_item',
      input_refs: ['pending_approval_items'],
      output_refs: ['approval_review_notes'],
    },
    {
      id: 'decide',
      label: 'Approve or reject',
      description: 'Apply the governed approval decision to the selected items.',
      actuator: 'approval-actuator',
      phase: 'decide',
      requires_confirmation: true,
      input_refs: ['approval_review_notes'],
      output_refs: ['approval_resolved'],
    },
    {
      id: 'summarize',
      label: 'Summarize outcome',
      description: 'Return a concise summary of the decision and any unresolved follow-up items.',
      actuator: 'service-actuator',
      phase: 'summarize',
      input_refs: ['approval_resolved'],
      output_refs: ['approval_summary'],
    },
  ];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function sanitizeQuestion(value: unknown, fallbackId: string): ExecutionBriefQuestion {
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
        : 'The request cannot be executed safely without this input.',
    default_assumption:
      typeof question.default_assumption === 'string' &&
      question.default_assumption.trim().length > 0
        ? question.default_assumption
        : undefined,
    impact:
      typeof question.impact === 'string' && question.impact.trim().length > 0
        ? question.impact
        : undefined,
  };
}

function inferArchetypeId(seed: ExecutionBriefSeed): string {
  if (seed.intentId && seed.intentId.trim().length > 0) return seed.intentId;
  if (seed.taskType && seed.taskType.trim().length > 0) return `${seed.taskType}-execution`;
  if (isScheduleAgendaRead(seed)) return 'schedule-read-agenda';
  if (isApprovalRequestResolution(seed.requestText)) return 'resolve-approval';
  if (isApprovalRequestCreation(seed.requestText)) return 'request-approval';
  if (isMeetingRequest(seed.requestText)) return 'meeting-operations';
  if (isScheduleRequest(seed.requestText)) return 'schedule-coordination';
  if (isProjectBootstrapRequest(seed.requestText)) return 'bootstrap-project';
  return 'general-request';
}

function inferTargetActuators(seed: ExecutionBriefSeed): string[] {
  const taskType = seed.taskType || '';
  const intentId = seed.intentId || '';

  if (taskType === 'presentation_deck') return ['presentation-outline-compiler', 'pptx-generator'];
  if (taskType === 'report_document' || taskType === 'document_generation')
    return ['document-outline-compiler', 'document-generator'];
  if (taskType === 'service_operation') return ['task-session-manager', 'service-orchestrator'];
  if (taskType === 'analysis') return ['analysis-engine', 'knowledge-retriever'];
  if (taskType === 'browser') return ['browser-actuator', 'web-retriever'];
  if (taskType === 'capture_photo') return ['camera-actuator', 'media-ingest'];
  if (taskType === 'workbook_wbs') return ['workbook-builder', 'spreadsheet-actuator'];
  if (isScheduleAgendaRead(seed)) return ['calendar-actuator', 'service-actuator'];
  if (isApprovalWorkflowRequest(seed.requestText)) return ['browser-actuator', 'approval-actuator', 'service-actuator'];
  if (isMeetingRequest(seed.requestText)) return ['meeting-actuator', 'meeting-browser-driver'];
  if (isScheduleRequest(seed.requestText)) return ['browser-actuator', 'service-actuator'];
  if (isProjectBootstrapRequest(seed.requestText))
    return ['orchestrator-actuator', 'artifact-actuator', 'wisdom-actuator'];

  if (/booking|reservation|appointment|purchase|order|schedule/i.test(intentId)) {
    return ['concierge-router', 'search-and-compare'];
  }
  return ['intent-compiler', 'work-loop-compiler'];
}

function inferDeliverables(seed: ExecutionBriefSeed): string[] {
  const outcomeIds = toStringArray(seed.outcomeIds);
  if (outcomeIds.length > 0) return outcomeIds;

  switch (seed.taskType) {
    case 'presentation_deck':
      return ['artifact:pptx'];
    case 'report_document':
    case 'document_generation':
      return ['artifact:doc'];
    case 'analysis':
      return ['artifact:analysis-report'];
    case 'browser':
      return ['artifact:browser-session'];
    case 'service_operation':
      return ['artifact:managed-program-plan'];
    case 'workbook_wbs':
      return ['artifact:xlsx'];
    default:
      if (isScheduleAgendaRead(seed)) return ['calendar_agenda_summary'];
      if (isApprovalRequestResolution(seed.requestText)) return ['approval_resolved'];
      if (isApprovalRequestCreation(seed.requestText)) return ['approval_request_created'];
      if (isMeetingRequest(seed.requestText)) return ['meeting_operations_summary'];
      if (isScheduleRequest(seed.requestText)) return ['schedule_coordination_summary'];
      if (isProjectBootstrapRequest(seed.requestText)) return ['project_created'];
      return [seed.intentId ? `intent:${seed.intentId}` : 'artifact:governed-outcome'];
  }
}

function inferMissingInputs(seed: ExecutionBriefSeed, guidedMissingInputs: string[] = []): string[] {
  const requiredInputs = toStringArray(seed.requiredInputs);
  const contextualFrame = seed.contextualFrame || buildContextualIntentFrame(seed.requestText);
  const candidateMissingInputs = (() => {
  if (requiredInputs.length > 0) return requiredInputs;
  if (isScheduleAgendaRead(seed)) {
    const agendaMissing = [...contextualFrame.missing];
    if (agendaMissing.length > 0) return agendaMissing;
    if (!contextualFrame.source_binding.selected) return ['calendar_source'];
    return [];
  }
  if (isApprovalWorkflowRequest(seed.requestText)) {
    const approvalMissing = ['approval_system', 'approval_scope'];
    if (seed.intentId === 'request-approval') return approvalMissing;
    if (seed.intentId === 'resolve-approval') return approvalMissing;
    return approvalMissing;
  }
  if (isMeetingScheduleCoordination(seed)) {
      return [
        'schedule_scope',
        'date_range',
        'fixed_constraints',
        'calendar_action_boundary',
        'meeting_handoff_boundary',
      ];
    }
    if (isMeetingRequest(seed.requestText)) {
      return ['meeting_url', 'meeting_role_boundary', 'meeting_purpose'];
    }
    if (isScheduleRequest(seed.requestText)) {
      return ['schedule_scope', 'date_range', 'fixed_constraints', 'calendar_action_boundary'];
    }
    if (isProjectBootstrapRequest(seed.requestText)) {
      return ['project_brief'];
    }
    if (guidedMissingInputs.length > 0) return guidedMissingInputs;
    return seed.executionShape === 'direct_reply' ? ['goal_or_target'] : [];
  })();
  const assessment = assessContextualClarification({
    intentId: seed.intentId || inferArchetypeId(seed),
    text: seed.requestText,
    executionShape: seed.executionShape,
    requiredInputs: candidateMissingInputs,
    confidence: seed.confidence,
    contextualFrame,
  });
  return assessment.shouldClarify ? candidateMissingInputs : [];
}

function inferReadiness(missingInputs: string[]): ActuatorExecutionBrief['readiness'] {
  return missingInputs.length > 0 ? 'needs_clarification' : 'fully_automatable';
}

function inferReadinessReason(seed: ExecutionBriefSeed, missingInputs: string[]): string {
  if (missingInputs.length > 0) {
    const missing = `Missing inputs: ${missingInputs.join(', ')}.`;
    if (isScheduleAgendaRead(seed)) {
      return `${missing} Once the calendar source is known, the assistant can return a read-only agenda summary.`;
    }
    if (isApprovalWorkflowRequest(seed.requestText)) {
      return `${missing} Once the approval system and scope are known, the assistant can open the queue, review pending items, and process the target approvals.`;
    }
    if (isMeetingScheduleCoordination(seed)) {
      return `${missing} Once clarified, the request can start in schedule coordination and hand off to meeting operations if live meeting handling matters.`;
    }
    return missing;
  }
  if (isScheduleAgendaRead(seed)) {
    return 'The request can be routed through the governed schedule agenda summary path.';
  }
  if (isApprovalWorkflowRequest(seed.requestText)) {
    return 'The request can be routed through the governed approval workflow path: resolve system, authenticate, inspect pending items, and decide.';
  }
  if (isMeetingScheduleCoordination(seed)) {
    return 'The request can start in schedule coordination and hand off to meeting operations if live meeting handling matters.';
  }
  if (isMeetingRequest(seed.requestText)) {
    return 'The request can be routed through the governed meeting operations path.';
  }
  if (isScheduleRequest(seed.requestText)) {
    return 'The request can be routed through the governed schedule coordination path.';
  }
  if (isProjectBootstrapRequest(seed.requestText)) {
    return 'The request can be routed through the governed project bootstrap path.';
  }
  if (seed.taskType) {
    return `The request can be routed through the governed ${seed.taskType} path.`;
  }
  return 'The request can be routed through a governed execution path.';
}

function inferSummary(seed: ExecutionBriefSeed): string {
  return seed.goalSummary?.trim() || seed.summaryHint?.trim() || seed.requestText.trim();
}

function inferUserFacingSummary(summary: string): string {
  if (summary.length <= 120) return summary;
  return `${summary.slice(0, 117)}...`;
}

function inferNormalizedScope(seed: ExecutionBriefSeed): string[] {
  const scope = [
    seed.intentId,
    seed.taskType,
    seed.tier,
    seed.locale,
    seed.projectName,
    seed.trackName,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  return scope.length > 0 ? scope : ['general'];
}

function inferServiceBindingRefs(seed: ExecutionBriefSeed): string[] {
  return Array.isArray(seed.serviceBindings)
    ? Array.from(new Set(seed.serviceBindings.map((value) => value.trim()).filter(Boolean)))
    : [];
}

function inferAssumptions(seed: ExecutionBriefSeed, missingInputs: string[]): string[] {
  const assumptions: string[] = [];
  if (seed.tier) assumptions.push(`Operate within the ${seed.tier} knowledge tier.`);
  if (seed.serviceBindings && seed.serviceBindings.length > 0) {
    assumptions.push(`Reuse configured service bindings: ${seed.serviceBindings.join(', ')}.`);
  }
  if (missingInputs.length === 0) {
    assumptions.push('Proceed with governed defaults unless the user overrides them.');
  }
  return assumptions;
}

function inferClarificationQuestions(seed: ExecutionBriefSeed, missingInputs: string[]) {
  if (isProjectBootstrapRequest(seed.requestText)) {
    const questionByInput: Record<string, { question: string; reason: string; impact: string }> = {
      project_brief: {
        question: 'What is the project brief and the first outcome you want?',
        reason: 'The assistant needs a governed project brief before bootstrapping work.',
        impact: 'This determines the initial project record and first work items.',
      },
    };

    return missingInputs.map((item) =>
      sanitizeQuestion(
        {
          id: item,
          question: questionByInput[item]?.question || `Please provide ${item.replace(/_/g, ' ')}.`,
          reason:
            questionByInput[item]?.reason ||
            'The request cannot be executed safely without this input.',
          default_assumption:
            seed.executionShape === 'task_session'
              ? 'Use governed defaults until clarified.'
              : undefined,
          impact:
            questionByInput[item]?.impact ||
            'This affects execution routing or the final artifact.',
        },
        item
      )
    );
  }

  if (isMeetingScheduleCoordination(seed)) {
    const questionByInput: Record<string, { question: string; reason: string; impact: string }> = {
      schedule_scope: {
        question: 'Whose schedule are we adjusting?',
        reason: 'The assistant needs to know which calendar or participant set is in scope.',
        impact: 'This determines which commitments can be moved.',
      },
      date_range: {
        question: 'What date or time window should be changed?',
        reason: 'The assistant needs the target range before proposing or editing slots.',
        impact: 'This controls the candidate slots and priority ordering.',
      },
      fixed_constraints: {
        question: 'Which commitments cannot move?',
        reason: 'The assistant needs the hard constraints before reshuffling the schedule.',
        impact: 'This constrains which events can be moved or preserved.',
      },
      calendar_action_boundary: {
        question: 'May I only propose options, or may I update the calendar directly?',
        reason: 'The assistant needs an authority boundary before applying changes.',
        impact: 'This decides whether the result is a proposal or an applied update.',
      },
      meeting_handoff_boundary: {
        question: 'Is this only a calendar edit, or should I hand it to meeting operations?',
        reason:
          'The assistant needs to know whether to stay in schedule coordination or hand off to meeting operations.',
        impact:
          'This decides whether the workflow stops at schedule changes or continues into live meeting handling.',
      },
    };

    return missingInputs.map((item) =>
      sanitizeQuestion(
        {
          id: item,
          question: questionByInput[item]?.question || `Please provide ${item.replace(/_/g, ' ')}.`,
          reason:
            questionByInput[item]?.reason ||
            'The request cannot be executed safely without this input.',
          default_assumption:
            seed.executionShape === 'task_session'
              ? 'Use governed defaults until clarified.'
              : undefined,
          impact:
            questionByInput[item]?.impact ||
            'This affects execution routing or the final artifact.',
        },
        item
      )
    );
  }

  if (isScheduleRequest(seed.requestText)) {
    const questionByInput: Record<string, { question: string; reason: string; impact: string }> = {
      schedule_scope: {
        question: 'Whose schedule are we adjusting?',
        reason: 'The assistant needs to know which calendar or participant set is in scope.',
        impact: 'This determines which commitments can be moved.',
      },
      date_range: {
        question: 'What date or time window should be changed?',
        reason: 'The assistant needs the target range before proposing or editing slots.',
        impact: 'This controls the candidate slots and priority ordering.',
      },
      fixed_constraints: {
        question: 'Which commitments cannot move?',
        reason: 'The assistant needs the hard constraints before reshuffling the schedule.',
        impact: 'This constrains which events can be moved or preserved.',
      },
      calendar_action_boundary: {
        question: 'May I only propose options, or may I update the calendar directly?',
        reason: 'The assistant needs an authority boundary before applying changes.',
        impact: 'This decides whether the result is a proposal or an applied update.',
      },
    };

    return missingInputs.map((item) =>
      sanitizeQuestion(
        {
          id: item,
          question: questionByInput[item]?.question || `Please provide ${item.replace(/_/g, ' ')}.`,
          reason:
            questionByInput[item]?.reason ||
            'The request cannot be executed safely without this input.',
          default_assumption:
            seed.executionShape === 'task_session'
              ? 'Use governed defaults until clarified.'
              : undefined,
          impact:
            questionByInput[item]?.impact ||
            'This affects execution routing or the final artifact.',
        },
        item
      )
    );
  }

  if (isScheduleAgendaRead(seed)) {
    const questionByInput: Record<string, { question: string; reason: string; impact: string; default_assumption: string }> = {
      date_range: {
        question: 'Which time range should I inspect?',
        reason: 'The assistant needs a concrete window before reading calendar entries.',
        impact: 'This determines which events are included in the agenda summary.',
        default_assumption: 'Use the next seven days if the operator does not specify a range.',
      },
      calendar_source: {
        question: 'Which calendar should I read?',
        reason: 'The assistant needs the source calendar when no default is stored.',
        impact: 'This determines which calendar account the agenda summary uses.',
        default_assumption: 'Use the operator default calendar if it is already registered.',
      },
    };

    return missingInputs.map((item) =>
      sanitizeQuestion(
        {
          id: item,
          question: questionByInput[item]?.question || `Please provide ${item.replace(/_/g, ' ')}.`,
          reason:
            questionByInput[item]?.reason ||
            'The request cannot be executed safely without this input.',
          default_assumption: questionByInput[item]?.default_assumption,
          impact:
            questionByInput[item]?.impact ||
            'This affects execution routing or the final artifact.',
        },
        item
      )
    );
  }

  if (isApprovalWorkflowRequest(seed.requestText)) {
    const questionByInput: Record<string, { question: string; reason: string; impact: string; default_assumption: string }> = {
      approval_system: {
        question: 'Which ringi or approval system should I use?',
        reason: 'The assistant needs the target approval system before it can open the queue.',
        impact: 'This determines which approval inbox, portal, or workflow system is used.',
        default_assumption: 'Use the operator default approval system if one is already registered.',
      },
      approval_scope: {
        question: 'Which approvals should I process?',
        reason: 'The assistant needs to know whether to handle all pending approvals or only a subset.',
        impact: 'This controls which items are listed and which ones are selected for decision.',
        default_assumption: 'Process the pending approvals for the current business context if no narrower scope is given.',
      },
    };

    return missingInputs.map((item) =>
      sanitizeQuestion(
        {
          id: item,
          question: questionByInput[item]?.question || `Please provide ${item.replace(/_/g, ' ')}.`,
          reason:
            questionByInput[item]?.reason ||
            'The request cannot be executed safely without this input.',
          default_assumption: questionByInput[item]?.default_assumption,
          impact:
            questionByInput[item]?.impact ||
            'This affects execution routing or the final artifact.',
        },
        item
      )
    );
  }

  return missingInputs.map((item) =>
    sanitizeQuestion(
      {
        id: item,
        question: `Please provide ${item.replace(/_/g, ' ')}.`,
        reason: 'The request cannot be executed safely without this input.',
        default_assumption:
          seed.executionShape === 'task_session'
            ? 'Use governed defaults until clarified.'
            : undefined,
        impact: 'This affects execution routing or the final artifact.',
      },
      item
    )
  );
}

function inferTouchpoints() {
  return [
    {
      stage: 'execution_brief',
      purpose: 'Extract the request into a governed execution brief before planning.',
      output_contract: 'actuator-execution-brief',
    },
    {
      stage: 'intent_contract',
      purpose: 'Turn the brief into a governed intent contract.',
      output_contract: 'intent-contract',
    },
    {
      stage: 'work_loop',
      purpose: 'Derive the governed work loop and execution plan.',
      output_contract: 'organization-work-loop',
    },
  ];
}

export function validateExecutionBrief(value: unknown): {
  valid: boolean;
  errors: string[];
  value?: ActuatorExecutionBrief;
} {
  const validate = ensureExecutionBriefValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: (validate.errors || []).map((error) =>
      `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
    ),
    value: valid ? (value as ActuatorExecutionBrief) : undefined,
  };
}

export function buildExecutionBriefFromGuidedCoordinationBrief(
  guidedBrief: GuidedCoordinationBrief,
  seed: ExecutionBriefSeed
): ActuatorExecutionBrief {
  let missingInputs = inferMissingInputs(seed, guidedBrief.missing_inputs);
  let targetActuators = guidedBrief.suggested_target_actuators;
  let deliverables = guidedBrief.suggested_deliverables;
  let workflowSteps: ApprovalWorkflowStep[] | undefined;
  let approvalSystemCandidates: string[] | undefined;
  if (isScheduleAgendaRead(seed)) {
    targetActuators = ['calendar-actuator', 'wisdom-actuator'];
    deliverables = ['calendar_agenda_summary'];
  }

  if (isApprovalRequestResolution(seed.requestText)) {
    approvalSystemCandidates = inferApprovalSystemCandidates(seed);
    targetActuators = ['browser-actuator', 'approval-actuator', 'service-actuator'];
    deliverables = ['approval_resolved'];
    workflowSteps = inferApprovalWorkflowSteps(seed, approvalSystemCandidates[0]);
  }

  if (isApprovalRequestCreation(seed.requestText)) {
    approvalSystemCandidates = inferApprovalSystemCandidates(seed);
    targetActuators = ['browser-actuator', 'approval-actuator', 'service-actuator'];
    deliverables = ['approval_request_created'];
    workflowSteps = inferApprovalWorkflowSteps(seed, approvalSystemCandidates[0]);
  }

  if (isProjectBootstrapRequest(seed.requestText)) {
    targetActuators = ['orchestrator-actuator', 'artifact-actuator', 'wisdom-actuator'];
    deliverables = ['project_created'];
  }

  return {
    kind: 'actuator-execution-brief',
    request_text: seed.requestText,
    archetype_id: inferArchetypeId(seed),
    confidence: clampConfidence(seed.confidence, missingInputs.length > 0 ? 0.56 : 0.72),
    summary: guidedBrief.objective,
    user_facing_summary: inferUserFacingSummary(guidedBrief.objective),
    normalized_scope: uniqueStrings([guidedBrief.coordination_kind, ...inferNormalizedScope(seed)]),
    target_actuators: targetActuators,
    deliverables,
    missing_inputs: missingInputs,
    input_bindings: resolveInputBindings(missingInputs) as InputBinding[],
    service_binding_refs: inferServiceBindingRefs(seed),
    approval_system_candidates: approvalSystemCandidates,
    approval_system: approvalSystemCandidates?.[0] || resolveDefaultApprovalSystem().system,
    approval_scope: seed.approvalScopeHint || resolveDefaultApprovalSystem().scope,
    workflow_steps: workflowSteps,
    assumptions: guidedBrief.assumptions,
    clarification_questions: inferClarificationQuestions(seed, missingInputs),
    readiness: inferReadiness(missingInputs),
    readiness_reason: inferReadinessReason(seed, missingInputs),
    llm_touchpoints: inferTouchpoints(),
    recommended_next_step:
      missingInputs.length > 0
        ? 'Collect the missing inputs before compiling the intent contract.'
        : guidedBrief.recommended_next_step || 'Compile the intent contract and work loop.',
  };
}

export function buildFallbackExecutionBrief(seed: ExecutionBriefSeed): ActuatorExecutionBrief {
  const contextualFrame = seed.contextualFrame || buildContextualIntentFrame(seed.requestText);
  const guidedBrief = buildGuidedCoordinationBrief({
    requestText: seed.requestText,
    intentId: seed.intentId,
    goalSummary: seed.goalSummary,
    serviceBindings: seed.serviceBindings,
    tier: seed.tier,
    locale: seed.locale,
    summaryHint: seed.summaryHint,
  });

  const adjustedSeed: ExecutionBriefSeed = {
    ...seed,
    contextualFrame,
    requiredInputs: seed.requiredInputs,
  };

  const brief = buildExecutionBriefFromGuidedCoordinationBrief(guidedBrief, adjustedSeed);
  return {
    ...brief,
    calendar_source: contextualFrame.source_binding.selected || resolveDefaultScheduleSource().source,
  } as ActuatorExecutionBrief;
}

export function normalizeExecutionBrief(
  rawValue: unknown,
  seed: ExecutionBriefSeed
): ActuatorExecutionBrief {
  const fallback = buildFallbackExecutionBrief(seed);
  const raw = rawValue && typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : {};

  const candidate: ActuatorExecutionBrief = {
    ...fallback,
    kind: 'actuator-execution-brief',
    request_text:
      typeof raw.request_text === 'string' && raw.request_text.trim().length > 0
        ? raw.request_text
        : fallback.request_text,
    archetype_id:
      typeof raw.archetype_id === 'string' && raw.archetype_id.trim().length > 0
        ? raw.archetype_id
        : fallback.archetype_id,
    confidence: clampConfidence(raw.confidence, fallback.confidence),
    summary:
      typeof raw.summary === 'string' && raw.summary.trim().length > 0
        ? raw.summary
        : fallback.summary,
    user_facing_summary:
      typeof raw.user_facing_summary === 'string' && raw.user_facing_summary.trim().length > 0
        ? raw.user_facing_summary
        : fallback.user_facing_summary,
    normalized_scope:
      toStringArray(raw.normalized_scope).length > 0
        ? toStringArray(raw.normalized_scope)
        : fallback.normalized_scope,
    target_actuators:
      toStringArray(raw.target_actuators).length > 0
        ? toStringArray(raw.target_actuators)
        : fallback.target_actuators,
    deliverables:
      toStringArray(raw.deliverables).length > 0
        ? toStringArray(raw.deliverables)
        : fallback.deliverables,
    missing_inputs:
      toStringArray(raw.missing_inputs).length > 0
        ? toStringArray(raw.missing_inputs)
        : fallback.missing_inputs,
    assumptions:
      toStringArray(raw.assumptions).length > 0
        ? toStringArray(raw.assumptions)
        : fallback.assumptions,
    clarification_questions:
      Array.isArray(raw.clarification_questions) && raw.clarification_questions.length > 0
        ? raw.clarification_questions.map((question, index) =>
            sanitizeQuestion(
              question,
              fallback.missing_inputs[index] || `missing_input_${index + 1}`
            )
          )
        : fallback.clarification_questions,
    readiness:
      raw.readiness === 'fully_automatable' ||
      raw.readiness === 'needs_clarification' ||
      raw.readiness === 'needs_external_asset' ||
      raw.readiness === 'blocked_by_runtime'
        ? raw.readiness
        : fallback.readiness,
    readiness_reason:
      typeof raw.readiness_reason === 'string' && raw.readiness_reason.trim().length > 0
        ? raw.readiness_reason
        : fallback.readiness_reason,
    llm_touchpoints:
      Array.isArray(raw.llm_touchpoints) && raw.llm_touchpoints.length > 0
        ? raw.llm_touchpoints
            .map((touchpoint) =>
              touchpoint && typeof touchpoint === 'object'
                ? (touchpoint as Record<string, unknown>)
                : {}
            )
            .map((touchpoint) => ({
              stage:
                typeof touchpoint.stage === 'string' && touchpoint.stage.trim().length > 0
                  ? touchpoint.stage
                  : 'execution_brief',
              purpose:
                typeof touchpoint.purpose === 'string' && touchpoint.purpose.trim().length > 0
                  ? touchpoint.purpose
                  : 'Extract the request into a governed brief.',
              output_contract:
                typeof touchpoint.output_contract === 'string' &&
                touchpoint.output_contract.trim().length > 0
                  ? touchpoint.output_contract
                  : 'actuator-execution-brief',
            }))
        : fallback.llm_touchpoints,
    recommended_next_step:
      typeof raw.recommended_next_step === 'string' && raw.recommended_next_step.trim().length > 0
        ? raw.recommended_next_step
        : fallback.recommended_next_step,
  };

  const validation = validateExecutionBrief(candidate);
  return validation.valid && validation.value ? validation.value : fallback;
}
