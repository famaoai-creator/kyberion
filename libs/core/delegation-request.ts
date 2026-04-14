import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeWriteFile } from './secure-io.js';
import type { IntentCompilerProvider, IntentContract } from './intent-contract.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const DELEGATION_REQUEST_SCHEMA_PATH = pathResolver.knowledge('public/schemas/assistant-delegation-request.schema.json');

export type AssistantDelegationMode = 'plan_only' | 'investigate' | 'implement';
export type AssistantDelegationOutputContract = 'planning_packet' | 'organization-work-loop' | 'pipeline-adf' | 'report';

export interface AssistantDelegationRequest {
  kind: 'assistant-delegation-request';
  request_id: string;
  created_at: string;
  source: {
    origin: 'cli' | 'surface' | 'agent_runtime';
    channel?: string;
    surface?: string;
    runtime_id?: string;
  };
  goal: string;
  source_text: string;
  context: {
    locale?: string;
    tier: 'personal' | 'confidential' | 'public';
    project_id?: string;
    project_name?: string;
    track_id?: string;
    track_name?: string;
    service_bindings: string[];
  };
  intent_contract: IntentContract;
  work_loop: OrganizationWorkLoopSummary;
  clarification_packet?: OperatorInteractionPacket;
  delegation: {
    mode: AssistantDelegationMode;
    preferred_provider?: IntentCompilerProvider;
    preferred_model?: string;
    preferred_model_provider?: string;
    allowed_providers: IntentCompilerProvider[];
  };
  expected_output: {
    contract: AssistantDelegationOutputContract;
    write_back_path: string;
  };
}

export interface CreateAssistantDelegationRequestInput {
  source: AssistantDelegationRequest['source'];
  sourceText: string;
  intentContract: IntentContract;
  workLoop: OrganizationWorkLoopSummary;
  clarificationPacket?: OperatorInteractionPacket;
  locale?: string;
  tier?: 'personal' | 'confidential' | 'public';
  projectId?: string;
  projectName?: string;
  trackId?: string;
  trackName?: string;
  serviceBindings?: string[];
  mode?: AssistantDelegationMode;
  expectedOutputContract?: AssistantDelegationOutputContract;
  preferredProvider?: IntentCompilerProvider;
  preferredModel?: string;
  preferredModelProvider?: string;
  allowedProviders?: IntentCompilerProvider[];
}

let delegationRequestValidateFn: ValidateFunction | null = null;

function ensureDelegationRequestValidator(): ValidateFunction {
  if (delegationRequestValidateFn) return delegationRequestValidateFn;
  delegationRequestValidateFn = compileSchemaFromPath(ajv, DELEGATION_REQUEST_SCHEMA_PATH);
  return delegationRequestValidateFn;
}

export function validateAssistantDelegationRequest(value: unknown): { valid: boolean; errors: string[]; value?: AssistantDelegationRequest } {
  const validate = ensureDelegationRequestValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()),
    value: valid ? (value as AssistantDelegationRequest) : undefined,
  };
}

function createRequestId() {
  return `assistant-delegation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getAssistantDelegationRequestPath(requestId: string) {
  return pathResolver.sharedTmp(`delegation-requests/${requestId}.json`);
}

export function getAssistantDelegationResultPath(requestId: string) {
  return pathResolver.sharedTmp(`delegation-results/${requestId}.json`);
}

export function buildAssistantDelegationRequest(input: CreateAssistantDelegationRequestInput): AssistantDelegationRequest {
  const requestId = createRequestId();
  const request: AssistantDelegationRequest = {
    kind: 'assistant-delegation-request',
    request_id: requestId,
    created_at: new Date().toISOString(),
    source: input.source,
    goal: input.intentContract.goal.summary,
    source_text: input.sourceText,
    context: {
      locale: input.locale,
      tier: input.tier || 'confidential',
      project_id: input.projectId,
      project_name: input.projectName,
      track_id: input.trackId,
      track_name: input.trackName,
      service_bindings: input.serviceBindings || [],
    },
    intent_contract: input.intentContract,
    work_loop: input.workLoop,
    clarification_packet: input.clarificationPacket,
    delegation: {
      mode: input.mode || 'plan_only',
      preferred_provider: input.preferredProvider,
      preferred_model: input.preferredModel,
      preferred_model_provider: input.preferredModelProvider,
      allowed_providers: input.allowedProviders && input.allowedProviders.length > 0 ? input.allowedProviders : ['codex', 'gemini', 'claude'],
    },
    expected_output: {
      contract: input.expectedOutputContract || 'planning_packet',
      write_back_path: getAssistantDelegationResultPath(requestId),
    },
  };

  const validation = validateAssistantDelegationRequest(request);
  if (!validation.valid) {
    throw new Error(`Invalid assistant delegation request: ${validation.errors.join('; ')}`);
  }
  return request;
}

export function writeAssistantDelegationRequest(request: AssistantDelegationRequest): string {
  const validation = validateAssistantDelegationRequest(request);
  if (!validation.valid) {
    throw new Error(`Invalid assistant delegation request: ${validation.errors.join('; ')}`);
  }
  const requestPath = getAssistantDelegationRequestPath(request.request_id);
  safeWriteFile(requestPath, JSON.stringify(request, null, 2));
  return requestPath;
}

export function createAssistantDelegationRequest(input: CreateAssistantDelegationRequestInput): { request: AssistantDelegationRequest; requestPath: string } {
  const request = buildAssistantDelegationRequest(input);
  const requestPath = writeAssistantDelegationRequest(request);
  return { request, requestPath };
}
