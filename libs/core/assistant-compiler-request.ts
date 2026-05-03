import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeWriteFile } from './secure-io.js';
import {
  inferGovernedDeliveryMode,
  type IntentCompilerProvider,
  type IntentContract,
} from './intent-contract.js';
import {
  buildOrganizationWorkLoopSummary,
  type OrganizationWorkLoopSummary,
} from './work-design.js';
import {
  buildFallbackExecutionBrief,
  normalizeExecutionBrief,
  type ExecutionBriefSeed,
} from './execution-brief.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';
import type { ActuatorExecutionBrief } from './src/types/actuator-execution-brief.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const REQUEST_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/assistant-compiler-request.schema.json'
);
const RESULT_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/assistant-compiler-result.schema.json'
);
const INTENT_CONTRACT_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/intent-contract.schema.json'
);
const WORK_LOOP_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/organization-work-loop.schema.json'
);
const EXECUTION_BRIEF_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/actuator-execution-brief.schema.json'
);

export interface AssistantCompilerRequest {
  kind: 'assistant-compiler-request';
  request_id: string;
  created_at: string;
  source: {
    origin: 'cli' | 'surface' | 'agent_runtime';
    channel?: string;
    surface?: string;
    runtime_id?: string;
  };
  source_text: string;
  context: {
    locale?: string;
    tier: 'personal' | 'confidential' | 'public';
    project_id?: string;
    project_name?: string;
    track_id?: string;
    track_name?: string;
    service_bindings: string[];
    runtime_context?: Record<string, unknown>;
  };
  delegation: {
    mode: 'compile_intent';
    preferred_provider?: IntentCompilerProvider;
    preferred_model?: string;
    preferred_model_provider?: string;
    allowed_providers: IntentCompilerProvider[];
  };
  expected_output: {
    contract: 'intent-bundle';
    write_back_path: string;
  };
}

export interface AssistantCompilerResult {
  kind: 'assistant-compiler-result';
  request_id: string;
  compiled_at: string;
  execution_brief: ActuatorExecutionBrief;
  intent_contract: IntentContract;
  work_loop: OrganizationWorkLoopSummary;
  clarification_packet?: OperatorInteractionPacket;
  source: {
    compiler: 'assistant-subagent';
    provider?: string;
    model?: string;
  };
}

export interface CreateAssistantCompilerRequestInput {
  source: AssistantCompilerRequest['source'];
  sourceText: string;
  locale?: string;
  tier?: 'personal' | 'confidential' | 'public';
  projectId?: string;
  projectName?: string;
  trackId?: string;
  trackName?: string;
  serviceBindings?: string[];
  runtimeContext?: Record<string, unknown>;
  preferredProvider?: IntentCompilerProvider;
  preferredModel?: string;
  preferredModelProvider?: string;
  allowedProviders?: IntentCompilerProvider[];
}

let requestValidateFn: ValidateFunction | null = null;
let resultValidateFn: ValidateFunction | null = null;
let intentContractValidateFn: ValidateFunction | null = null;
let workLoopValidateFn: ValidateFunction | null = null;
let executionBriefValidateFn: ValidateFunction | null = null;

function ensureRequestValidator(): ValidateFunction {
  if (requestValidateFn) return requestValidateFn;
  requestValidateFn = compileSchemaFromPath(ajv, REQUEST_SCHEMA_PATH);
  return requestValidateFn;
}

function ensureResultValidator(): ValidateFunction {
  if (resultValidateFn) return resultValidateFn;
  resultValidateFn = compileSchemaFromPath(ajv, RESULT_SCHEMA_PATH);
  return resultValidateFn;
}

function ensureIntentContractValidator(): ValidateFunction {
  if (intentContractValidateFn) return intentContractValidateFn;
  intentContractValidateFn = compileSchemaFromPath(ajv, INTENT_CONTRACT_SCHEMA_PATH);
  return intentContractValidateFn;
}

function ensureWorkLoopValidator(): ValidateFunction {
  if (workLoopValidateFn) return workLoopValidateFn;
  workLoopValidateFn = compileSchemaFromPath(ajv, WORK_LOOP_SCHEMA_PATH);
  return workLoopValidateFn;
}

function ensureExecutionBriefValidator(): ValidateFunction {
  if (executionBriefValidateFn) return executionBriefValidateFn;
  executionBriefValidateFn = compileSchemaFromPath(ajv, EXECUTION_BRIEF_SCHEMA_PATH);
  return executionBriefValidateFn;
}

function createRequestId() {
  return `assistant-compiler-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getAssistantCompilerRequestPath(requestId: string) {
  return pathResolver.sharedTmp(`assistant-compiler-requests/${requestId}.json`);
}

export function getAssistantCompilerResultPath(requestId: string) {
  return pathResolver.sharedTmp(`assistant-compiler-results/${requestId}.json`);
}

export function validateAssistantCompilerRequest(value: unknown): {
  valid: boolean;
  errors: string[];
  value?: AssistantCompilerRequest;
} {
  const validate = ensureRequestValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: (validate.errors || []).map((error) =>
      `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
    ),
    value: valid ? (value as AssistantCompilerRequest) : undefined,
  };
}

export function validateAssistantCompilerResult(value: unknown): {
  valid: boolean;
  errors: string[];
  value?: AssistantCompilerResult;
} {
  const validate = ensureResultValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: (validate.errors || []).map((error) =>
      `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
    ),
    value: valid ? (value as AssistantCompilerResult) : undefined,
  };
}

function validateIntentContract(value: unknown): value is IntentContract {
  return Boolean(ensureIntentContractValidator()(value));
}

function validateWorkLoop(value: unknown): value is OrganizationWorkLoopSummary {
  return Boolean(ensureWorkLoopValidator()(value));
}

function validateExecutionBrief(value: unknown): value is ActuatorExecutionBrief {
  return Boolean(ensureExecutionBriefValidator()(value));
}

function toExecutionBriefSeed(
  request: AssistantCompilerRequest,
  extras: Partial<ExecutionBriefSeed> = {}
): ExecutionBriefSeed {
  return {
    requestText: request.source_text,
    intentId: extras.intentId,
    goalSummary: extras.goalSummary,
    taskType: extras.taskType,
    executionShape: extras.executionShape,
    requiredInputs: extras.requiredInputs,
    outcomeIds: extras.outcomeIds,
    confidence: extras.confidence,
    tier: request.context.tier,
    locale: request.context.locale,
    projectName: request.context.project_name,
    trackName: request.context.track_name,
    serviceBindings: request.context.service_bindings,
    summaryHint: extras.summaryHint,
  };
}

function normalizeExecutionShape(value: unknown): IntentContract['resolution']['execution_shape'] {
  return value === 'direct_reply' || value === 'mission' || value === 'project_bootstrap'
    ? value
    : 'task_session';
}

function inferTaskType(text: string, rawResolution?: unknown): string | undefined {
  if (
    typeof rawResolution === 'object' &&
    rawResolution &&
    typeof (rawResolution as any).task_type === 'string'
  ) {
    return (rawResolution as any).task_type;
  }
  if (typeof rawResolution === 'string' && rawResolution.toLowerCase().includes('presentation'))
    return 'presentation_deck';
  if (
    text.includes('パワーポイント') ||
    text.toLowerCase().includes('powerpoint') ||
    text.toLowerCase().includes('ppt')
  ) {
    return 'presentation_deck';
  }
  return undefined;
}

function inferIntentId(text: string, rawIntentId?: unknown): string {
  if (typeof rawIntentId === 'string' && rawIntentId.trim().length > 0) return rawIntentId;
  if (
    text.includes('パワーポイント') ||
    text.toLowerCase().includes('powerpoint') ||
    text.toLowerCase().includes('ppt')
  ) {
    return 'generate-presentation';
  }
  return 'general_request';
}

function inferDeliveryModeFromRaw(
  text: string,
  rawDeliveryMode: unknown,
  requiredInputs: string[]
): 'one_shot' | 'managed_program' {
  if (rawDeliveryMode === 'managed_program' || rawDeliveryMode === 'one_shot')
    return rawDeliveryMode;
  return inferGovernedDeliveryMode(text, 'task_session', requiredInputs);
}

function normalizeIntentContractFromRaw(
  request: AssistantCompilerRequest,
  rawIntentContract: unknown,
  executionBrief?: ActuatorExecutionBrief
): IntentContract {
  if (validateIntentContract(rawIntentContract)) return rawIntentContract;

  const raw =
    rawIntentContract && typeof rawIntentContract === 'object'
      ? (rawIntentContract as Record<string, unknown>)
      : {};
  const goalSummary =
    typeof raw.goal === 'string'
      ? raw.goal
      : typeof raw.goal === 'object' && raw.goal && typeof (raw.goal as any).summary === 'string'
        ? (raw.goal as any).summary
        : executionBrief?.summary || request.source_text;
  const requiredInputs = Array.isArray(raw.required_inputs)
    ? raw.required_inputs.map(String).filter(Boolean)
    : executionBrief?.missing_inputs || [];
  const outcomeIds = Array.isArray(raw.outcome_ids)
    ? raw.outcome_ids
        .map((value) => (String(value) === 'presentation_deck' ? 'artifact:pptx' : String(value)))
        .filter(Boolean)
    : executionBrief?.deliverables ||
      (request.source_text.includes('パワーポイント') ? ['artifact:pptx'] : []);
  const approvalValue =
    typeof raw.approval === 'object' && raw.approval
      ? Boolean((raw.approval as any).requires_approval)
      : raw.approval === 'required';
  const inferredTaskType = executionBrief?.target_actuators?.includes('pptx-generator')
    ? 'presentation_deck'
    : inferTaskType(request.source_text, raw.resolution);

  return {
    kind: 'intent-contract',
    source_text: request.source_text,
    intent_id: inferIntentId(request.source_text, raw.intent_id || executionBrief?.archetype_id),
    goal: {
      summary: goalSummary,
      success_condition:
        typeof raw.goal === 'object' &&
        raw.goal &&
        typeof (raw.goal as any).success_condition === 'string'
          ? (raw.goal as any).success_condition
          : `${goalSummary} を governed artifact として成立させる。`,
    },
    resolution: {
      execution_shape: normalizeExecutionShape(
        typeof raw.resolution === 'object' && raw.resolution
          ? (raw.resolution as any).execution_shape
          : raw.resolution
      ),
      task_type: inferredTaskType,
    },
    required_inputs: requiredInputs,
    outcome_ids: outcomeIds,
    approval: {
      requires_approval: approvalValue,
    },
    delivery_mode: inferDeliveryModeFromRaw(request.source_text, raw.delivery_mode, requiredInputs),
    clarification_needed:
      typeof raw.clarification_needed === 'boolean'
        ? raw.clarification_needed
        : requiredInputs.length > 0,
    confidence: typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.6,
    why:
      typeof raw.why === 'string' && raw.why.trim().length > 0
        ? raw.why
        : 'Assistant sub-agent output was normalized into the governed intent-contract schema.',
  };
}

function normalizeClarificationPacket(
  request: AssistantCompilerRequest,
  contract: IntentContract,
  executionBrief?: ActuatorExecutionBrief,
  rawClarificationPacket?: unknown
): OperatorInteractionPacket | undefined {
  if (!contract.clarification_needed) return undefined;
  const raw =
    rawClarificationPacket && typeof rawClarificationPacket === 'object'
      ? (rawClarificationPacket as Record<string, unknown>)
      : {};
  const briefQuestions = executionBrief?.clarification_questions || [];
  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  const questions =
    rawQuestions.length > 0
      ? rawQuestions.map((question, index) => {
          if (typeof question === 'string') {
            return {
              id:
                contract.required_inputs[index] ||
                briefQuestions[index]?.id ||
                `missing_input_${index + 1}`,
              question,
              reason: 'The request cannot be executed safely without this input.',
            };
          }
          return {
            id:
              typeof (question as any)?.id === 'string'
                ? (question as any).id
                : contract.required_inputs[index] ||
                  briefQuestions[index]?.id ||
                  `missing_input_${index + 1}`,
            question:
              typeof (question as any)?.question === 'string'
                ? (question as any).question
                : briefQuestions[index]?.question ||
                  `Please provide ${contract.required_inputs[index] || 'the missing input'}.`,
            reason:
              typeof (question as any)?.reason === 'string'
                ? (question as any).reason
                : briefQuestions[index]?.reason ||
                  'The request cannot be executed safely without this input.',
          };
        })
      : briefQuestions.length > 0
        ? briefQuestions.map((question, index) => ({
            id: question.id || contract.required_inputs[index] || `missing_input_${index + 1}`,
            question: question.question,
            reason: question.reason,
          }))
        : contract.required_inputs.map((item) => ({
            id: item,
            question: `Please provide ${item}.`,
            reason: 'The request cannot be executed safely without this input.',
          }));

  return {
    kind: 'operator-interaction-packet',
    interaction_type: 'clarification',
    headline: 'More context is required before execution',
    summary: contract.goal.summary,
    execution_brief_summary: executionBrief?.user_facing_summary || executionBrief?.summary,
    confidence: contract.confidence,
    questions,
    suggested_response_style: 'clarify-first',
    llm_touchpoints: [
      {
        stage: 'guided_coordination_brief',
        purpose: 'Extract the request into a shared coordination brief before execution planning.',
        output_contract: 'guided-coordination-brief',
      },
      {
        stage: 'execution_brief',
        purpose: 'Refine the shared coordination brief into a governed execution brief',
        output_contract: 'actuator-execution-brief',
      },
      {
        stage: 'assistant_subagent_compiler',
        purpose: 'Compile the request into governed intent and work-loop contracts',
        output_contract: 'intent-bundle',
      },
    ],
    next_actions: [
      {
        id: 'provide_missing_inputs',
        action: 'Provide the missing inputs and rerun the assistant compiler flow.',
        next_action_type: 'clarify',
        priority: 'now',
      },
    ],
    readiness: contract.resolution.execution_shape,
  };
}

function normalizeWorkLoopFromRaw(
  request: AssistantCompilerRequest,
  contract: IntentContract,
  rawWorkLoop: unknown
): OrganizationWorkLoopSummary {
  if (validateWorkLoop(rawWorkLoop)) return rawWorkLoop;

  const normalized = buildOrganizationWorkLoopSummary({
    intentId: contract.intent_id,
    taskType: contract.resolution.task_type,
    shape: contract.resolution.execution_shape,
    utterance: request.source_text,
    outcomeIds: contract.outcome_ids,
    tier: request.context.tier,
    projectId: request.context.project_id,
    projectName: request.context.project_name,
    trackId: request.context.track_id,
    trackName: request.context.track_name,
    locale: request.context.locale,
    serviceBindings: request.context.service_bindings,
    requiresApproval: contract.approval.requires_approval,
  });

  if (Array.isArray(rawWorkLoop)) {
    const planOutline = rawWorkLoop.map(String).filter(Boolean);
    return {
      ...normalized,
      process_design: {
        ...normalized.process_design,
        plan_outline: planOutline,
        operator_checklist: Array.from(
          new Set([...planOutline, ...normalized.process_design.operator_checklist])
        ),
      },
    };
  }

  return normalized;
}

export function normalizeAssistantCompilerResult(
  request: AssistantCompilerRequest,
  rawValue: unknown
): AssistantCompilerResult {
  const directValidation = validateAssistantCompilerResult(rawValue);
  if (directValidation.valid && directValidation.value) return directValidation.value;

  const raw = rawValue && typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : {};
  const executionBriefSeed = toExecutionBriefSeed(request, {
    intentId:
      typeof raw.intent_contract === 'object' &&
      raw.intent_contract &&
      typeof (raw.intent_contract as any).intent_id === 'string'
        ? (raw.intent_contract as any).intent_id
        : undefined,
  });
  let executionBrief = normalizeExecutionBrief(raw.execution_brief, executionBriefSeed);
  const intentContract = normalizeIntentContractFromRaw(
    request,
    raw.intent_contract,
    executionBrief
  );
  if (!raw.execution_brief) {
    executionBrief = buildFallbackExecutionBrief(
      toExecutionBriefSeed(request, {
        intentId: intentContract.intent_id,
        goalSummary: intentContract.goal.summary,
        taskType: intentContract.resolution.task_type,
        executionShape: intentContract.resolution.execution_shape,
        requiredInputs: intentContract.required_inputs,
        outcomeIds: intentContract.outcome_ids,
        confidence: intentContract.confidence,
      })
    );
  }
  const workLoop = normalizeWorkLoopFromRaw(request, intentContract, raw.work_loop);
  const clarificationPacket = normalizeClarificationPacket(
    request,
    intentContract,
    executionBrief,
    raw.clarification_packet
  );

  const result: AssistantCompilerResult = {
    kind: 'assistant-compiler-result',
    request_id: request.request_id,
    compiled_at: new Date().toISOString(),
    execution_brief: executionBrief,
    intent_contract: intentContract,
    work_loop: workLoop,
    clarification_packet: clarificationPacket,
    source: {
      compiler: 'assistant-subagent',
      provider:
        typeof raw.source === 'object' &&
        raw.source &&
        typeof (raw.source as any).provider === 'string'
          ? (raw.source as any).provider
          : request.delegation.preferred_provider,
      model:
        typeof raw.source === 'object' &&
        raw.source &&
        typeof (raw.source as any).model === 'string'
          ? (raw.source as any).model
          : request.delegation.preferred_model,
    },
  };

  const validation = validateAssistantCompilerResult(result);
  if (!validation.valid) {
    throw new Error(
      `Invalid normalized assistant compiler result: ${validation.errors.join('; ')}`
    );
  }
  return result;
}

export function buildAssistantCompilerRequest(
  input: CreateAssistantCompilerRequestInput
): AssistantCompilerRequest {
  const requestId = createRequestId();
  const request: AssistantCompilerRequest = {
    kind: 'assistant-compiler-request',
    request_id: requestId,
    created_at: new Date().toISOString(),
    source: input.source,
    source_text: input.sourceText,
    context: {
      locale: input.locale,
      tier: input.tier || 'confidential',
      project_id: input.projectId,
      project_name: input.projectName,
      track_id: input.trackId,
      track_name: input.trackName,
      service_bindings: input.serviceBindings || [],
      runtime_context: input.runtimeContext || {},
    },
    delegation: {
      mode: 'compile_intent',
      preferred_provider: input.preferredProvider,
      preferred_model: input.preferredModel,
      preferred_model_provider: input.preferredModelProvider,
      allowed_providers:
        input.allowedProviders && input.allowedProviders.length > 0
          ? input.allowedProviders
          : ['codex', 'gemini', 'claude'],
    },
    expected_output: {
      contract: 'intent-bundle',
      write_back_path: getAssistantCompilerResultPath(requestId),
    },
  };
  const validation = validateAssistantCompilerRequest(request);
  if (!validation.valid) {
    throw new Error(`Invalid assistant compiler request: ${validation.errors.join('; ')}`);
  }
  return request;
}

export function writeAssistantCompilerRequest(request: AssistantCompilerRequest): string {
  const validation = validateAssistantCompilerRequest(request);
  if (!validation.valid) {
    throw new Error(`Invalid assistant compiler request: ${validation.errors.join('; ')}`);
  }
  const requestPath = getAssistantCompilerRequestPath(request.request_id);
  safeWriteFile(requestPath, JSON.stringify(request, null, 2));
  return requestPath;
}

export function createAssistantCompilerRequest(input: CreateAssistantCompilerRequestInput): {
  request: AssistantCompilerRequest;
  requestPath: string;
} {
  const request = buildAssistantCompilerRequest(input);
  const requestPath = writeAssistantCompilerRequest(request);
  return { request, requestPath };
}

export function writeAssistantCompilerResult(
  result: AssistantCompilerResult,
  outputPath?: string
): string {
  const validation = validateAssistantCompilerResult(result);
  if (!validation.valid) {
    throw new Error(`Invalid assistant compiler result: ${validation.errors.join('; ')}`);
  }
  const targetPath = outputPath || getAssistantCompilerResultPath(result.request_id);
  safeWriteFile(targetPath, JSON.stringify(result, null, 2));
  return targetPath;
}
