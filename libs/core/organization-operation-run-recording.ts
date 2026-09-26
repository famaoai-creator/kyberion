import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { nowIso } from './foundation/time.js';
import {
  assertOrganizationId,
  OrganizationRecordExistsError,
  validateOrganizationOperationRun,
  validationErrors,
  validatorFor,
} from './organization-operating-model-persistence.js';
import {
  listOrganizationOperationRuns,
  loadOrganizationOperation,
  loadOrganizationOperationState,
  saveOrganizationOperationRun,
  saveOrganizationOperationState,
} from './organization-operating-model-operations.js';
import { organizationOperationDueProjection } from './organization-operation-runtime.js';
import type {
  OrganizationOperationRecord,
  OrganizationOperationRun,
  OrganizationOperationState,
  OrganizationTier,
} from './organization-operating-model.js';

export function assertScopedOperationRunRef(
  ref: string,
  operation: OrganizationOperationRecord,
  label: string,
  rootDir?: string
): void {
  const tenant = operation.tenant_slug;
  const scopeRoots =
    operation.tier === 'confidential' && tenant
      ? [
          `knowledge/confidential/${tenant}/`,
          'knowledge/confidential/shared/',
          'knowledge/product/',
          'active/shared/',
          `active/missions/confidential/${tenant}/`,
          `active/projects/confidential/${tenant}/`,
          `active/organizations/confidential/${tenant}/`,
        ]
      : operation.tier === 'public'
        ? [
            'knowledge/public/',
            'knowledge/product/',
            'active/shared/',
            'active/missions/public/',
            'active/projects/public/',
            'active/organizations/public/',
          ]
        : tenant
          ? [
              `knowledge/personal/${tenant}/`,
              'knowledge/product/',
              'active/shared/',
              `active/missions/personal/${tenant}/`,
              `active/projects/personal/${tenant}/`,
              `active/organizations/personal/${tenant}/`,
            ]
          : ['knowledge/product/'];
  if (
    ref.includes('\\') ||
    ref.split('/').includes('..') ||
    !scopeRoots.some((prefix) => ref.startsWith(prefix)) ||
    !safeExistsSync(rootDir ? path.resolve(rootDir, ref) : pathResolver.rootResolve(ref))
  ) {
    throw new Error(`${label} must be an existing path within the operation scope: ${ref}`);
  }
}

export type OrganizationOperationRunOutcome = Exclude<
  OrganizationOperationRun['status'],
  'started'
>;

export interface RecordOrganizationOperationRunInput {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  operationId: string;
  runId: string;
  runStatus: OrganizationOperationRunOutcome;
  resultSummary: string;
  evidenceRefs?: string[];
  exceptionRefs?: string[];
  executionRef?: string;
  startedAt?: string;
  completedAt?: string;
  /**
   * The run id was defaulted (`defaultOperationRunId`): on a collision —
   * already recorded, or created concurrently — take the next `-N` suffix
   * instead of failing.
   */
  autoSuffixRunId?: boolean;
  /** false builds and validates the records without saving them. */
  apply: boolean;
  rootDir?: string;
}

export interface RecordOrganizationOperationRunResult {
  run: OrganizationOperationRun;
  state: OrganizationOperationState;
  saved_paths: string[];
}

/** Validate and (optionally) persist one completed run and the operation's projected state. */
export function recordOrganizationOperationRun(
  input: RecordOrganizationOperationRunInput
): RecordOrganizationOperationRunResult {
  const scope = {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  };
  try {
    assertOrganizationId(input.runId);
  } catch {
    throw new Error(`Invalid run_id '${input.runId}'.`);
  }
  const operation = loadOrganizationOperation(input.operationId, scope);
  if (!operation || operation.status !== 'active') {
    throw new Error(`Active organization operation not found: ${input.operationId}`);
  }
  if (!['succeeded', 'failed', 'blocked', 'cancelled'].includes(input.runStatus)) {
    throw new Error(`Invalid run status: ${input.runStatus}`);
  }
  const evidenceRefs = input.evidenceRefs || [];
  const exceptionRefs = input.exceptionRefs || [];
  if (input.runStatus === 'succeeded' && evidenceRefs.length === 0) {
    throw new Error('A succeeded operation run requires an evidence ref.');
  }
  const takenRunIds = new Set(listOrganizationOperationRuns(scope).map((run) => run.run_id));
  let runId = input.runId;
  if (takenRunIds.has(runId)) {
    if (!input.autoSuffixRunId) throw new Error(`Operation run already exists: ${runId}`);
    runId = nextFreeOperationRunId(runId, takenRunIds);
  }
  for (const ref of evidenceRefs)
    assertScopedOperationRunRef(ref, operation, 'Operation evidence ref', input.rootDir);
  for (const ref of exceptionRefs)
    assertScopedOperationRunRef(ref, operation, 'Operation exception ref', input.rootDir);
  if (input.executionRef)
    assertScopedOperationRunRef(
      input.executionRef,
      operation,
      'Operation execution ref',
      input.rootDir
    );
  const now = nowIso();
  const startedAt = input.startedAt || now;
  const completedAt = input.completedAt || now;
  if (
    !Number.isFinite(Date.parse(startedAt)) ||
    !Number.isFinite(Date.parse(completedAt)) ||
    Date.parse(startedAt) > Date.parse(completedAt) ||
    Date.parse(completedAt) > Date.parse(now)
  ) {
    throw new Error('Run timestamps must be valid, ordered, and no later than now.');
  }
  const currentState = loadOrganizationOperationState(operation.operation_id, scope);
  if (currentState?.last_run_at && Date.parse(completedAt) < Date.parse(currentState.last_run_at)) {
    throw new Error(
      `Operation run is older than the current projection (${currentState.last_run_at}); record it separately without replacing the latest state.`
    );
  }
  const run: OrganizationOperationRun = {
    run_id: runId,
    operation_id: operation.operation_id,
    organization_id: input.organizationId,
    tier: operation.tier,
    ...(operation.tenant_slug ? { tenant_slug: operation.tenant_slug } : {}),
    status: input.runStatus,
    started_at: startedAt,
    completed_at: completedAt,
    ...(input.executionRef ? { execution_ref: input.executionRef } : {}),
    result_summary: input.resultSummary,
    evidence_refs: evidenceRefs,
    exception_refs: exceptionRefs,
    recorded_at: now,
  };
  const state: OrganizationOperationState = {
    operation_id: operation.operation_id,
    organization_id: input.organizationId,
    tier: operation.tier,
    ...(operation.tenant_slug ? { tenant_slug: operation.tenant_slug } : {}),
    status: input.runStatus === 'cancelled' ? 'paused' : input.runStatus,
    ...organizationOperationDueProjection(operation, {
      last_run_at: completedAt,
    } as OrganizationOperationState),
    last_run_at: completedAt,
    last_result_summary: input.resultSummary,
    last_evidence_refs: evidenceRefs,
    exception_refs: exceptionRefs,
    updated_at: now,
  };
  // Validate before the apply branch so a dry run reports what apply would reject.
  if (!validateOrganizationOperationRun(run)) {
    throw new Error(
      `Invalid organization operation run: ${validationErrors(validatorFor(OPERATION_RUN_SCHEMA_PATH))}`
    );
  }
  if (!input.apply) return { run, state, saved_paths: [] };
  const saveOptions = { rootDir: input.rootDir };
  let runPath: string | undefined;
  for (let attempt = 0; !runPath; attempt += 1) {
    try {
      runPath = saveOrganizationOperationRun(run, saveOptions);
    } catch (error) {
      if (
        !(error instanceof OrganizationRecordExistsError) ||
        !input.autoSuffixRunId ||
        attempt >= MAX_RUN_ID_ATTEMPTS
      ) {
        if (error instanceof OrganizationRecordExistsError) {
          throw new Error(`Operation run already exists: ${run.run_id}`);
        }
        throw error;
      }
      takenRunIds.add(run.run_id);
      run.run_id = nextFreeOperationRunId(run.run_id, takenRunIds);
    }
  }
  const saved_paths = [runPath, saveOrganizationOperationState(state, saveOptions)];
  auditChain.record({
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'organization_controller',
    action: 'organization.operation_run_recorded',
    operation: `operation_run_recorded:${input.organizationId}/${operation.operation_id}`,
    result: 'completed',
    ...(operation.tenant_slug ? { tenantSlug: operation.tenant_slug } : {}),
    metadata: {
      organization_id: input.organizationId,
      operation_id: operation.operation_id,
      run_id: run.run_id,
      run_status: run.status,
      tier: operation.tier,
    },
  });
  return { run, state, saved_paths };
}

const OPERATION_RUN_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-operation-run.schema.json'
);
const MAX_RUN_ID_ATTEMPTS = 50;
const MAX_RUN_ID_LENGTH = 64;
const DEFAULT_RUN_ID_RE = /^(.+)-(\d{8})(?:-(\d+))?$/u;

/** `<operation>-<date>[-<suffix>]`, truncating the operation part to keep ids ≤ 64 chars. */
function operationRunIdCandidate(operationPart: string, date: string, suffix?: number): string {
  const tail = `-${date}${suffix ? `-${suffix}` : ''}`;
  const head = operationPart.slice(0, MAX_RUN_ID_LENGTH - tail.length).replace(/[-._]+$/u, '');
  return `${head}${tail}`;
}

/** The next `-N` suffixed default run id not in `taken`. */
function nextFreeOperationRunId(runId: string, taken: Set<string>): string {
  const match = DEFAULT_RUN_ID_RE.exec(runId);
  if (!match) throw new Error(`Operation run already exists: ${runId}`);
  const [, operationPart, date, suffix] = match;
  let next = suffix ? Number(suffix) + 1 : 2;
  while (taken.has(operationRunIdCandidate(operationPart, date, next))) next += 1;
  return operationRunIdCandidate(operationPart, date, next);
}

/**
 * Default run id for an operator-attested completion: `<operation>-<YYYYMMDD>`
 * in the trigger timezone, suffixed `-2`, `-3`… when that id is taken. The
 * operation part is truncated so the id stays within the 64-char id limit.
 */
export function defaultOperationRunId(
  operation: OrganizationOperationRecord,
  existingRunIds: Set<string>,
  now = new Date()
): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: operation.trigger.timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .replace(/-/gu, '');
  const base = operationRunIdCandidate(operation.operation_id, date);
  if (!existingRunIds.has(base)) return base;
  let suffix = 2;
  while (existingRunIds.has(operationRunIdCandidate(operation.operation_id, date, suffix)))
    suffix += 1;
  return operationRunIdCandidate(operation.operation_id, date, suffix);
}

export interface OrganizationRecordRunParams {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  operationId: string;
  /** Defaults to `defaultOperationRunId` (`<operation>-<YYYYMMDD>` in the trigger timezone). */
  runId?: string;
  runStatus: OrganizationOperationRunOutcome;
  resultSummary: string;
  evidenceRefs: string[];
  apply: boolean;
}

const RUN_OUTCOMES = new Set<string>(['succeeded', 'failed', 'blocked', 'cancelled']);
const TIERS = new Set<string>(['personal', 'confidential', 'public']);

function requiredText(params: Record<string, unknown>, key: string): string {
  const value = typeof params[key] === 'string' ? (params[key] as string).trim() : '';
  if (!value) throw new Error(`organization record_run requires ${key}`);
  return value;
}

/** Validate the snake_case op params of a record-run pipeline step. */
export function parseOrganizationRecordRunParams(
  params: Record<string, unknown>
): OrganizationRecordRunParams {
  const tier = requiredText(params, 'tier');
  if (!TIERS.has(tier)) throw new Error(`Invalid organization tier: ${tier}`);
  const runStatus = requiredText(params, 'run_status');
  if (!RUN_OUTCOMES.has(runStatus)) throw new Error(`Invalid run status: ${runStatus}`);
  const rawRefs = params.evidence_refs;
  if (rawRefs !== undefined && !Array.isArray(rawRefs) && typeof rawRefs !== 'string') {
    throw new Error('evidence_refs must be an array of repository paths');
  }
  const evidenceRefs = (Array.isArray(rawRefs) ? rawRefs : rawRefs ? [rawRefs] : [])
    .map((ref) => String(ref).trim())
    .filter(Boolean);
  const tenantSlug = typeof params.tenant_slug === 'string' ? params.tenant_slug.trim() : '';
  const runId = typeof params.run_id === 'string' ? params.run_id.trim() : '';
  return {
    organizationId: requiredText(params, 'organization_id'),
    tier: tier as OrganizationTier,
    ...(tenantSlug ? { tenantSlug } : {}),
    operationId: requiredText(params, 'operation_id'),
    ...(runId ? { runId } : {}),
    runStatus: runStatus as OrganizationOperationRunOutcome,
    resultSummary: requiredText(params, 'result_summary'),
    evidenceRefs,
    apply: params.apply === true || String(params.apply).toLowerCase() === 'true',
  };
}

/** Record a completed run, deriving the run id when the caller omits one. */
export function recordOrganizationOperationRunWithDefaults(
  input: OrganizationRecordRunParams,
  now = new Date()
): RecordOrganizationOperationRunResult & { mode: 'apply' | 'dry_run' } {
  const scope = {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug: input.tenantSlug,
  };
  const operation = loadOrganizationOperation(input.operationId, scope);
  if (!operation) throw new Error(`Organization operation not found: ${input.operationId}`);
  const runId =
    input.runId ||
    defaultOperationRunId(
      operation,
      new Set(listOrganizationOperationRuns(scope).map((run) => run.run_id)),
      now
    );
  const result = recordOrganizationOperationRun({
    ...scope,
    operationId: input.operationId,
    runId,
    autoSuffixRunId: !input.runId,
    runStatus: input.runStatus,
    resultSummary: input.resultSummary,
    evidenceRefs: input.evidenceRefs,
    apply: input.apply,
  });
  return { mode: input.apply ? 'apply' : 'dry_run', ...result };
}
