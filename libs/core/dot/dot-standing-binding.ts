/**
 * Standing credential binding for tenant resident Dots.
 *
 * A tenant Dot woken by the multi-tenant agent-runtime supervisor has no
 * mission/task lineage and no WorkItem claim, so tenant credentials refuse it
 * (`[CREDENTIAL_BINDING_REQUIRED]`). This module gives every tenant Dot one
 * standing Issue (deterministic `MSN-DOT-*` lineage, the Dot mission
 * admission convention) and runs each wake / executor pass as one child step
 * of it: the step is claimed by the Dot's actor, its lease is renewed by the
 * running supervisor, and the run executes through the same claimed-task
 * dispatch (`withConfiguredTaskCredentials`) as every other WorkItem. The
 * binding is minted only from that live claim plus the lineage, inside an
 * AsyncLocalStorage scope, so two tenants in one process never share one.
 *
 * Nothing here grants authority: the provider credential still comes only
 * from an owner-approved `credential.use` standing grant, re-validated at
 * every use. A missing or expired grant refuses the run with a classified,
 * actionable reason; there is never an operator-credential fallback.
 * Public / tenantless Dots are untouched.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContextAsync } from '../authority.js';
import { withActorContext } from '../authn/actor-context.js';
import { parseActorRef } from '../contracts/actor.js';
import { buildNhiId } from '../contracts/nhi-id.js';
import { withScopeEnvOnly } from '../foundation/scope-resolution-mode.js';
import {
  GRANT_EXTENSION_GRACE_DAYS,
  grantDaysLeft,
  grantStatusAt,
  verifyGrantBasis,
  type GrantRecord,
} from '../governance/grant-store.js';
import { createLogger } from '../logger.js';
import { mintScopeEnvelope, withScopeEnvelope } from '../scope-envelope.js';
import {
  allocationGrantInScope,
  selectReasoningAllocation,
  assertLendingUsable,
  isLocalCredentialAllocationResolver,
  listCredentialAllocations,
  reasoningAllocationProviderAdmitted,
} from '../secret/credential-allocations.js';
import {
  CREDENTIAL_SERVICES,
  credentialServiceBackends,
  SUBSCRIPTION_TOKEN_REMINDER_DAYS,
  subscriptionTokenDaysLeft,
} from '../secret/credential-custody.js';
import { resolveReasoningProviderDescriptor } from '../reasoning/reasoning-provider-registry.js';
import { getSecretResolver } from '../secret/secret-resolver.js';
import { withConfiguredTaskCredentials } from '../secret/task-credential-dispatch.js';
import { notifyOperatorSync } from '../surface/operator-notifications.js';
import {
  claimWorkItem,
  createWorkItemIfAbsent,
  getWorkItem,
  listActiveWorkLeases,
  reapExpiredWorkLeases,
  releaseWorkItem,
  renewWorkItemLease,
} from '../workforce/work-coordination.js';
import type { WorkItem, WorkItemContext } from '../workforce/work-coordination-types.js';
import { normalizeWorkItemContext } from '../workforce/work-coordination-identity.js';
import { dotAdmissionItemId, dotAdmissionMissionId } from './dot-admission-identity.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';

const logger = createLogger('dot-standing-binding');

/** Days before expiry when the operator is reminded to extend the credential grant. */
export const DOT_CREDENTIAL_GRANT_REMINDER_DAYS = 7;
/** Lease of one standing step; renewed every third of it while the run lasts. */
export const DOT_STANDING_STEP_LEASE_MS = 15 * 60 * 1000;
const STANDING_ISSUE_TASK_ID = 'dot-standing';
const DAY_MS = 24 * 60 * 60 * 1000;

export type DotStandingRunKind = 'wake' | 'executor';

export type DotStandingRefusalCode =
  | 'DOT_CREDENTIAL_GRANT_MISSING'
  | 'DOT_CREDENTIAL_GRANT_EXPIRED'
  | 'DOT_STANDING_BINDING_UNAVAILABLE'
  | 'DOT_STANDING_CHARTER_UNBOUND'
  | 'DOT_STANDING_CLAIM_BUSY'
  | 'DOT_STANDING_CLAIM_LOST';

/** A classified refusal raised before the run started; nothing was executed. */
export class DotStandingBindingRefusal extends Error {
  constructor(
    readonly code: DotStandingRefusalCode,
    detail: string
  ) {
    super(`[${code}] ${detail}`);
    this.name = 'DotStandingBindingRefusal';
  }
}

export function isDotStandingBindingRefusal(error: unknown): error is DotStandingBindingRefusal {
  return error instanceof DotStandingBindingRefusal;
}

export interface DotStandingLineage {
  readonly tenantSlug: string;
  readonly organizationId?: string;
  readonly projectId: string;
  readonly tier: DotCharter['scope']['tier'];
  /** `MSN-DOT-*` from the Dot mission admission convention; a lineage id, not a mission record. */
  readonly missionId: string;
  /** The standing Issue every wake / executor step hangs under. */
  readonly issueItemId: string;
  /** Canonical tenant-bound NHI of the Dot: the claim holder of every step. */
  readonly actorId: string;
}

/** True for the standing Issue and its steps: attempt records, never dot work. */
export function isDotStandingItem(item: Pick<WorkItem, 'metadata'>): boolean {
  const kind = item.metadata?.dot_standing;
  return kind === 'issue' || kind === 'wake' || kind === 'executor';
}

/**
 * Tenant credentials bind only to a charter loaded from that tenant's own
 * directory, `knowledge/confidential/<slug>/dots/`, declaring the same tenant.
 * A repo-level `dots/` charter (git-tracked, any author) that merely declares
 * a tenant never selects that tenant's credentials.
 */
export function assertDotCharterTenantSource(loaded: LoadedDotCharter): void {
  const tenant = loaded.charter.scope.tenant_slug;
  if (!tenant) return;
  const normalized = loaded.path.split(path.sep).join('/');
  const dirTenant = normalized.match(/(?:^|\/)knowledge\/confidential\/([^/]+)\/dots\/[^/]+$/)?.[1];
  if (dirTenant !== tenant || loaded.charter.scope.tier !== 'confidential')
    throw new DotStandingBindingRefusal(
      'DOT_STANDING_CHARTER_UNBOUND',
      `dot ${loaded.charter.dot_id} declares tenant ${tenant} but is not loaded from knowledge/confidential/${tenant}/dots/; tenant credentials are never bound to it | next: move the charter into the tenant's dots directory (pnpm kyberion dot create --file <draft.json> --apply) | evidence: ${loaded.path}`
    );
}

function standingRef(charter: DotCharter): string {
  return `dot-standing:${charter.scope.tenant_slug}:${charter.dot_id}`;
}

/**
 * The claim holder's canonical id, derived from the charter. It is not looked
 * up in an NHI registry: resident Dots are not enrolled as NHIs (no lifecycle
 * ceremony exists for them), and the tenant claim check
 * (`assertTaskCredentialClaim`) authenticates the live claim, not the name.
 * What keeps the name honest is the charter source rule
 * ({@link assertDotCharterTenantSource}). If Dots gain NHI enrollment, assert
 * it here.
 */
function dotActorNhi(tenant: string, organizationId: string | undefined, dotId: string): string {
  try {
    return buildNhiId(tenant, organizationId, `dot-${dotId}`);
  } catch {
    // An organization id outside the NHI slug alphabet is written as `_`.
    return buildNhiId(tenant, null, `dot-${dotId}`);
  }
}

/** Deterministic standing lineage of a tenant Dot; null for public / tenantless Dots. */
export function dotStandingLineage(charter: DotCharter): DotStandingLineage | null {
  const tenant = charter.scope.tenant_slug;
  if (!tenant) return null;
  const ref = standingRef(charter);
  const context = normalizeWorkItemContext({
    tenant_slug: tenant,
    ...(charter.scope.organization_id ? { organization_id: charter.scope.organization_id } : {}),
    ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
  });
  return {
    tenantSlug: tenant,
    ...(charter.scope.organization_id ? { organizationId: charter.scope.organization_id } : {}),
    projectId: context.project_id!,
    tier: charter.scope.tier,
    missionId: dotAdmissionMissionId(ref),
    issueItemId: dotAdmissionItemId(ref),
    actorId: dotActorNhi(tenant, charter.scope.organization_id, charter.dot_id),
  };
}

function lineageContext(lineage: DotStandingLineage, taskId: string): WorkItemContext {
  return {
    tenant_slug: lineage.tenantSlug,
    ...(lineage.organizationId ? { organization_id: lineage.organizationId } : {}),
    project_id: lineage.projectId,
    mission_id: lineage.missionId,
    task_id: taskId,
    work_shape: 'routine_operation',
  };
}

/**
 * Create (or replay) the standing Issue. Created in backlog (executors claim
 * only `ready`); its steps' aggregation moves it to in_progress on the first
 * claimed step, where it stays while the Dot operates.
 */
export function ensureDotStandingIssue(charter: DotCharter): WorkItem {
  const lineage = dotStandingLineage(charter);
  if (!lineage) throw new Error('[DOT_STANDING_BINDING_UNAVAILABLE] tenantless dot');
  return createWorkItemIfAbsent({
    itemId: lineage.issueItemId,
    title: `Standing operation of resident dot ${charter.dot_id}`,
    description:
      'Anchor of the resident dot standing lineage. Each wake / executor pass is one claimed child step; proposals still become separate WorkItems.',
    status: 'backlog',
    projectId: lineage.projectId,
    assigneePeerId: lineage.actorId,
    context: lineageContext(lineage, STANDING_ISSUE_TASK_ID),
    metadata: { dot_id: charter.dot_id, dot_standing: 'issue', mission_id: lineage.missionId },
  });
}

export interface DotCredentialGrantAssessment {
  status: 'ready' | 'missing' | 'expired';
  grant?: GrantRecord;
  daysLeft?: number;
  /** Why no grant applies when grants exist but none matches the charter. */
  detail?: string;
}

/**
 * The tenant's reasoning `credential.use` allocations as the Dot's claimed
 * step will see them at bind time: the same admission predicate as
 * `bindAllocatedTaskCredentials` (tenant, active, approval basis, scope
 * restrictions, canonical/allowed provider), plus the charter's own
 * `runtime.reasoning_backend` when it names one. `expired` means a non-revoked
 * matching grant that may still be extended (grace window).
 */
export function assessDotCredentialGrant(
  charter: DotCharter,
  now: Date,
  list: (tenant: string) => GrantRecord[] = listCredentialAllocations
): DotCredentialGrantAssessment {
  const lineage = dotStandingLineage(charter);
  if (!lineage) return { status: 'missing' };
  const scope = {
    tenant_slug: lineage.tenantSlug,
    project_id: lineage.projectId,
    mission_id: lineage.missionId,
  };
  const wanted = charter.runtime.reasoning_backend;
  if (wanted && !reasoningAllocationProviderAdmitted(wanted))
    return {
      status: 'missing',
      detail: `charter runtime.reasoning_backend '${wanted}' is not an allocatable API provider or lendable credential backend, so no credential.use grant can bind it`,
    };
  // Same selection as bind (selectReasoningAllocation → selectLendingGrants): the
  // Dot envelope pins allowed_reasoning_backends to `wanted`.
  const allowed = wanted ? [wanted] : undefined;
  const grants = list(lineage.tenantSlug).filter(
    (grant) => !grant.revoked && !grant.scope.service_allocation
  );
  const latest = (rows: GrantRecord[]) => selectReasoningAllocation(rows, allowed);
  const active = latest(grants.filter((grant) => allocationGrantInScope(grant, scope, now)));
  if (active) return { status: 'ready', grant: active, daysLeft: grantDaysLeft(active, now) };
  const extendable = latest(
    grants.filter(
      (grant) =>
        grant.scope.tenant_slug === lineage.tenantSlug &&
        grantStatusAt(grant, now) === 'expired' &&
        now.getTime() - Date.parse(grant.expires_at) <= GRANT_EXTENSION_GRACE_DAYS * DAY_MS &&
        verifyGrantBasis(grant)
    )
  );
  if (extendable)
    return { status: 'expired', grant: extendable, daysLeft: grantDaysLeft(extendable, now) };
  return { status: 'missing' };
}

export function dotCredentialAssignCommand(charter: DotCharter): string {
  const provider = charter.runtime.reasoning_backend ?? '<provider>';
  // A backend without an API proof is fed by a lent credential (credential_ref);
  // an API-proof provider takes the legacy --provider path. When no registered
  // credential service admits the backend, name the gap instead of suggesting
  // an assign that cannot bind.
  const descriptor =
    charter.runtime.reasoning_backend != null
      ? resolveReasoningProviderDescriptor(charter.runtime.reasoning_backend)
      : undefined;
  if (descriptor && !descriptor.api_proof) {
    const feedable = credentialServiceBackends();
    if (feedable.includes(descriptor.mode)) {
      const services = Object.keys(CREDENTIAL_SERVICES).join('|');
      return `pnpm kyberion reasoning credentials assign --tenant ${charter.scope.tenant_slug} --credential <tenant:${charter.scope.tenant_slug}:${services}|person:<member>:${services}> --backends ${descriptor.mode} --purpose "resident dot ${charter.dot_id}"`;
    }
    return `register a credential service admitting backend '${descriptor.mode}' (registered services admit: ${feedable.join(', ')}), then assign`;
  }
  return `pnpm kyberion reasoning credentials assign --tenant ${charter.scope.tenant_slug} --provider ${provider} --purpose "resident dot ${charter.dot_id}"`;
}

export function dotCredentialExtendCommand(tenant: string, grantId: string): string {
  return `pnpm kyberion reasoning credentials extend --tenant ${tenant} --grant ${grantId}`;
}

function assertDotCredentialGrant(charter: DotCharter, now: Date, deps: DotStandingDeps): void {
  const tenant = charter.scope.tenant_slug!;
  const assessment = assessDotCredentialGrant(charter, now, deps.listAllocations);
  if (assessment.status === 'ready') {
    // A lent credential is re-checked like at bind time: kind eligibility,
    // borrower attestation, token expiry and the monthly budget. Its classified
    // refusal ([CREDENTIAL_KIND_NOT_ELIGIBLE] …) is a credential_grant stop.
    if (assessment.grant?.scope.credential_lending)
      assertLendingUsable(assessment.grant, tenant, now);
    return;
  }
  if (assessment.status === 'expired' && assessment.grant)
    throw new DotStandingBindingRefusal(
      'DOT_CREDENTIAL_GRANT_EXPIRED',
      `credential.use grant ${assessment.grant.grant_id} for tenant ${tenant} expired at ${assessment.grant.expires_at}; dot ${charter.dot_id} does not run | next: ${dotCredentialExtendCommand(tenant, assessment.grant.grant_id)}, then the owner approves with \`pnpm kyberion approvals --approve <id>\` and the same command runs with --approval <id> | evidence: active/shared/runtime/grants/confidential/${tenant}/`
    );
  throw new DotStandingBindingRefusal(
    'DOT_CREDENTIAL_GRANT_MISSING',
    `tenant ${tenant} has no active owner-approved credential.use grant${assessment.detail ? ` usable by this dot (${assessment.detail})` : ''}; dot ${charter.dot_id} does not run | next: ${dotCredentialAssignCommand(charter)}, then the owner approves with \`pnpm kyberion approvals --approve <id>\` and the same command runs with --approval <id> | evidence: active/shared/runtime/grants/confidential/${tenant}/`
  );
}

export interface DotStandingDeps {
  now?: () => Date;
  /** Installs the dispatch-host credential resolver; defaults to prepareReasoningExecutionHost. */
  prepareHost?: () => void | Promise<void>;
  listAllocations?: (tenant: string) => GrantRecord[];
  leaseMs?: number;
  renewIntervalMs?: number;
}

async function defaultPrepareHost(): Promise<void> {
  (await import('../reasoning/reasoning-bootstrap.js')).prepareReasoningExecutionHost();
}

/**
 * One reusable step per kind under the standing Issue. Each run is one claim =
 * one attempt on it (attempt history is bounded by the store), so a Dot owns at
 * most three WorkItems however long it operates: no per-wake item growth.
 */
function stepIdentity(lineage: DotStandingLineage, kind: DotStandingRunKind) {
  const ref = `${lineage.issueItemId}:${kind}`;
  return {
    itemId: dotAdmissionItemId(ref),
    taskId: `dot-${kind}-${createHash('sha256').update(ref).digest('hex').slice(0, 16)}`,
  };
}

/**
 * Run `run` as one claimed child step of the Dot's standing Issue, inside a
 * trusted task credential binding. Tenantless Dots run `run` unchanged.
 * Throws {@link DotStandingBindingRefusal} before `run` when the binding
 * cannot be established; errors from `run` itself propagate unchanged.
 */
export async function withDotStandingBinding<T>(
  loaded: LoadedDotCharter,
  kind: DotStandingRunKind,
  run: () => Promise<T>,
  deps: DotStandingDeps = {}
): Promise<T> {
  const { charter } = loaded;
  const lineage = dotStandingLineage(charter);
  if (!lineage) return run();
  const now = deps.now?.() ?? new Date();
  let step: { itemId: string; taskId: string };
  let claimed: ReturnType<typeof claimWorkItem>;
  const actor = parseActorRef({ kind: 'agent', id: lineage.actorId });
  try {
    if (!actor) throw new Error(`invalid dot actor ${lineage.actorId}`);
    assertDotCharterTenantSource(loaded);
    await (deps.prepareHost ?? defaultPrepareHost)();
    // Only the local allocation resolver is backed by credential.use grants;
    // an external broker answers for its own material at bind time.
    if (isLocalCredentialAllocationResolver(getSecretResolver()))
      assertDotCredentialGrant(charter, now, deps);
    const issue = ensureDotStandingIssue(charter);
    step = stepIdentity(lineage, kind);
    const stepItem = createWorkItemIfAbsent({
      itemId: step.itemId,
      title: `${kind === 'wake' ? 'Wakes' : 'Executor passes'} of resident dot ${charter.dot_id}`,
      description: `Each ${kind} is one attempt on this step under the standing Issue ${issue.item_id}.`,
      status: 'backlog',
      projectId: lineage.projectId,
      parentItemId: issue.item_id,
      assigneePeerId: lineage.actorId,
      context: lineageContext(lineage, step.taskId),
      metadata: { dot_id: charter.dot_id, dot_standing: kind, mission_id: lineage.missionId },
    });
    recoverOrphanedStandingStep(stepItem.item_id, charter);
    claimed = claimWorkItem({
      itemId: step.itemId,
      actorPeerId: lineage.actorId,
      purpose: `resident dot ${kind}`,
      ttlMs: deps.leaseMs ?? DOT_STANDING_STEP_LEASE_MS,
      requireNewLease: true,
      metadata: { dot_id: charter.dot_id, execution_kind: `dot_${kind}` },
    });
  } catch (error) {
    if (isDotStandingBindingRefusal(error)) throw error;
    if (/lease_conflict|already leased/u.test(String(error)))
      throw new DotStandingBindingRefusal(
        'DOT_STANDING_CLAIM_BUSY',
        `another ${kind} of dot ${charter.dot_id} holds its standing step | next: nothing; the next sweep retries | evidence: ${lineage.issueItemId}`
      );
    throw new DotStandingBindingRefusal(
      'DOT_STANDING_BINDING_UNAVAILABLE',
      `standing claim for dot ${charter.dot_id} could not be established — ${error instanceof Error ? error.message : String(error)} | next: inspect the work coordination store and the dot charter scope | evidence: ${lineage.issueItemId}`
    );
  }
  const leaseMs = deps.leaseMs ?? DOT_STANDING_STEP_LEASE_MS;
  let lost: string | undefined;
  const renew = setInterval(
    () => {
      try {
        renewWorkItemLease({
          leaseId: claimed.lease.lease_id,
          ttlMs: leaseMs,
          actorPeerId: lineage.actorId,
        });
      } catch (error) {
        lost ??= error instanceof Error ? error.message : String(error);
        clearInterval(renew);
        logger.warn(
          `[DOT_STANDING_CLAIM_LOST] lease renewal failed for dot ${charter.dot_id} — ${lost} | next: credential use in this run fails closed; the next run recovers the step | evidence: ${claimed.lease.lease_id}`
        );
      }
    },
    deps.renewIntervalMs ?? Math.max(30_000, Math.floor(leaseMs / 3))
  );
  renew.unref?.();
  let outcome: 'succeeded' | 'failed' = 'failed';
  let summary = `${kind} failed`;
  try {
    const envelope = withScopeEnvOnly(() =>
      mintScopeEnvelope({
        identity: {
          tier: lineage.tier,
          tenant_slug: lineage.tenantSlug,
          ...(lineage.organizationId ? { organization_id: lineage.organizationId } : {}),
          project_id: lineage.projectId,
          mission_id: lineage.missionId,
          task_id: step.taskId,
        },
        policy: {
          purpose: `resident dot ${kind}`,
          read_tiers: ['public', lineage.tier],
          write_tier: lineage.tier,
          // Review S6: bind selects the credential for the backend the charter routes to,
          // with the same predicate as the pre-check (assessDotCredentialGrant).
          ...(charter.runtime.reasoning_backend
            ? { allowed_reasoning_backends: [charter.runtime.reasoning_backend] }
            : {}),
        },
        env: {
          ...process.env,
          MISSION_ID: lineage.missionId,
          KYBERION_TASK_ID: step.taskId,
          KYBERION_TIER: lineage.tier,
          KYBERION_TENANT: lineage.tenantSlug,
          KYBERION_ORGANIZATION_ID: lineage.organizationId ?? '',
          KYBERION_PROJECT_ID: lineage.projectId,
        },
      })
    );
    const result = await withExecutionContextAsync(
      charter.authority.authority_role,
      () =>
        withScopeEnvelope(envelope, () =>
          withActorContext({ actor: actor!, scope: envelope.identity, provenance: 'claim' }, () =>
            withConfiguredTaskCredentials(step.itemId, () => {
              if (lost) throw new DotStandingBindingRefusal('DOT_STANDING_CLAIM_LOST', lost);
              return run();
            })
          )
        ),
      undefined,
      lineage.tenantSlug,
      lineage.organizationId,
      { missionId: lineage.missionId, taskId: step.taskId, projectId: lineage.projectId }
    );
    outcome = 'succeeded';
    summary = `${kind} completed`;
    return result;
  } catch (error) {
    summary = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearInterval(renew);
    try {
      const current = getWorkItem(step.itemId);
      releaseWorkItem({
        itemId: step.itemId,
        leaseId: claimed.lease.lease_id,
        actorPeerId: lineage.actorId,
        ...(current ? { expectedVersion: current.version } : {}),
        // The step returns to backlog for the next run (never `ready`: no
        // dispatcher may pick it up); this attempt keeps the outcome.
        nextStatus: 'backlog',
        summary: summary.slice(0, 500),
        metadata: { execution_status: outcome, lease_status: 'released' },
      });
    } catch (error) {
      logger.warn(
        `[DOT_STANDING_CLAIM_LOST] standing step release failed for dot ${charter.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: the next run of this dot recovers the step (expired attempt, no escalation) | evidence: ${step.itemId}`
      );
    }
  }
}

/**
 * A step left in_progress by a crashed supervisor (no live lease) is settled
 * here, before the next claim: its lease is expired and the attempt is marked
 * lease_expired. Standing steps carry no declared effect target and are
 * excluded from the dot work reaper, so this never escalates or quarantines
 * dot work.
 */
function recoverOrphanedStandingStep(itemId: string, charter: DotCharter): void {
  const item = getWorkItem(itemId);
  if (!item || item.status === 'backlog') return;
  if (item.lease_id && listActiveWorkLeases().some((lease) => lease.item_id === itemId)) return;
  reapExpiredWorkLeases({
    itemFilter: (candidate) => candidate.item_id === itemId,
    maxClaimAttempts: Number.MAX_SAFE_INTEGER,
    maxErrorAttempts: Number.MAX_SAFE_INTEGER,
  });
  logger.warn(
    `[DOT_STANDING_CLAIM_LOST] recovered an orphaned standing step of dot ${charter.dot_id} (a previous run ended without releasing it) | next: nothing; this run continues on the same step | evidence: ${itemId}`
  );
}

const reminded = new Set<string>();

/**
 * Chronos-visible reminder (ops_alert) when the tenant's credential.use grant
 * expires within {@link DOT_CREDENTIAL_GRANT_REMINDER_DAYS} days, or has
 * expired but can still be extended. Once per grant per day.
 */
export function remindDotCredentialGrantExpiry(
  charter: DotCharter,
  now: Date,
  deps: {
    notify?: typeof notifyOperatorSync;
    listAllocations?: (tenant: string) => GrantRecord[];
  } = {}
): boolean {
  const tenant = charter.scope.tenant_slug;
  if (!tenant) return false;
  const assessment = assessDotCredentialGrant(charter, now, deps.listAllocations);
  const grant = assessment.grant;
  // Design §2.4: a subscription token's own 1-year expiry, 30 days ahead (separate
  // from the 7-day credential.use reminder; renewing the token needs a new setup-token).
  const lending = grant?.scope.credential_lending;
  const tokenDays = lending ? subscriptionTokenDaysLeft(lending, now) : undefined;
  let tokenReminded = false;
  if (lending && tokenDays !== undefined && tokenDays < SUBSCRIPTION_TOKEN_REMINDER_DAYS) {
    const tokenKey = `${tenant}:${lending.credential_ref}:token:${now.toISOString().slice(0, 10)}`;
    if (!reminded.has(tokenKey)) {
      reminded.add(tokenKey);
      tokenReminded = true;
      (deps.notify ?? notifyOperatorSync)(
        'ops_alert',
        {
          title:
            tokenDays < 0
              ? `Subscription token ${lending.credential_ref} expired — ${tenant} resident dots stopped`
              : `Subscription token ${lending.credential_ref} expires in ${tokenDays} day(s)`,
          body: `${lending.credential_ref} (${lending.plan}) token expires at ${lending.token_expires_at}. Renew it: run \`claude setup-token\`, store it with pnpm kyberion reasoning credentials register --custody ${lending.custody}${lending.custody === 'tenant' ? ` --owner ${lending.owner}` : ''} --service ${lending.service} --plan ${lending.plan} --token-expires <YYYY-MM-DD>, then re-assign the grant with the new --token-expires.`,
          correlation_id: `credential-token-expiry:${tokenKey}`,
        },
        { scope: charter.scope }
      );
    }
  }
  if (
    !grant ||
    (assessment.status === 'ready' &&
      (assessment.daysLeft ?? 0) >= DOT_CREDENTIAL_GRANT_REMINDER_DAYS)
  )
    return tokenReminded;
  const key = `${tenant}:${grant.grant_id}:${now.toISOString().slice(0, 10)}`;
  if (reminded.has(key)) return tokenReminded;
  reminded.add(key);
  const expired = assessment.status === 'expired';
  (deps.notify ?? notifyOperatorSync)(
    'ops_alert',
    {
      title: expired
        ? `Credential grant for ${tenant} expired — resident dots stopped`
        : `Credential grant for ${tenant} expires in ${assessment.daysLeft} day(s)`,
      body: `${grant.grant_id} (${grant.scope.credential_provider}) ${expired ? 'expired at' : 'expires at'} ${grant.expires_at}. Resident dots of ${tenant} (e.g. ${charter.dot_id}) need it to reason. Extend it: ${dotCredentialExtendCommand(tenant, grant.grant_id)}; the owner approves with \`pnpm kyberion approvals --approve <id>\`.`,
      correlation_id: `dot-credential-grant-expiry:${key}`,
    },
    { scope: charter.scope }
  );
  return true;
}

/** Test seam: forget what was already announced. */
export function resetDotCredentialGrantReminders(): void {
  reminded.clear();
}
