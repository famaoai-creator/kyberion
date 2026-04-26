import AjvModule, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { logger } from './core.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import { buildOrganizationWorkLoopSummary, type OrganizationWorkLoopSummary } from './work-design.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import { resolveAnalysisExecutionContract } from './analysis-contract.js';
import { resolveApprovalPolicy } from './approval-policy.js';
import {
  createOutcomeContract,
  inferTaskSessionOutcomeContract,
  validateOutcomeContractAtCompletion,
  type OutcomeContract,
} from './outcome-contract.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';

export type TaskSessionSurface = 'presence' | 'slack' | 'terminal' | 'chronos' | 'web';
export type TaskSessionType =
  | 'browser'
  | 'capture_photo'
  | 'workbook_wbs'
  | 'presentation_deck'
  | 'report_document'
  | 'service_operation'
  | 'document_generation'
  | 'analysis';
export type TaskSessionStatus =
  | 'awaiting_instruction'
  | 'collecting_requirements'
  | 'planning'
  | 'awaiting_confirmation'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'paused'
  | 'released';
export type TaskSessionMode = 'interactive' | 'delegated' | 'shadow';

export interface TaskSessionHistoryEntry {
  ts: string;
  type: 'instruction' | 'ack' | 'plan' | 'execution' | 'verification' | 'feedback' | 'error' | 'control' | 'artifact';
  text: string;
}

export interface TaskSession {
  session_id: string;
  surface: TaskSessionSurface;
  task_type: TaskSessionType;
  status: TaskSessionStatus;
  mode: TaskSessionMode;
  goal: {
    summary: string;
    success_condition: string;
  };
  project_context?: {
    project_id?: string;
    project_name?: string;
    track_id?: string;
    track_name?: string;
    tier?: 'personal' | 'confidential' | 'public';
    service_bindings?: string[];
    locale?: string;
  };
  work_loop?: OrganizationWorkLoopSummary;
  artifact?: {
    kind?: string;
    output_path?: string;
    preview_text?: string;
    [key: string]: unknown;
  };
  requirements?: {
    missing?: string[];
    collected?: Record<string, unknown>;
  };
  control: {
    interruptible: boolean;
    requires_approval: boolean;
    awaiting_user_input: boolean;
  };
  outcome_contract: OutcomeContract;
  history: TaskSessionHistoryEntry[];
  updated_at: string;
  payload?: Record<string, unknown>;
}

export interface TaskSessionIntent {
  taskType: TaskSessionType;
  intentId?: string;
  goal: TaskSession['goal'];
  projectContext?: TaskSession['project_context'];
  requirements?: TaskSession['requirements'];
  payload?: TaskSession['payload'];
}

interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const TASK_SESSION_SCHEMA_PATH = pathResolver.knowledge('public/schemas/task-session.schema.json');
const TASK_SESSION_POLICY_SCHEMA_PATH = pathResolver.knowledge('public/schemas/task-session-policy.schema.json');
const TASK_SESSION_POLICY_PATH = pathResolver.knowledge('public/governance/task-session-policy.json');
const TASK_SESSION_DIR = pathResolver.shared('runtime/task-sessions');

let taskSessionValidateFn: ValidateFunction | null = null;
let taskSessionPolicyValidateFn: ValidateFunction | null = null;
function ensureTaskSessionValidator(): ValidateFunction {
  if (taskSessionValidateFn) return taskSessionValidateFn;
  taskSessionValidateFn = compileSchemaFromPath(ajv, TASK_SESSION_SCHEMA_PATH);
  return taskSessionValidateFn;
}

type PolicyScalar = string | number | boolean;
type RequirementRule = {
  requirement: string;
  omit_when?: Array<TextMatchRule | string>;
};
type PayloadFieldRule = {
  field: string;
  default?: PolicyScalar;
  rules?: Array<{ when: Array<TextMatchRule | string>; value: PolicyScalar }>;
};
type TaskSessionIntentPolicy = {
  id: string;
  task_type: TaskSessionType;
  goal: TaskSession['goal'];
  requirements?: {
    default_missing?: string[];
    rules?: RequirementRule[];
  };
  payload?: {
    static?: Record<string, PolicyScalar>;
    fields?: PayloadFieldRule[];
  };
};
type TaskSessionPolicyFile = {
  version: string;
  intents: TaskSessionIntentPolicy[];
};

function ensureTaskSessionPolicyValidator(): ValidateFunction {
  if (taskSessionPolicyValidateFn) return taskSessionPolicyValidateFn;
  taskSessionPolicyValidateFn = compileSchemaFromPath(ajv, TASK_SESSION_POLICY_SCHEMA_PATH);
  return taskSessionPolicyValidateFn;
}

function loadTaskSessionPolicy(): TaskSessionPolicyFile {
  const value = JSON.parse(safeReadFile(TASK_SESSION_POLICY_PATH, { encoding: 'utf8' }) as string) as TaskSessionPolicyFile;
  const validate = ensureTaskSessionPolicyValidator();
  if (!validate(value)) {
    throw new Error(`Invalid task-session-policy: ${errorsFrom(validate).join('; ')}`);
  }
  return value;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim());
}

function taskSessionPath(sessionId: string): string {
  return `${TASK_SESSION_DIR}/${sessionId}.json`;
}

function inferRequiresApproval(input: {
  requiresApproval?: boolean;
  requirements?: TaskSession['requirements'];
  payload?: TaskSession['payload'];
  workLoop?: OrganizationWorkLoopSummary;
}): boolean {
  if (typeof input.requiresApproval === 'boolean') return input.requiresApproval;
  if (input.workLoop?.authority?.requires_approval === true) return true;
  if (input.payload?.approval_required === true) return true;
  return Array.isArray(input.requirements?.missing) && input.requirements.missing.includes('approval_confirmation');
}

function applyApprovalPolicy(intentId: string, payload: Record<string, unknown>, requirements: TaskSession['requirements']): {
  payload: Record<string, unknown>;
  requirements: TaskSession['requirements'];
} {
  const policy = resolveApprovalPolicy({ intentId, payload });
  const nextRequirements = {
    missing: [...(requirements.missing || [])],
    collected: { ...(requirements.collected || {}) },
  };
  for (const requirement of policy.missingRequirements) {
    if (!nextRequirements.missing.includes(requirement)) nextRequirements.missing.push(requirement);
  }
  return {
    payload: {
      ...payload,
      approval_required: policy.requiresApproval,
      approval_rule_id: policy.matchedRuleId,
    },
    requirements: nextRequirements,
  };
}

export function createTaskSession(input: {
  sessionId?: string;
  surface: TaskSessionSurface;
  taskType: TaskSessionType;
  status?: TaskSessionStatus;
  mode?: TaskSessionMode;
  requiresApproval?: boolean;
  goal: TaskSession['goal'];
  projectContext?: TaskSession['project_context'];
  intentId?: string;
  shape?: 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
  outcomeIds?: string[];
  requirements?: TaskSession['requirements'];
  payload?: TaskSession['payload'];
  workLoop?: OrganizationWorkLoopSummary;
  outcomeContract?: OutcomeContract;
}): TaskSession {
  const now = new Date().toISOString();
  const requiresApproval = inferRequiresApproval(input);
  const workLoop = input.workLoop || buildOrganizationWorkLoopSummary({
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape,
    outcomeIds: input.outcomeIds,
    projectId: input.projectContext?.project_id,
    projectName: input.projectContext?.project_name,
    trackId: input.projectContext?.track_id,
    trackName: input.projectContext?.track_name,
    tier: input.projectContext?.tier,
    locale: input.projectContext?.locale,
    serviceBindings: input.projectContext?.service_bindings,
    requiresApproval,
  });
  const provisionalSessionId = input.sessionId || `TSK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const outcomeContract = input.outcomeContract || inferTaskSessionOutcomeContract({
    sessionId: provisionalSessionId,
    goal: input.goal,
    taskType: input.taskType,
  });
  const normalizedOutcomeContract = createOutcomeContract({
    ...outcomeContract,
    outcomeId: outcomeContract.outcome_id,
    requestedResult: outcomeContract.requested_result,
    deliverableKind: outcomeContract.deliverable_kind,
    successCriteria: outcomeContract.success_criteria,
    evidenceRequired: outcomeContract.evidence_required,
    expectedArtifacts: outcomeContract.expected_artifacts,
    verificationMethod: outcomeContract.verification_method,
  });

  return {
    session_id: provisionalSessionId,
    surface: input.surface,
    task_type: input.taskType,
    status: input.status || 'awaiting_instruction',
    mode: input.mode || 'interactive',
    goal: input.goal,
    project_context: input.projectContext,
    work_loop: workLoop,
    requirements: input.requirements,
    control: {
      interruptible: true,
      requires_approval: requiresApproval,
      awaiting_user_input: Boolean(input.requirements?.missing?.length),
    },
    outcome_contract: normalizedOutcomeContract,
    history: [],
    updated_at: now,
    payload: input.payload,
  };
}

type TaskSessionIntentBuilder = (trimmed: string) => TaskSessionIntent;

function analysisContractId(intentId: string): string | undefined {
  return resolveAnalysisExecutionContract(intentId)?.contract_id;
}

function findTaskSessionIntentPolicy(intentId: string): TaskSessionIntentPolicy {
  const policy = loadTaskSessionPolicy().intents.find((entry) => entry.id === intentId);
  if (!policy) throw new Error(`Missing task-session policy for intent: ${intentId}`);
  return policy;
}

function inferMissingRequirements(trimmed: string, policy: TaskSessionIntentPolicy): string[] {
  const missing = [...(policy.requirements?.default_missing || [])];
  for (const rule of policy.requirements?.rules || []) {
    if (!rule.omit_when?.length || !matchesAnyTextRule(trimmed, rule.omit_when)) {
      if (!missing.includes(rule.requirement)) missing.push(rule.requirement);
    }
  }
  return missing;
}

function inferPolicyPayload(trimmed: string, policy: TaskSessionIntentPolicy): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...(policy.payload?.static || {}) };
  for (const field of policy.payload?.fields || []) {
    let value: PolicyScalar | undefined = field.default;
    for (const rule of field.rules || []) {
      if (matchesAnyTextRule(trimmed, rule.when)) {
        value = rule.value;
        break;
      }
    }
    if (value !== undefined) payload[field.field] = value;
  }
  return payload;
}

function buildPolicyBackedIntent(intentId: string, trimmed: string): TaskSessionIntent {
  const policy = findTaskSessionIntentPolicy(intentId);
  return {
    taskType: policy.task_type,
    intentId,
    goal: policy.goal,
    requirements: {
      missing: inferMissingRequirements(trimmed, policy),
      collected: {},
    },
    payload: inferPolicyPayload(trimmed, policy),
  };
}

// Intent resolution decides "what the user means".
// Task-session builders decide "which runtime bindings and missing inputs are needed".
const TASK_SESSION_INTENT_BUILDERS: Record<string, TaskSessionIntentBuilder> = {
  'bootstrap-project': (trimmed) => buildPolicyBackedIntent('bootstrap-project', trimmed),
  'capture-photo': (trimmed) => buildPolicyBackedIntent('capture-photo', trimmed),
  'generate-workbook': (trimmed) => buildPolicyBackedIntent('generate-workbook', trimmed),
  'generate-presentation': (trimmed) => {
    const base = buildPolicyBackedIntent('generate-presentation', trimmed);
    return {
      ...base,
      payload: {
        ...(base.payload || {}),
        slide_count_hint: /(\d+)\s*(枚|slides?)/i.test(trimmed)
          ? Number(trimmed.match(/(\d+)\s*(枚|slides?)/i)?.[1] || 0)
          : undefined,
      },
    };
  },
  'generate-report': (trimmed) => buildPolicyBackedIntent('generate-report', trimmed),
  'cross-project-remediation': (trimmed) => {
    const base = buildPolicyBackedIntent('cross-project-remediation', trimmed);
    return {
      ...base,
      payload: {
        ...(base.payload || {}),
        analysis_contract_id: analysisContractId('cross-project-remediation'),
      },
    };
  },
  'incident-informed-review': (trimmed) => {
    const base = buildPolicyBackedIntent('incident-informed-review', trimmed);
    return {
      ...base,
      payload: {
        ...(base.payload || {}),
        analysis_contract_id: analysisContractId('incident-informed-review'),
      },
    };
  },
  'evolve-agent-harness': (trimmed) => {
    const base = buildPolicyBackedIntent('evolve-agent-harness', trimmed);
    return {
      ...base,
      payload: {
        ...(base.payload || {}),
        analysis_contract_id: analysisContractId('evolve-agent-harness'),
      },
    };
  },
  'inspect-service': (trimmed) => {
    const base = buildPolicyBackedIntent('inspect-service', trimmed);
    const serviceMatch =
      trimmed.match(/([A-Za-z0-9._-]+)\s*(?:の|を)?\s*(再起動|restart|起動|停止|status|状態|ログ)/i) ||
      trimmed.match(/service\s+([A-Za-z0-9._-]+)/i);
    const intent: TaskSessionIntent = {
      ...base,
      requirements: {
        missing: serviceMatch ? [] : ['service_name'],
        collected: {},
      },
      payload: {
        ...(base.payload || {}),
        service_name: serviceMatch?.[1],
        log_tail_lines: /ログ|logs?/i.test(trimmed) ? 100 : undefined,
      },
    };
    const approvalApplied = applyApprovalPolicy(intent.intentId!, intent.payload || {}, intent.requirements!);
    return {
      ...intent,
      requirements: approvalApplied.requirements,
      payload: approvalApplied.payload,
    };
  },
};

export function classifyTaskSessionIntent(utterance: string): TaskSessionIntent | null {
  const trimmed = utterance.trim();
  if (!trimmed) return null;
  const packet = resolveIntentResolutionPacket(trimmed);
  const builder = packet.selected_intent_id ? TASK_SESSION_INTENT_BUILDERS[packet.selected_intent_id] : undefined;
  return builder ? builder(trimmed) : null;
}

export function validateTaskSession(session: unknown): ValidationResult<TaskSession> {
  const validate = ensureTaskSessionValidator();
  const valid = validate(session);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (session as TaskSession) : undefined,
  };
}

export function saveTaskSession(session: TaskSession): string {
  if (session.status === 'completed') {
    const completionValidation = validateOutcomeContractAtCompletion(session.outcome_contract, {
      artifactRefs: [
        String(session.artifact?.artifact_id || ''),
        String(session.artifact?.output_path || ''),
        String(session.artifact?.external_ref || ''),
      ],
    });
    if (!completionValidation.ok) {
      throw new Error(`Cannot complete task session: ${completionValidation.reason}`);
    }
  }
  const result = validateTaskSession(session);
  if (!result.valid) {
    throw new Error(`Invalid task session: ${result.errors.join('; ')}`);
  }
  if (!safeExistsSync(TASK_SESSION_DIR)) safeMkdir(TASK_SESSION_DIR, { recursive: true });
  const filePath = taskSessionPath(session.session_id);
  safeWriteFile(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

export function loadTaskSession(sessionId: string): TaskSession | null {
  const filePath = taskSessionPath(sessionId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as TaskSession;
  const result = validateTaskSession(parsed);
  if (!result.valid) {
    logger.warn(`[TASK_SESSION] Invalid session ${sessionId}: ${result.errors.join('; ')}`);
    return null;
  }
  return parsed;
}

export function listTaskSessions(surface?: TaskSessionSurface): TaskSession[] {
  if (!safeExistsSync(TASK_SESSION_DIR)) return [];
  return safeReaddir(TASK_SESSION_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadTaskSession(entry.replace(/\.json$/, '')))
    .filter((session): session is TaskSession => Boolean(session))
    .filter((session) => (surface ? session.surface === surface : true))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getActiveTaskSession(surface?: TaskSessionSurface): TaskSession | null {
  return listTaskSessions(surface).find((session) =>
    !['completed', 'failed', 'released'].includes(session.status),
  ) || null;
}

export function updateTaskSession(
  sessionId: string,
  patch: Partial<TaskSession>,
): TaskSession | null {
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  const next: TaskSession = {
    ...session,
    ...patch,
    session_id: session.session_id,
    updated_at: new Date().toISOString(),
  };
  saveTaskSession(next);
  return next;
}

export function recordTaskSessionHistory(sessionId: string, entry: TaskSessionHistoryEntry): TaskSession | null {
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  session.history = [...session.history, entry].slice(-50);
  session.updated_at = new Date().toISOString();
  saveTaskSession(session);
  return session;
}
