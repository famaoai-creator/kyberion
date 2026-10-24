import { assertNoHumanClaim, withExecutionIdentityLock } from './execution-claim-fence.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentOperationInterface, operationInterfaceResolver } from './operation-protection.js';
import { createHash, createHmac } from 'node:crypto';
import { resolveAuditChainKey } from '../chain-integrity.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { currentScopeEnvelope, runtimeScopeIdentity } from '../scope-envelope.js';
import { resolveRole } from '../authority.js';
import { loadServiceEndpointsCatalog } from '../service/service-endpoint-registry.js';
import { getServicePresetRecord } from '../service/service-preset-registry.js';
import { loadConnectionWithFallback } from '../service/service-engine-helpers.js';
import { resolveServiceBinding } from '../service/service-binding.js';
import { listServiceBindingRecords } from '../service/service-binding-registry.js';
import { evaluateDecisionRights, resolveDecisionRightsMatrix } from '../decision-rights.js';
import { charterInputForDecision } from './charter-call-site.js';
import { findCharterDecision } from './charter-decision-vocabulary.js';
import { isCharterEligiblePolicy } from './approval-gate-charter.js';
import { resolveApprovalPolicy } from './approval-policy.js';
import {
  delegatedDecisionPolicy,
  evaluateAgainstCharter,
  type Charter,
  type CharterAvailability,
} from './accountability-charter.js';
import {
  appendDelegatedExecutionRecord,
  findActiveCharter,
  listCharterIds,
  loadCharterUsage,
  readCharter,
  readCharterLedger,
  recordCharterConsumption,
  withCharterDecisionLock,
  type CharterPathOptions,
  type LedgerEntry,
} from './accountability-charter-registry.js';

export interface DelegatedOperationMapping {
  operation_id: string;
  decision_type: string;
  /** Facts are read from the actual effect payload, never from approval declarations. */
  amount_path?: string[];
  currency_path?: string[];
  recipient_path?: string[];
  required_paths: string[][];
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  max_ttl_seconds: number;
  /** Catalog-owned classification; operators must review it for this exact operation. */
  information_flow?: {
    purpose: string;
    recipient_class:
      'bound_customer' | 'known_counterparty' | 'approved_vendor' | 'public' | 'unknown';
    categories: Array<'routine_business' | 'personal_data' | 'sensitive_business' | 'unknown'>;
    attachment_count_path?: string[];
  };
}
export interface DelegatedExecutionPolicy {
  version: string;
  operations: DelegatedOperationMapping[];
}

const catalog = defineCatalog<DelegatedExecutionPolicy>({
  id: 'delegated-execution-policy',
  path: () => pathResolver.knowledge('product/governance/delegated-execution-policy.json'),
  schema: pathResolver.knowledge('product/schemas/delegated-execution-policy.schema.json'),
  fallback: { version: 'unavailable', operations: [] },
  fallbackOnInvalid: true,
});

export interface DelegatedExecutionTarget {
  operationId: string;
  params: Record<string, unknown>;
  tenantSlug: string;
  agentId: string;
  callerRole?: string;
  source: {
    organizationId?: string;
    projectId?: string;
    missionId?: string;
    taskId?: string;
    workItemId?: string;
  };
  stepId: string;
  correlationId: string;
}
export interface DelegatedExecutionOptions extends CharterPathOptions {
  /** Trusted host/test seam, never populated from an ADF or tool payload. */
  policy?: DelegatedExecutionPolicy;
  now?: Date;
  availability?: CharterAvailability;
  /** Claimed WorkItem identity supplied by the trusted runner, never its model-authored payload. */
  workItem?: { id: string; tenantSlug: string; agentId: string };
}
export interface DelegatedExecutionAuthorization {
  allowed: boolean;
  permitId?: string;
  reason?: string;
}
type Permit = Extract<LedgerEntry, { kind: 'delegated_execution' }>;
const executing = new AsyncLocalStorage<{
  target: DelegatedExecutionTarget;
  permitId: string;
  options: DelegatedExecutionOptions;
}>();
const frames = new AsyncLocalStorage<string>();
const boundaryOptions = new AsyncLocalStorage<DelegatedExecutionOptions>();
/** Trusted host execution context, never deserialized from a pipeline/tool request. */
export function withDelegatedExecutionOptions<T>(
  options: DelegatedExecutionOptions,
  action: () => T
): T {
  return boundaryOptions.run(options, action);
}
/** Trusted engine-generated nesting/iteration identity; never read from context. */
export function withDelegatedExecutionFrame<T>(frame: string, action: () => T): T {
  return frames.run(`${frames.getStore() ?? ''}/${frame}`, action);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : item
  );
}
function hash(value: unknown): string {
  // Configuration may contain low-entropy provider passwords. A keyed,
  // purpose-bound fingerprint prevents offline guesses from a ledger digest.
  // Reuse the durable governed key, never create a parallel secret store.
  const key = resolveAuditChainKey({ createIfMissing: true });
  if (!key) throw new Error('[DELEGATED_FINGERPRINT_KEY_UNAVAILABLE]');
  return createHmac('sha256', key)
    .update('kyberion.delegated-execution.fingerprint.v1\0')
    .update(canonical(value))
    .digest('hex');
}
export function delegatedExecutionBindingHash(target: DelegatedExecutionTarget): string {
  const normalized = normalizeDelegatedTarget(target);
  const operationInterface =
    currentOperationInterface() ??
    (normalized.operationId.startsWith('service:preset:')
      ? operationInterfaceResolver({
          op: 'service:preset',
          manifestPath: 'libs/actuators/service-actuator/manifest.json',
        })()
      : undefined);
  return hash({
    target: normalized,
    effectConfigurationHash: delegatedExecutionEffectConfigurationHash(normalized),
    ...(operationInterface ? { interface: operationInterface } : {}),
  });
}

export function hashDelegatedServiceConfiguration(snapshot: {
  config: unknown;
  preset: unknown;
  connection: unknown;
  binding: unknown;
  tenantBindings: ReturnType<typeof listServiceBindingRecords>;
}): string {
  return hash({
    ...snapshot,
    tenantBindings: [...snapshot.tenantBindings].sort((a, b) =>
      a.binding_id.localeCompare(b.binding_id)
    ),
  });
}
function scope(target: DelegatedExecutionTarget) {
  return { kind: 'organization', tenant_slug: target.tenantSlug } as const;
}
function id(target: DelegatedExecutionTarget): string {
  // Identity is stable independently of mutable operation/payload/actor facts.
  // Reusing a task step after an uncertain effect must conflict, never mint a
  // fresh payment/message merely by changing its body.
  // This nonsecret execution slot must survive fingerprint-key rotation.
  // Explicit projection excludes payloads and arbitrary extra source fields.
  const identity = {
    tenantSlug: target.tenantSlug,
    source: {
      organizationId: target.source.organizationId,
      projectId: target.source.projectId,
      missionId: target.source.missionId,
      taskId: target.source.taskId,
      workItemId: target.source.workItemId,
    },
    stepId: target.stepId,
    correlationId: target.correlationId,
  };
  return `delegated:${createHash('sha256').update(canonical(identity)).digest('hex')}`;
}
/** Stable effect slot, independent of mutable payload/actor and of pipeline run IDs. */
export function delegatedExecutionIdentity(target: DelegatedExecutionTarget): string {
  return id(normalizeDelegatedTarget(target));
}
function at(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(segment) ||
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, segment)
    )
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Canonicalize the service wrapper to the exact provider operation and request body. */
export function normalizeDelegatedTarget(
  target: DelegatedExecutionTarget
): DelegatedExecutionTarget {
  if (target.operationId === 'service:preset') {
    const p = target.params;
    if (
      typeof p.service_id === 'string' &&
      typeof p.action === 'string' &&
      p.params &&
      typeof p.params === 'object' &&
      !Array.isArray(p.params)
    ) {
      return {
        ...target,
        operationId: `service:preset:${p.service_id}:${p.action}`,
        params: {
          request: p.params,
          auth: p.auth ?? 'none',
        },
      };
    }
  }
  return {
    ...target,
    params: Object.fromEntries(
      Object.entries(target.params).filter(
        ([key]) => !['export_as', '_reasoning_policy', '_facets', '_step_id'].includes(key)
      )
    ),
  };
}

export function hasDelegatedOperationMapping(operationId: string): boolean {
  return (boundaryOptions.getStore()?.policy ?? catalog.load()).operations.some(
    (entry) => entry.operation_id === operationId
  );
}

/** Runtime scope only: context/ADF tenant or actor fields cannot mint authority. */
export function runtimeDelegatedTarget(
  operationId: string,
  params: Record<string, unknown>,
  stepId: string
): DelegatedExecutionTarget | undefined {
  const identity = currentScopeEnvelope()?.identity ?? runtimeScopeIdentity();
  const workItem = boundaryOptions.getStore()?.workItem;
  if (workItem && identity.tenant_slug && identity.tenant_slug !== workItem.tenantSlug) return;
  const tenantSlug = workItem?.tenantSlug ?? identity.tenant_slug;
  if (!tenantSlug || (!identity.mission_id && !identity.task_id && !workItem?.id) || !stepId)
    return;
  stepId = `${frames.getStore() ?? ''}/${stepId}`;
  return normalizeDelegatedTarget({
    operationId,
    params,
    tenantSlug,
    agentId: workItem?.agentId ?? (identity.task_id ?? identity.mission_id)!,
    callerRole: resolveRole(),
    source: {
      organizationId: identity.organization_id,
      projectId: identity.project_id,
      missionId: identity.mission_id,
      taskId: identity.task_id,
      workItemId: workItem?.id,
    },
    stepId,
    correlationId: `${identity.mission_id ?? ''}:${identity.task_id ?? ''}:${workItem?.id ?? ''}:${stepId}`,
  });
}

/** Fingerprint only; never return/persist credential or connection document contents. */
export function delegatedExecutionEffectConfigurationHash(input: DelegatedExecutionTarget): string {
  const target = normalizeDelegatedTarget(input);
  let effectConfiguration: unknown;
  if (target.operationId.startsWith('service:preset:')) {
    const [, , serviceId, action] = target.operationId.split(':');
    const config = loadServiceEndpointsCatalog().services[serviceId!];
    const preset = config && getServicePresetRecord(serviceId!, config.preset_path);
    if (!preset?.operations[action!]) throw new Error('governed service operation missing');
    const auth = target.params.auth;
    if (auth !== 'none' && auth !== 'secret-guard')
      throw new Error('unsupported delegated authentication mode');
    // Only the digest is persisted. Endpoint, preset template, selected
    // account/connection and credential rotations invalidate issued permits.
    effectConfiguration = {
      config,
      preset,
      connection: loadConnectionWithFallback(serviceId!),
      binding: resolveServiceBinding(serviceId!, auth),
      tenantBindings: listServiceBindingRecords()
        .filter(
          (record) =>
            record.tenant_slug === target.tenantSlug &&
            (record.service_id === serviceId || record.service_type === serviceId)
        )
        .sort((a, b) => a.binding_id.localeCompare(b.binding_id)),
    };
  }
  return effectConfiguration
    ? hashDelegatedServiceConfiguration(
        effectConfiguration as Parameters<typeof hashDelegatedServiceConfiguration>[0]
      )
    : hash(null);
}

function resolveFacts(target: DelegatedExecutionTarget, options: DelegatedExecutionOptions) {
  const mappings = (options.policy ?? catalog.load()).operations.filter(
    (m) => m.operation_id === target.operationId
  );
  if (mappings.length !== 1) throw new Error('operation has no unique governed delegation mapping');
  const mapping = mappings[0]!;
  const effectConfigurationHash = delegatedExecutionEffectConfigurationHash(target);
  const decision = findCharterDecision(mapping.decision_type);
  if (!decision) throw new Error('unmapped decision type');
  // Financial settlement requires the dedicated provider executor; a generic
  // permission receipt can never replace permanent payment idempotency.
  if (decision.action_class === 'payment')
    throw new Error('payment requires executeCharterPayment');
  for (const field of mapping.required_paths) {
    const value = at(target.params, field);
    if (value === undefined || value === null || value === '')
      throw new Error('required operation fact missing');
  }
  const amount = mapping.amount_path ? at(target.params, mapping.amount_path) : undefined;
  if (
    decision.amount_semantics !== 'none' &&
    (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)
  )
    throw new Error('actual amount missing');
  if (
    decision.amount_semantics !== 'none' &&
    (!mapping.currency_path || at(target.params, mapping.currency_path) !== 'JPY')
  )
    throw new Error('actual currency must be JPY');
  let recipients: number | undefined;
  if (mapping.recipient_path) {
    const recipient = at(target.params, mapping.recipient_path);
    if (typeof recipient === 'string' && recipient.trim()) recipients = 1;
    else if (
      Array.isArray(recipient) &&
      recipient.length &&
      recipient.every((v) => typeof v === 'string' && v.trim())
    )
      recipients = recipient.length;
    else throw new Error('actual recipient missing');
  }
  let informationFlow: unknown;
  if (mapping.information_flow) {
    if (!recipients) throw new Error('recipient-bound operation required');
    const flow = mapping.information_flow;
    const attachments = flow.attachment_count_path
      ? at(target.params, flow.attachment_count_path)
      : 0;
    if (typeof attachments !== 'number' || !Number.isSafeInteger(attachments) || attachments < 0)
      throw new Error('actual attachment count missing');
    informationFlow = {
      purpose: flow.purpose,
      recipient_class: flow.recipient_class,
      categories: flow.categories,
      attachment_count: attachments,
    };
  }
  const charter = charterInputForDecision(
    {
      tenantSlug: target.tenantSlug,
      agentId: target.agentId,
      decisionType: mapping.decision_type,
      amount: amount as number | undefined,
      recipients,
      informationFlow,
    },
    options,
    options.now
  );
  if (!charter) throw new Error('active charter not found');
  return { mapping, charter, mappingHash: hash({ mapping, effectConfigurationHash }) };
}

function previous(
  target: DelegatedExecutionTarget,
  options: DelegatedExecutionOptions
): { charter: Charter; permit: Permit } | undefined {
  let found: { charter: Charter; permit: Permit } | undefined;
  let reserved = false;
  for (const charterId of listCharterIds(scope(target), options)) {
    const charter = readCharter(scope(target), charterId, options)!;
    for (const entry of readCharterLedger(charter, options)) {
      if (entry.kind === 'consumption' && entry.correlation_id === id(target)) reserved = true;
      if (entry.kind === 'delegated_execution' && entry.permit_id === id(target)) {
        if (found && found.charter.charter_id !== charterId)
          throw new Error('conflicting permit lineage');
        found = { charter, permit: entry };
      }
    }
  }
  if (reserved && !found) throw new Error('orphaned budget reservation requires reconciliation');
  return found;
}

function evaluate(
  target: DelegatedExecutionTarget,
  options: DelegatedExecutionOptions,
  prior?: { charter: Charter; permit: Permit }
) {
  if (
    !target.agentId ||
    !target.stepId ||
    !target.correlationId ||
    (!target.source.missionId && !target.source.taskId && !target.source.workItemId)
  )
    throw new Error('execution identity incomplete');
  const now = options.now ?? new Date();
  const { mapping, charter: facts, mappingHash } = resolveFacts(target, options);
  const charter = findActiveCharter(scope(target), now, options)!;
  const policy = resolveApprovalPolicy({
    intentId: target.operationId,
    payload: target.params,
  });
  if (!isCharterEligiblePolicy(policy)) throw new Error('hardened approval floor');
  const matrix = evaluateDecisionRights(resolveDecisionRightsMatrix(target.tenantSlug), {
    decisionType: mapping.decision_type,
    actorRole: target.callerRole,
    amount: facts.action.amount ?? facts.action.estimated_loss,
    riskLevel: mapping.risk_level,
  });
  if (
    matrix?.requiresEscalation &&
    charter.envelope.supersedes_decision_rights !== true &&
    !(
      matrix.escalationKind === 'human_acceptance' &&
      matrix.charterDelegable &&
      delegatedDecisionPolicy(charter.envelope, mapping.decision_type) !== 'forbid'
    )
  )
    throw new Error('decision-rights escalation');
  const usage = loadCharterUsage(charter, now, options);
  const reservations = readCharterLedger(charter, options).filter(
    (e) => e.kind === 'consumption' && e.correlation_id === id(target)
  );
  if (prior) {
    if (
      prior.charter.charter_id !== charter.charter_id ||
      prior.permit.charter_sha256 !== hash(charter) ||
      prior.permit.mapping_sha256 !== mappingHash ||
      prior.permit.binding_hash !== delegatedExecutionBindingHash(target) ||
      Date.parse(prior.permit.expires_at) <= now.getTime() ||
      reservations.length !== 1
    )
      throw new Error('permit expired, revoked, changed or unreserved');
    const reservation = reservations[0]!;
    if (reservation.kind === 'consumption') {
      if (reservation.ts.slice(0, 10) === now.toISOString().slice(0, 10))
        usage.spent_today -= reservation.money;
      if (reservation.ts.slice(0, 7) === now.toISOString().slice(0, 7))
        usage.spent_this_month -= reservation.money;
    }
  }
  const decision = evaluateAgainstCharter({
    charter,
    action: facts.action,
    usage,
    availability: options.availability ?? {
      accountable_available: false,
      available_deputies: [],
    },
    now,
  });
  if (!['allow', 'allow_notify'].includes(decision.decision))
    throw new Error(decision.reasons.join('; '));
  return { charter, mapping, mappingHash, action: facts.action, decision, now };
}

export function authorizeDelegatedExecution(
  input: DelegatedExecutionTarget,
  options: DelegatedExecutionOptions = {}
): DelegatedExecutionAuthorization {
  const target = normalizeDelegatedTarget(input);
  options = { ...boundaryOptions.getStore(), ...options };
  try {
    return withExecutionIdentityLock(id(target), () =>
      withCharterDecisionLock(scope(target), () => {
        assertNoHumanClaim(id(target), target.tenantSlug);
        const prior = previous(target, options);
        const evaluated = evaluate(target, options, prior);
        if (prior) {
          if (prior.permit.state !== 'issued')
            throw new Error(
              `execution already ${prior.permit.state}; automatic replay is forbidden`
            );
          return { allowed: true, permitId: id(target) };
        }
        const { charter, mapping, mappingHash, action, decision, now } = evaluated;
        recordCharterConsumption(charter, action, decision, options, now, id(target));
        appendDelegatedExecutionRecord(
          charter,
          {
            kind: 'delegated_execution',
            ts: now.toISOString(),
            permit_id: id(target),
            binding_hash: delegatedExecutionBindingHash(target),
            charter_sha256: hash(charter),
            mapping_sha256: mappingHash,
            operation_id: target.operationId,
            actor_id: target.agentId,
            actor_role: target.callerRole,
            source: target.source,
            step_id: target.stepId,
            correlation_id: target.correlationId,
            decision_type: mapping.decision_type,
            expires_at: new Date(
              Math.min(
                Date.parse(charter.accountable.expires_at),
                now.getTime() + mapping.max_ttl_seconds * 1000
              )
            ).toISOString(),
            state: 'issued',
          },
          options
        );
        return { allowed: true, permitId: id(target) };
      })
    );
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : 'delegation unavailable',
    };
  }
}

export function verifyDelegatedExecution(
  input: DelegatedExecutionTarget & { permitId: string },
  options: DelegatedExecutionOptions = {}
): boolean {
  const { permitId, ...raw } = input;
  const target = normalizeDelegatedTarget(raw);
  options = { ...boundaryOptions.getStore(), ...options };
  const active = executing.getStore();
  if (active && active.permitId === permitId && hash(active.target) === hash(target))
    options = { ...active.options, ...options };
  if (permitId !== id(target)) return false;
  try {
    return withCharterDecisionLock(scope(target), () => {
      const prior = previous(target, options);
      if (!prior || !['issued', 'executing'].includes(prior.permit.state)) return false;
      evaluate(target, options, prior);
      return true;
    });
  } catch {
    return false;
  }
}

export function currentDelegatedExecution(
  operationId: string,
  params: Record<string, unknown>
): { target: DelegatedExecutionTarget; permitId: string } | undefined {
  const active = executing.getStore();
  if (
    !active ||
    active.target.operationId !== operationId ||
    hash(active.target.params) !== hash(params) ||
    !verifyDelegatedExecution({ ...active.target, permitId: active.permitId }, active.options)
  )
    return;
  return { target: active.target, permitId: active.permitId };
}

/** Runtime-owned presence, so revocation cannot silently fall back to legacy execution. */
export function hasDelegatedExecutionContext(): boolean {
  return Boolean(executing.getStore());
}

export function isDelegatedExecutionReplayBlocked(input: DelegatedExecutionTarget): boolean {
  try {
    const existing = previous(normalizeDelegatedTarget(input), boundaryOptions.getStore() ?? {});
    return Boolean(existing && existing.permit.state !== 'issued');
  } catch {
    return true;
  }
}

/** The actual effect boundary: consume one execution claim and never replay unknown outcomes. */
export async function runDelegatedExecution<T>(
  input: DelegatedExecutionTarget,
  effect: () => Promise<T>,
  options: DelegatedExecutionOptions = {}
): Promise<T> {
  const target = normalizeDelegatedTarget(input);
  options = { ...boundaryOptions.getStore(), ...options };
  const ambient = currentDelegatedExecution(target.operationId, target.params);
  if (ambient && hash(ambient.target) === hash(target)) return effect();
  const authorized = authorizeDelegatedExecution(target, options);
  if (!authorized.allowed) throw new Error(`[DELEGATED_EXECUTION_DENIED] ${authorized.reason}`);
  withExecutionIdentityLock(id(target), () =>
    withCharterDecisionLock(scope(target), () => {
      assertNoHumanClaim(id(target), target.tenantSlug);
      const prior = previous(target, options)!;
      evaluate(target, options, prior);
      if (prior.permit.state !== 'issued') throw new Error('[DELEGATED_EXECUTION_ALREADY_CLAIMED]');
      appendDelegatedExecutionRecord(
        prior.charter,
        { ...prior.permit, state: 'executing', ts: new Date().toISOString() },
        options
      );
    })
  );
  const settle = (state: 'succeeded' | 'unknown') =>
    withCharterDecisionLock(scope(target), () => {
      const prior = previous(target, options)!;
      appendDelegatedExecutionRecord(
        prior.charter,
        { ...prior.permit, state, ts: new Date().toISOString() },
        options
      );
    });
  try {
    return await executing.run({ target, permitId: authorized.permitId!, options }, async () => {
      // Revalidate after async boundary admission, immediately before invoking the effect.
      if (!verifyDelegatedExecution({ ...target, permitId: authorized.permitId! }, options))
        throw new Error('delegated authority changed');
      const result = await effect();
      settle('succeeded');
      return result;
    });
  } catch (error) {
    settle('unknown');
    throw error;
  }
}
