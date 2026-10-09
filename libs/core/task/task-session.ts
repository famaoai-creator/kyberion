import type { ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { loadSurfaceManifest, loadSurfaceState } from '../surface/surface-runtime.js';
import { loadServicePidRegistryAtPath } from '../service/service-pid-registry.js';
import { logger } from '../core.js';
import { compileSchema } from '../foundation/ajv.js';
import { nowIso } from '../foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import {
  buildOrganizationWorkLoopSummary,
  type OrganizationWorkLoopSummary,
} from '../workforce/work-design.js';
import {
  loadResolvedStandardIntentCatalog,
  resolveIntentResolutionPacket,
  type IntentResolutionOptions,
  type IntentResolutionPacket,
} from '../intent/intent-resolution.js';
import { resolveAnalysisExecutionContract } from '../analysis/analysis-contract.js';
import { resolveApprovalPolicy } from '../governance/approval-policy.js';
import {
  createOutcomeContract,
  inferTaskSessionOutcomeContract,
  validateOutcomeContractAtCompletion,
  type OutcomeContract,
} from '../outcome-contract.js';
import { buildCompletionNextAction, type CompletionNextAction } from '../next-action.js';
import { recordIntentContractOutcome } from '../intent/intent-contract-learning.js';
import { currentScope } from '../scope-context.js';
import { reconcileCompletionStructurally } from '../intent/intent-reconciliation.js';
import { matchesAnyTextRule, type TextMatchRule } from '../text-rule-matcher.js';
import { buildFallbackExecutionBrief, type ExecutionBriefSeed } from '../execution-brief.js';
import {
  findServiceByTopic,
  topicToServiceId,
  extractProviderFromUtterance,
  resolveProviderUrl,
} from '../external-service-registry.js';
import type { ActuatorExecutionBrief } from '../contracts/actuator-execution-brief.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';
import {
  findIntentPhrase,
  intentPhraseFlags,
  intentPhraseSource,
  matchesIntentPhrase,
} from '../intent/intent-phrase-lexicon.js';

export type TaskSessionSurface = string; // Replaces 'presence' | 'slack' | 'terminal' | 'chronos' | 'web' | 'imessage' | 'discord'

export type TaskSessionType =
  | 'browser'
  | 'capture_photo'
  | 'workbook_wbs'
  | 'presentation_deck'
  | 'report_document'
  | 'service_operation'
  | 'meeting_operations'
  | 'external_data_fetch'
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
  type:
    | 'instruction'
    | 'ack'
    | 'plan'
    | 'execution'
    | 'verification'
    | 'feedback'
    | 'error'
    | 'control'
    | 'artifact';
  text: string;
}

export interface TaskSession {
  session_id: string;
  correlation_id?: string;
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
    tenant_slug?: string;
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
    /** IL-05 Task 2: slot names in the order they were filled, so a
     * correction utterance can backtrack to the LAST FILLED slot instead of
     * re-asking the next empty one (which loses the correction target). */
    filled_order?: string[];
  };
  control: {
    interruptible: boolean;
    requires_approval: boolean;
    awaiting_user_input: boolean;
  };
  outcome_contract: OutcomeContract;
  completion_summary?: {
    requested_result: string;
    satisfied: boolean;
    delivered: string[];
    gaps: string[];
    next_step: string;
    confidence: number;
    evidence_refs: string[];
  };
  completion_next_action?: CompletionNextAction;
  history: TaskSessionHistoryEntry[];
  updated_at: string;
  payload?: Record<string, unknown>;
}

export interface TaskSessionIntent {
  taskType: TaskSessionType;
  intentId?: string;
  correlationId?: string;
  goal: TaskSession['goal'];
  projectContext?: TaskSession['project_context'];
  requirements?: TaskSession['requirements'];
  payload?: TaskSession['payload'];
  executionBrief?: ActuatorExecutionBrief;
}

interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

const TASK_SESSION_SCHEMA_PATH = pathResolver.knowledge('product/schemas/task-session.schema.json');
const TASK_SESSION_POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/task-session-policy.schema.json'
);
const TASK_SESSION_POLICY_PATH = pathResolver.knowledge(
  'product/governance/task-session-policy.json'
);
const SERVICE_PID_FILE = pathResolver.shared('services-pids.json');

function taskSessionCatalog(filePath: string) {
  return defineCatalog<TaskSession>({
    id: 'task-session',
    path: filePath,
    schema: TASK_SESSION_SCHEMA_PATH,
  });
}

let taskSessionValidateFn: ValidateFunction | null = null;
function ensureTaskSessionValidator(): ValidateFunction {
  if (taskSessionValidateFn) return taskSessionValidateFn;
  taskSessionValidateFn = compileSchema(TASK_SESSION_SCHEMA_PATH);
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

const taskSessionPolicyCatalog = defineCatalog<TaskSessionPolicyFile>({
  id: 'task-session-policy',
  path: TASK_SESSION_POLICY_PATH,
  schema: TASK_SESSION_POLICY_SCHEMA_PATH,
});

function loadTaskSessionPolicy(): TaskSessionPolicyFile {
  return taskSessionPolicyCatalog.load();
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function taskSessionDir(rootDir = pathResolver.rootDir()): string {
  return assertSafeRepositoryPath(
    pathResolver.vitestLivePath(path.resolve(rootDir, 'active/shared/runtime/task-sessions')),
    { allowMissingLeaf: true }
  );
}

export function taskSessionPath(sessionId: string, rootDir = pathResolver.rootDir()): string {
  const normalized = String(sessionId || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\0]/u.test(normalized)) {
    throw new Error('[TASK_SESSION_ID] session id must be a single path segment');
  }
  return assertSafeRepositoryPath(path.join(taskSessionDir(rootDir), `${normalized}.json`), {
    allowMissingLeaf: true,
  });
}

function collectTaskSessionEvidenceRefs(session: TaskSession): string[] {
  return [
    session.artifact?.output_path,
    session.artifact?.external_ref,
    session.artifact?.artifact_id ? `artifact:${session.artifact.artifact_id}` : undefined,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function collectTaskSessionEvidenceTexts(session: TaskSession): string[] {
  return [session.artifact?.preview_text]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function recordTaskSessionCompletionLearning(session: TaskSession): void {
  const intentId = String(session.payload?.intent_id || '').trim();
  if (!intentId || !session.completion_summary) return;

  try {
    recordIntentContractOutcome({
      intent_id: intentId,
      execution_shape: session.work_loop?.resolution.execution_shape || session.task_type,
      contract_ref: { kind: 'task_session_policy', ref: intentId },
      success: session.completion_summary.satisfied,
      ...(session.completion_summary.satisfied
        ? {}
        : { error: session.completion_summary.gaps.join('; ') || 'completion gap' }),
      context_fingerprint: {
        surface: session.surface,
        locale: session.project_context?.locale,
        execution_shape: session.work_loop?.resolution.execution_shape,
      },
      completion_summary: {
        satisfied: session.completion_summary.satisfied,
        delivered: [...session.completion_summary.delivered],
        gaps: [...session.completion_summary.gaps],
        next_step: session.completion_summary.next_step,
        confidence: session.completion_summary.confidence,
        evidence_refs: [...session.completion_summary.evidence_refs],
      },
      scope: currentScope(),
    });
  } catch (error) {
    logger.warn(
      `[task-session] intent-contract-memory sync skipped for ${session.session_id}: ${
        (error as Error)?.message || String(error)
      }`
    );
  }
}

function isRunningPid(pid: unknown): pid is number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadRunningServiceIds(): string[] {
  try {
    const safePidFile = assertSafeRepositoryPath(SERVICE_PID_FILE);
    const parsed = loadServicePidRegistryAtPath(safePidFile);
    if (!parsed) return [];
    return Object.entries(parsed)
      .filter(([, pid]) => isRunningPid(pid))
      .map(([serviceId]) => serviceId)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

type SurfaceStartableChoice = {
  service_name: string;
  surface_id: string;
  description?: string;
  kind?: string;
  startup_mode?: string;
  service_id?: string;
};

function loadSurfaceStateRunningIds(): Set<string> {
  try {
    const parsed = loadSurfaceState();
    return new Set(
      Object.entries(parsed.surfaces)
        .filter(([, record]) => isRunningPid(record.pid))
        .map(([surfaceId]) => surfaceId)
    );
  } catch {
    return new Set();
  }
}

function loadStartableServiceChoices(): SurfaceStartableChoice[] {
  const runningIds = loadSurfaceStateRunningIds();
  try {
    const manifest = loadSurfaceManifest();
    const choices = manifest.surfaces
      .filter((surface) => surface.enabled !== false)
      .map((surface) => {
        const serviceName = surface.id.trim();
        return {
          service_name: serviceName,
          surface_id: serviceName,
          description: surface.description,
          kind: surface.kind,
          startup_mode: surface.startupMode,
          service_id: surface.service_id,
        } satisfies SurfaceStartableChoice;
      })
      .filter(
        (choice) => choice.startup_mode === 'background' && !runningIds.has(choice.surface_id)
      );
    return choices.sort((left, right) => left.service_name.localeCompare(right.service_name));
  } catch {
    return [];
  }
}

function inferRequiresApproval(input: {
  requiresApproval?: boolean;
  requirements?: TaskSession['requirements'];
  payload?: TaskSession['payload'];
  workLoop?: OrganizationWorkLoopSummary;
}): boolean {
  // A policy-derived approval requirement is a safety floor. An explicit
  // false must not be able to bypass a dangerous intent's resolved policy.
  if (input.payload?.approval_required === true) return true;
  if (input.workLoop?.authority?.requires_approval === true) return true;
  if (input.requiresApproval === true) return true;
  if (
    Array.isArray(input.requirements?.missing) &&
    input.requirements.missing.some(
      (requirement) =>
        requirement === 'approval_confirmation' || requirement === 'dual_key_confirmation'
    )
  ) {
    return true;
  }
  if (input.requiresApproval === false) return false;
  return false;
}

function applyApprovalPolicy(
  intentId: string,
  payload: Record<string, unknown>,
  requirements: NonNullable<TaskSession['requirements']>,
  options: { includeMetadata?: boolean } = {}
): {
  payload: Record<string, unknown>;
  requirements: {
    missing: string[];
    collected: Record<string, unknown>;
  };
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
      ...(options.includeMetadata === false
        ? {}
        : {
            approval_required: policy.requiresApproval,
            approval_rule_id: policy.matchedRuleId,
          }),
    },
    requirements: nextRequirements,
  };
}

export function createTaskSession(input: {
  sessionId?: string;
  correlationId?: string;
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
  const now = nowIso();
  const correlationId = input.correlationId;
  const baseRequirements = input.requirements || { missing: [], collected: {} };
  const basePayload = input.intentId
    ? {
        ...(input.payload || {}),
        ...(input.intentId ? { intent_id: input.intentId } : {}),
      }
    : input.payload;
  const approvalPolicy = input.intentId
    ? resolveApprovalPolicy({ intentId: input.intentId, payload: basePayload || {} })
    : undefined;
  const approvalApplied = input.intentId
    ? applyApprovalPolicy(input.intentId, basePayload || {}, baseRequirements, {
        // Conditional task-session payload schemas intentionally reject
        // generic policy metadata. Keep the policy in control/requirements;
        // specialized builders may still opt into the metadata fields.
        includeMetadata: false,
      })
    : { payload: basePayload, requirements: baseRequirements };
  const requirements = approvalApplied.requirements;
  const payload = approvalApplied.payload;
  const requiresApproval = inferRequiresApproval({
    ...input,
    // Approval is monotone at this boundary: keep an explicit caller request
    // and a policy-required request. Policy requirements below also prevent
    // an explicit false from bypassing a dangerous intent.
    requiresApproval:
      input.requiresApproval === true || approvalPolicy?.requiresApproval === true
        ? true
        : input.requiresApproval,
    requirements,
    payload,
  });
  const workLoop =
    input.workLoop ||
    buildOrganizationWorkLoopSummary({
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
  const provisionalSessionId =
    input.sessionId ||
    `TSK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const outcomeContract =
    input.outcomeContract ||
    inferTaskSessionOutcomeContract({
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
    correlation_id: correlationId,
    surface: input.surface,
    task_type: input.taskType,
    status: input.status || 'awaiting_instruction',
    mode: input.mode || 'interactive',
    goal: input.goal,
    project_context: input.projectContext,
    work_loop: workLoop,
    requirements,
    control: {
      interruptible: true,
      requires_approval: requiresApproval,
      awaiting_user_input: Boolean(requirements?.missing?.length),
    },
    outcome_contract: normalizedOutcomeContract,
    history: [],
    updated_at: now,
    payload,
  };
}

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

function inferPolicyPayload(
  trimmed: string,
  policy: TaskSessionIntentPolicy
): Record<string, unknown> {
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
  const intent: TaskSessionIntent = {
    taskType: policy.task_type,
    intentId,
    goal: policy.goal,
    requirements: {
      missing: inferMissingRequirements(trimmed, policy),
      collected: {},
    },
    payload: inferPolicyPayload(trimmed, policy),
  };
  intent.executionBrief = buildFallbackExecutionBrief({
    requestText: trimmed,
    intentId,
    goalSummary: policy.goal.summary,
    taskType: policy.task_type,
    executionShape: 'task_session',
    requiredInputs: intent.requirements?.missing || [],
    outcomeIds: [],
    confidence: 0.72,
    summaryHint: policy.goal.summary,
  } satisfies ExecutionBriefSeed);
  return intent;
}

function derivePresentationThemeHint(deckPurpose?: unknown): string {
  switch (String(deckPurpose || 'proposal')) {
    case 'internal_share':
      return 'internal_practical';
    case 'briefing':
      return 'executive_clean';
    case 'marketing':
      return 'marketing_branded';
    case 'training':
    case 'comparison':
      return 'training_structured';
    default:
      return 'executive_clean';
  }
}

function deriveSlideCountHint(trimmed: string): number | undefined {
  const unitConcept = 'presentation.slide_count_unit';
  const slideCount = trimmed.match(
    new RegExp(`(\\d+)\\s*${intentPhraseSource(unitConcept)}`, intentPhraseFlags(unitConcept))
  );
  return slideCount ? Number(slideCount[1] || 0) : undefined;
}

type PhrasePolicyEntry<TValue extends string> = {
  phrase: string;
  value: TValue;
};

function resolvePhrasePolicyValue<TValue extends string>(
  trimmed: string,
  table: ReadonlyArray<PhrasePolicyEntry<TValue>>,
  defaultValue: TValue
): TValue {
  for (const entry of table) {
    if (matchesIntentPhrase(trimmed, entry.phrase)) return entry.value;
  }
  return defaultValue;
}

// Derived-hint policy tables (inferPolicyPayload rules/when/value shape:
// first match wins, otherwise the default). lifestyle-booking /
// schedule-coordination currently carry only static payload in
// knowledge/product/governance/task-session-policy.json, so the tables live
// here until policy rules exist for these hints.
const SCHEDULE_COORDINATION_MODE_TABLE: ReadonlyArray<PhrasePolicyEntry<string>> = [
  { phrase: 'schedule_coordination.mode_reschedule', value: 'reschedule' },
  { phrase: 'schedule_coordination.mode_adjust', value: 'adjust' },
];

const SCHEDULE_CALENDAR_HINT_TABLE: ReadonlyArray<PhrasePolicyEntry<string>> = [
  { phrase: 'calendar_source.outlook', value: 'outlook_calendar' },
  { phrase: 'calendar_source.google', value: 'google_calendar' },
];

function deriveScheduleCoordinationMode(trimmed: string): string {
  return resolvePhrasePolicyValue(trimmed, SCHEDULE_COORDINATION_MODE_TABLE, 'coordinate');
}

function isMeetingScheduleCoordination(trimmed: string): boolean {
  return (
    matchesIntentPhrase(trimmed, 'schedule_coordination.meeting_topic') &&
    matchesIntentPhrase(trimmed, 'coordination.schedule_request')
  );
}

function deriveScheduleCoordinationLeafIntent(trimmed: string): string | undefined {
  if (isMeetingScheduleCoordination(trimmed)) return 'meeting-operations';
  return undefined;
}

function deriveScheduleCalendarHint(trimmed: string): string {
  return resolvePhrasePolicyValue(trimmed, SCHEDULE_CALENDAR_HINT_TABLE, 'browser_calendar');
}

type BookingCategory =
  | 'hotel'
  | 'restaurant'
  | 'activity'
  | 'shopping'
  | 'medical'
  | 'subscription'
  | 'home_service'
  | 'family'
  | 'gifts'
  | 'package';

const BOOKING_CATEGORY_TABLE: ReadonlyArray<PhrasePolicyEntry<BookingCategory>> = [
  { phrase: 'booking_category.hotel', value: 'hotel' },
  { phrase: 'booking_category.restaurant', value: 'restaurant' },
  { phrase: 'booking_category.activity', value: 'activity' },
  { phrase: 'booking_category.shopping', value: 'shopping' },
  { phrase: 'booking_category.medical', value: 'medical' },
  { phrase: 'booking_category.subscription', value: 'subscription' },
  { phrase: 'booking_category.home_service', value: 'home_service' },
  { phrase: 'booking_category.family', value: 'family' },
  { phrase: 'booking_category.gifts', value: 'gifts' },
];

function deriveBookingCategory(trimmed: string): BookingCategory | 'default' {
  return resolvePhrasePolicyValue<BookingCategory | 'default'>(
    trimmed,
    BOOKING_CATEGORY_TABLE,
    'default'
  );
}

// ─── Dynamic Task Intent Registry ──────────────────────────────────────────────
export type TaskSessionIntentBuilder = (
  trimmed: string,
  resolvedPacket?: IntentResolutionPacket
) => TaskSessionIntent;

const taskIntentBuilderSeam = createSeam<TaskSessionIntentBuilder>({
  key: 'task-intent-builder',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/task/task-session.ts',
});

export function registerTaskIntentBuilder(
  intentId: string,
  builder: TaskSessionIntentBuilder,
  metadata: SeamProviderMetadata = {
    provenance: 'builtin',
    source: 'libs/core/task/task-session.ts',
  }
): () => void {
  return taskIntentBuilderSeam.register(intentId, builder, metadata);
}

export function getTaskIntentBuilder(intentId: string): TaskSessionIntentBuilder | undefined {
  return taskIntentBuilderSeam.getOptional(intentId);
}

// ─── Default Builders (Auto-registered) ──────────────────────────────────────

registerTaskIntentBuilder('bootstrap-project', (trimmed) =>
  buildPolicyBackedIntent('bootstrap-project', trimmed)
);
registerTaskIntentBuilder('capture-photo', (trimmed) =>
  buildPolicyBackedIntent('capture-photo', trimmed)
);
registerTaskIntentBuilder('generate-workbook', (trimmed) =>
  buildPolicyBackedIntent('generate-workbook', trimmed)
);
registerTaskIntentBuilder('generate-report', (trimmed) =>
  buildPolicyBackedIntent('generate-report', trimmed)
);
registerTaskIntentBuilder('cross-project-remediation', (trimmed) => {
  const base = buildPolicyBackedIntent('cross-project-remediation', trimmed);
  return {
    ...base,
    payload: {
      ...(base.payload || {}),
      analysis_contract_id: analysisContractId('cross-project-remediation'),
    },
  };
});
registerTaskIntentBuilder('incident-informed-review', (trimmed) => {
  const base = buildPolicyBackedIntent('incident-informed-review', trimmed);
  return {
    ...base,
    payload: {
      ...(base.payload || {}),
      analysis_contract_id: analysisContractId('incident-informed-review'),
    },
  };
});
registerTaskIntentBuilder('evolve-agent-harness', (trimmed) => {
  const base = buildPolicyBackedIntent('evolve-agent-harness', trimmed);
  return {
    ...base,
    payload: {
      ...(base.payload || {}),
      analysis_contract_id: analysisContractId('evolve-agent-harness'),
    },
  };
});
registerTaskIntentBuilder('inspect-service', (trimmed, resolvedPacket) => {
  const base = buildPolicyBackedIntent('inspect-service', trimmed);
  const serviceMatch = resolvedPacket?.selected_parameters?.service_name;
  const intent: TaskSessionIntent = {
    ...base,
    requirements: {
      missing: serviceMatch ? [] : ['service_name'],
      collected: {},
    },
    payload: {
      ...(base.payload || {}),
      service_name: serviceMatch,
      log_tail_lines: matchesIntentPhrase(trimmed, 'service.log_request') ? 100 : undefined,
    },
  };
  const approvalApplied = applyApprovalPolicy(
    intent.intentId!,
    intent.payload || {},
    intent.requirements!
  );
  return {
    ...intent,
    requirements: approvalApplied.requirements,
    payload: approvalApplied.payload,
  };
});
type ServiceLifecycleOperation = 'stop' | 'start' | 'restart';

const SERVICE_LIFECYCLE_CONFIGS: ReadonlyArray<{
  intentId: string;
  operation: ServiceLifecycleOperation;
}> = [
  { intentId: 'stop-service', operation: 'stop' },
  { intentId: 'start-service', operation: 'start' },
  { intentId: 'restart-service', operation: 'restart' },
];

function resolveServiceLifecycleChoicePayload(
  operation: ServiceLifecycleOperation
): Record<string, unknown> {
  if (operation === 'stop') {
    const activeServices = loadRunningServiceIds();
    return { active_services: activeServices, service_choices: activeServices };
  }
  if (operation === 'start') {
    const startableServices = loadStartableServiceChoices();
    return { startable_services: startableServices, service_choices: startableServices };
  }
  return {};
}

function applyServiceLifecycleApproval(intent: TaskSessionIntent): TaskSessionIntent {
  const approvalApplied = applyApprovalPolicy(
    intent.intentId!,
    intent.payload || {},
    intent.requirements!
  );
  if (!approvalApplied.requirements.missing.includes('approval_confirmation')) {
    approvalApplied.requirements.missing.push('approval_confirmation');
  }
  approvalApplied.payload = {
    ...approvalApplied.payload,
    approval_required: true,
  };
  return {
    ...intent,
    requirements: approvalApplied.requirements,
    payload: approvalApplied.payload,
  };
}

function buildServiceLifecycleIntent(
  intentId: string,
  operation: ServiceLifecycleOperation,
  trimmed: string,
  resolvedPacket?: IntentResolutionPacket
): TaskSessionIntent {
  const base = buildPolicyBackedIntent(intentId, trimmed);
  const serviceName = resolvedPacket?.selected_parameters?.service_name;
  const intent: TaskSessionIntent = {
    ...base,
    requirements: {
      missing: serviceName ? ['approval_confirmation'] : ['service_name', 'approval_confirmation'],
      collected: {},
    },
    payload: {
      ...(base.payload || {}),
      operation,
      service_name: serviceName,
      ...resolveServiceLifecycleChoicePayload(operation),
      approval_required: true,
    },
  };
  return applyServiceLifecycleApproval(intent);
}

for (const config of SERVICE_LIFECYCLE_CONFIGS) {
  registerTaskIntentBuilder(config.intentId, (trimmed, resolvedPacket) =>
    buildServiceLifecycleIntent(config.intentId, config.operation, trimmed, resolvedPacket)
  );
}
registerTaskIntentBuilder('generate-presentation', (trimmed) => {
  const base = buildPolicyBackedIntent('generate-presentation', trimmed);
  return {
    ...base,
    payload: {
      ...(base.payload || {}),
      slide_count_hint: deriveSlideCountHint(trimmed),
      theme_hint: derivePresentationThemeHint(base.payload?.deck_purpose),
    },
  };
});
registerTaskIntentBuilder('lifestyle-booking', (trimmed) => {
  const base = buildPolicyBackedIntent('lifestyle-booking', trimmed);
  return {
    ...base,
    payload: {
      ...(base.payload || {}),
      booking_category: deriveBookingCategory(trimmed),
    },
  };
});
registerTaskIntentBuilder('schedule-coordination', (trimmed) => {
  const base = buildPolicyBackedIntent('schedule-coordination', trimmed);
  return {
    ...base,
    payload: {
      ...(base.payload || {}),
      coordination_mode: deriveScheduleCoordinationMode(trimmed),
      calendar_surface_hint: deriveScheduleCalendarHint(trimmed),
      handoff_intent_id: deriveScheduleCoordinationLeafIntent(trimmed),
      handoff_reason: isMeetingScheduleCoordination(trimmed)
        ? 'Meeting schedule changes can be handed off to meeting-operations when role boundary or live meeting handling matters.'
        : undefined,
    },
  };
});

const APPROVAL_SYSTEM_PATTERN = /(Slack|Email|Mail|Teams|JXA)/i;
const APPROVAL_SCOPE_PATTERN = /(production|staging|sandbox|release|mutation)/i;

function extractApprovalChannelScope(trimmed: string): {
  system?: string;
  scope?: string;
} {
  const systemMatch = trimmed.match(APPROVAL_SYSTEM_PATTERN);
  const scopeMatch = trimmed.match(APPROVAL_SCOPE_PATTERN);
  return {
    ...(systemMatch?.[1] ? { system: systemMatch[1] } : {}),
    ...(scopeMatch?.[1] ? { scope: scopeMatch[1] } : {}),
  };
}

function approvalChannelScopePayload(system?: string, scope?: string): Record<string, unknown> {
  return {
    ...(system ? { approval_system: system, channel: system.toLowerCase() } : {}),
    ...(scope ? { approval_scope: scope } : {}),
  };
}

registerTaskIntentBuilder('resolve-approval', (trimmed) => {
  const base = buildPolicyBackedIntent('resolve-approval', trimmed);
  const decisionWord = findIntentPhrase(trimmed, 'approval.decision_word');
  let decision: 'approved' | 'rejected' | undefined = undefined;
  if (decisionWord) {
    const val = decisionWord.toLowerCase();
    if (matchesIntentPhrase(val, 'approval.decision_approve')) decision = 'approved';
    else if (matchesIntentPhrase(val, 'approval.decision_reject')) decision = 'rejected';
  }
  const idMatch =
    trimmed.match(/(?:REQ|req|id|ID|案件|番号)-?(\d+)/i) || trimmed.match(/([A-Z0-9]{8,10})/i);
  const requestId = idMatch ? idMatch[1] : undefined;
  const { system, scope } = extractApprovalChannelScope(trimmed);
  const missing = [
    !system ? 'approval_system' : null,
    !scope ? 'approval_scope' : null,
    !requestId ? 'requestId' : null,
    !decision ? 'decision' : null,
  ].filter((x): x is string => x !== null);

  const intent: TaskSessionIntent = {
    ...base,
    requirements: {
      missing,
      collected: {},
    },
    payload: {
      ...(base.payload || {}),
      ...approvalChannelScopePayload(system, scope),
      requestId,
      decision,
      requestedBy: 'operator',
      decidedBy: 'operator',
    },
  };
  return intent;
});

registerTaskIntentBuilder('request-approval', (trimmed) => {
  const base = buildPolicyBackedIntent('request-approval', trimmed);
  const { system, scope } = extractApprovalChannelScope(trimmed);
  const missing = [!system ? 'approval_system' : null, !scope ? 'approval_scope' : null].filter(
    (x): x is string => x !== null
  );

  const intent: TaskSessionIntent = {
    ...base,
    requirements: {
      missing,
      collected: {},
    },
    payload: {
      ...(base.payload || {}),
      ...approvalChannelScopePayload(system, scope),
      requestedBy: 'operator',
      draft: {
        title: 'Operator request',
        summary: trimmed,
        severity: 'medium',
      },
    },
  };
  return intent;
});

registerTaskIntentBuilder('setup-messaging-bridge', (trimmed) => {
  const base = buildPolicyBackedIntent('setup-messaging-bridge', trimmed);
  const platformMatch = trimmed.match(/(Slack|iMessage|Telegram|Teams)/i);
  const platformId = platformMatch ? platformMatch[1].toLowerCase() : 'slack';

  const intent: TaskSessionIntent = {
    ...base,
    requirements: {
      missing: [],
      collected: {},
    },
    payload: {
      ...(base.payload || {}),
      platform_id: platformId,
    },
  };
  return intent;
});

registerTaskIntentBuilder('fetch-external-data', (trimmed) => {
  const base = buildPolicyBackedIntent('fetch-external-data', trimmed);

  // 1. Extract data topic (weather, exchange rate, news, etc.)
  const topicMatch = trimmed.match(
    /(天気|weather|気温|温度|為替|レート|exchange\s*rate|ニュース|news|株価|stock)/i
  );
  const topicWord = topicMatch?.[1] ?? '';

  // 2. Extract location (station/city/district names)
  const locationMatch = trimmed.match(
    /(秋葉原|渋谷|新宿|池袋|品川|横浜|大阪|名古屋|札幌|東京|[^\s]{2,5}(?:市|区|町|村|駅))/
  );
  const location = locationMatch?.[1] ?? '';

  const dataTopic = [topicWord, location].filter(Boolean).join(' ');

  // 3. URL already in utterance — highest priority
  const urlInUtterance = trimmed.match(/https?:\/\/[^\s]+/)?.[0];
  if (urlInUtterance) {
    return {
      ...base,
      requirements: { missing: [], collected: {} },
      payload: {
        ...(base.payload ?? {}),
        ...(dataTopic ? { data_topic: dataTopic } : {}),
        source_url: urlInUtterance,
        ...(dataTopic ? { service_id_hint: topicToServiceId(dataTopic) } : {}),
      },
    };
  }

  // 4. Provider name in utterance (e.g. "Yahoo Japanで", "ヤフーで調べて")
  let providerResolved: { url: string; providerId: string } | undefined;
  try {
    const providerName = extractProviderFromUtterance(trimmed);
    if (providerName) {
      providerResolved = resolveProviderUrl(providerName, topicWord, location);
    }
  } catch (err: any) {
    logger.warn(`[TASK_SESSION] provider resolution skipped: ${err?.message || err}`);
  }

  if (providerResolved) {
    return {
      ...base,
      requirements: { missing: [], collected: {} },
      payload: {
        ...(base.payload ?? {}),
        ...(dataTopic ? { data_topic: dataTopic } : {}),
        source_url: providerResolved.url,
        provider_id: providerResolved.providerId,
        ...(dataTopic ? { service_id_hint: topicToServiceId(dataTopic) } : {}),
      },
    };
  }

  // 5. Registry lookup — previously registered service for this topic
  let knownEntry: ReturnType<typeof findServiceByTopic> | undefined;
  if (dataTopic) {
    try {
      knownEntry = findServiceByTopic(dataTopic);
    } catch {
      // Registry lookup failure must never block intent classification
    }
  }

  if (knownEntry) {
    return {
      ...base,
      requirements: { missing: [], collected: {} },
      payload: {
        ...(base.payload ?? {}),
        ...(dataTopic ? { data_topic: dataTopic } : {}),
        source_url: knownEntry.url,
        known_service_id: knownEntry.service_id,
        ...(dataTopic ? { service_id_hint: topicToServiceId(dataTopic) } : {}),
      },
    };
  }

  // 6. No source resolved — ask user for source_url
  return {
    ...base,
    requirements: { missing: ['source_url'], collected: {} },
    payload: {
      ...(base.payload ?? {}),
      ...(dataTopic ? { data_topic: dataTopic } : {}),
      ...(dataTopic ? { service_id_hint: topicToServiceId(dataTopic) } : {}),
    },
  };
});

export function classifyTaskSessionIntent(
  utterance: string,
  resolvedPacket?: IntentResolutionPacket,
  options: IntentResolutionOptions = {}
): TaskSessionIntent | null {
  const trimmed = utterance.trim();
  if (!trimmed) return null;
  const packet = resolvedPacket || resolveIntentResolutionPacket(trimmed, options);
  const intentId = packet.selected_intent_id;
  const builder = intentId ? getTaskIntentBuilder(intentId) : undefined;
  if (builder) return builder(trimmed, packet);
  if (!intentId) return null;

  const intent = loadResolvedStandardIntentCatalog(options).find((entry) => entry.id === intentId);
  if (intent?.resolution?.shape !== 'task_session') return null;
  try {
    const built = buildPolicyBackedIntent(intentId, trimmed);
    if (!built.executionBrief) {
      built.executionBrief = buildFallbackExecutionBrief({
        requestText: trimmed,
        intentId: built.intentId,
        goalSummary: built.goal.summary,
        taskType: built.taskType,
        executionShape: 'task_session',
        requiredInputs: built.requirements?.missing || [],
        outcomeIds: [],
        confidence: 0.65,
        summaryHint: built.goal.summary,
      } satisfies ExecutionBriefSeed);
    }
    return built;
  } catch {
    return null;
  }
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

export function saveTaskSession(session: TaskSession, options: { rootDir?: string } = {}): string {
  const rootDir = options.rootDir || pathResolver.rootDir();
  const directory = taskSessionDir(rootDir);
  const filePath = taskSessionPath(session.session_id, rootDir);
  if (session.status === 'completed') {
    const evidenceRefs = collectTaskSessionEvidenceRefs(session);
    const evidenceTexts = collectTaskSessionEvidenceTexts(session);
    const completionReconciliation = reconcileCompletionStructurally({
      goal: session.goal,
      evidenceRefs,
      artifactRefs: evidenceRefs,
      evidenceTexts,
      requestedResult: session.outcome_contract.requested_result,
    });
    if (!completionReconciliation.satisfied) {
      throw new Error(
        `Cannot complete task session: intent goal not satisfied (${completionReconciliation.gaps.join('; ') || 'no matching evidence'})`
      );
    }
    session.completion_next_action = buildCompletionNextAction({
      goal: session.goal,
      reconciliation: completionReconciliation,
    });
    session.completion_summary = {
      requested_result: session.outcome_contract.requested_result,
      satisfied: completionReconciliation.satisfied,
      delivered: completionReconciliation.delivered,
      gaps: completionReconciliation.gaps,
      next_step: session.completion_next_action.next_step,
      confidence: completionReconciliation.confidence,
      evidence_refs: completionReconciliation.evidence_refs || [],
    };
    const completionValidation = validateOutcomeContractAtCompletion(session.outcome_contract, {
      artifactRefs: evidenceRefs,
    });
    if (!completionValidation.ok) {
      throw new Error(`Cannot complete task session: ${completionValidation.reason}`);
    }
  }
  let canonicalSession: TaskSession;
  try {
    canonicalSession = taskSessionCatalog(filePath).validate(session, filePath);
  } catch (error) {
    throw new Error(
      `Invalid task session: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const result = validateTaskSession(canonicalSession);
  if (!result.valid) {
    throw new Error(`Invalid task session: ${result.errors.join('; ')}`);
  }
  if (!safeExistsSync(directory)) safeMkdir(directory, { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(canonicalSession, null, 2)}\n`);
  if (canonicalSession.status === 'completed') {
    recordTaskSessionCompletionLearning(canonicalSession);
  }
  return filePath;
}

export function loadTaskSession(
  sessionId: string,
  options: { rootDir?: string } = {}
): TaskSession | null {
  let filePath: string;
  try {
    filePath = taskSessionPath(sessionId, options.rootDir || pathResolver.rootDir());
    if (!safeExistsSync(filePath)) return null;
  } catch {
    return null;
  }
  let parsed: TaskSession;
  try {
    assertSafeRepositoryPath(filePath);
    parsed = taskSessionCatalog(filePath).load();
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    logger.warn(
      `[TASK_SESSION] Invalid session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
  const result = validateTaskSession(parsed);
  if (!result.valid) {
    logger.warn(`[TASK_SESSION] Invalid session ${sessionId}: ${result.errors.join('; ')}`);
    return null;
  }
  return parsed;
}

export function listTaskSessions(
  surface?: TaskSessionSurface,
  options: { rootDir?: string } = {}
): TaskSession[] {
  const directory = taskSessionDir(options.rootDir || pathResolver.rootDir());
  if (!safeExistsSync(directory)) return [];
  return safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadTaskSession(entry.replace(/\.json$/, ''), options))
    .filter((session): session is TaskSession => Boolean(session))
    .filter((session) => (surface ? session.surface === surface : true))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getActiveTaskSession(
  surface?: TaskSessionSurface,
  options: { rootDir?: string } = {}
): TaskSession | null {
  return (
    listTaskSessions(surface, options).find(
      (session) => !['completed', 'failed', 'released'].includes(session.status)
    ) || null
  );
}

export function getLatestCompletedTaskSession(
  surface?: TaskSessionSurface,
  correlationId?: string,
  options: { rootDir?: string } = {}
): TaskSession | null {
  return (
    listTaskSessions(surface, options).find((session) => {
      if (session.status !== 'completed') return false;
      if (!correlationId) return true;
      return session.correlation_id === correlationId;
    }) || null
  );
}

export function reopenTaskSession(
  sessionId: string,
  input: {
    reason: string;
    status?: Exclude<TaskSessionStatus, 'completed' | 'failed' | 'released'>;
    payload?: Record<string, unknown>;
    requirements?: TaskSession['requirements'];
  }
): TaskSession | null {
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  const reopened = updateTaskSession(sessionId, {
    status:
      input.status ||
      (session.requirements?.missing?.length ? 'collecting_requirements' : 'planning'),
    requirements: input.requirements || session.requirements,
    payload: {
      ...(session.payload || {}),
      ...(input.payload || {}),
      reopened_from_session_id: session.session_id,
      reopened_at: nowIso(),
      reopen_reason: input.reason,
    },
  });
  if (!reopened) return null;
  recordTaskSessionHistory(sessionId, {
    ts: nowIso(),
    type: 'control',
    text: `Session reopened: ${input.reason}`,
  });
  return loadTaskSession(sessionId);
}

export function updateTaskSession(
  sessionId: string,
  patch: Partial<TaskSession>
): TaskSession | null {
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  const next: TaskSession = {
    ...session,
    ...patch,
    session_id: session.session_id,
    updated_at: nowIso(),
  };
  saveTaskSession(next);
  return next;
}

export function recordTaskSessionHistory(
  sessionId: string,
  entry: TaskSessionHistoryEntry
): TaskSession | null {
  const session = loadTaskSession(sessionId);
  if (!session) return null;
  session.history = [...session.history, entry].slice(-50);
  session.updated_at = nowIso();
  saveTaskSession(session);
  return session;
}
