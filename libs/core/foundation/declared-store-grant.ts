/**
 * S4 slice 3 of the scope/identity/grant consolidation (ADR concept-model-v2
 * D6): store grants declared in security-policy.json `store_grants`, replacing
 * the former store-only Authority Roles.
 *
 * A declared store grant is not an Authority Role. It has no role card, is not
 * in the authority role index or `authority_role_permissions`, can never be
 * assumed by name (`withExecutionContext` refuses it) and is never inherited
 * from SYSTEM_ROLE / MISSION_ROLE / a delegated child env (tier-guard denies all
 * I/O to a process running as the name). Only the store facade that owns the
 * store issues it, through authority.ts `withStoreGrant`, after the issuance
 * right check (role-assumption-policy, the same RA-02 rule the former role
 * assumption used) and the tenant binding check. While it is live, the
 * operations it may perform are exactly its declaration in
 * `store_grants.<name>` (`allow_read` / `allow_write` / `deny_read` /
 * `deny_read_descendants` / `narrow`), bound to the issuance tenant
 * (and organization).
 *
 * The live state is a module-private token carried by the execution scope the
 * grant opens: a scope built directly on the (globalThis-reachable) execution
 * scope storage, a copied token after the grant closed, or a scope without a
 * token resolves no declaration. One `@agent/core` instance per process is a
 * precondition (as for every store grant, G2).
 */
import { currentExecutionScope } from './execution-scope.js';

export interface DeclaredStoreGrantDefinition {
  /**
   * The persona bundle the grant's operations are evaluated under — the former
   * role's default persona, so the decisions inside the grant are unchanged.
   */
  readonly persona?: 'worker';
  /** The grant is bound to an explicit tenant, equal to the caller's active tenant. */
  readonly tenantBound: boolean;
  /**
   * A cross-store read (scope model P4): every issuance is a disclosure,
   * recorded in the audit chain before the grant opens (fail closed).
   */
  readonly disclosure?: true;
}

/**
 * The declared store grants. Every name here has a `store_grants` entry in
 * security-policy.json and no Authority Role card (libs/core/testing/store-grant-equivalence.test.ts).
 */
export const DECLARED_STORE_GRANTS: Readonly<Record<string, DeclaredStoreGrantDefinition>> =
  Object.freeze({
    // localization/locale.ts: the tenant reply locale, bound to the turn's tenant.
    scope_locale_reader: Object.freeze({ persona: 'worker', tenantBound: true }),
    // mesh/peer-conversation.ts, peer-task-exchange.ts: a tenant's peer catalogs and profile.
    peer_catalog_reader: Object.freeze({ persona: 'worker', tenantBound: true }),
    // mesh/peer-task-exchange.ts: an accepted peer task's report and the tenant artifact index.
    peer_task_artifact_writer: Object.freeze({ persona: 'worker', tenantBound: true }),
    // scripts/onboarding_first_job_tenant_status.ts: one tenant profile.
    first_job_tenant_status_reader: Object.freeze({ persona: 'worker', tenantBound: false }),
    // authn/authn-providers.ts, concierge viewer-context.ts: the viewer token registry.
    chronos_token_registry_reader: Object.freeze({ persona: 'worker', tenantBound: false }),
    // agent/nhi-lifecycle-governance.ts: accountable member status.
    nhi_accountability_reader: Object.freeze({ persona: 'worker', tenantBound: false }),
    // operator-surface selection-service.ts: the reasoning route settings and their history.
    reasoning_settings_writer: Object.freeze({ persona: 'worker', tenantBound: false }),
    // analysis/metrics.ts: the partitioned metrics ledgers for cap enforcement (numbers only).
    metrics_cap_reader: Object.freeze({ persona: 'worker', tenantBound: false }),
    // knowledge/operational-learning.ts: organization learning candidates.
    operational_learning_writer: Object.freeze({ persona: 'worker', tenantBound: false }),
    // organization/deal-store.ts: a tenant's deal files.
    customer_decision_deal_note_writer: Object.freeze({ persona: 'worker', tenantBound: true }),
    // secret/credential-allocations.ts: a tenant's credential allocation records.
    credential_allocation_reader: Object.freeze({ tenantBound: true }),
    // governance/ledger.ts: one tenant's hybrid ledger partition.
    tenant_ledger_store: Object.freeze({ persona: 'worker', tenantBound: true }),
    // workforce/delegation-store-partition.ts: one tenant's delegated-task partition.
    delegation_record_store: Object.freeze({ persona: 'worker', tenantBound: true }),
    // governance/approval-store-location.ts: one tenant's approval store partition.
    tenant_approval_store: Object.freeze({ persona: 'worker', tenantBound: true }),
    // governance/approval-store-location.ts: the tenant directory names of the approval store.
    tenant_approval_partition_index_reader: Object.freeze({
      persona: 'worker',
      tenantBound: false,
    }),
    // governance/audit-chain.ts tenant mirror (seam registered by authority.ts), bound per entry.
    audit_mirror_writer: Object.freeze({ persona: 'worker', tenantBound: false }),
    // foundation/operational-store-policy.ts (seam registered by authority.ts): ops alert files.
    ops_alert_store: Object.freeze({ persona: 'worker', tenantBound: false }),
    // tenant registry: one tenant profile (operational membership, mission, egress, workspace).
    workspace_tenant_registry_reader: Object.freeze({ persona: 'worker', tenantBound: true }),
    // tenant registry: the tenant directory listing only (descendant reads denied).
    workspace_tenant_registry_index_reader: Object.freeze({
      persona: 'worker',
      tenantBound: false,
    }),
  });

export function isDeclaredStoreGrantName(name: string | undefined): boolean {
  return typeof name === 'string' && Object.hasOwn(DECLARED_STORE_GRANTS, name);
}

export function declaredStoreGrantDefinition(
  name: string
): DeclaredStoreGrantDefinition | undefined {
  return Object.hasOwn(DECLARED_STORE_GRANTS, name) ? DECLARED_STORE_GRANTS[name] : undefined;
}

const liveTokens = new WeakMap<object, string>();

/** Open a grant token for `name`. Import-restricted to authority.ts (boundary test). */
export function openDeclaredStoreGrantToken(name: string): object {
  if (!isDeclaredStoreGrantName(name))
    throw new Error(`[STORE_GRANT_UNKNOWN] '${name}' is not a declared store grant`);
  const token = Object.freeze({});
  liveTokens.set(token, name);
  return token;
}

/** Revoke a grant token. Import-restricted to authority.ts (boundary test). */
export function closeDeclaredStoreGrantToken(token: object): void {
  liveTokens.delete(token);
}

/** The declared store grant live in the current execution scope, if any. */
export function liveDeclaredStoreGrant(): string | undefined {
  const scope = currentExecutionScope();
  const token = scope?.storeGrantToken;
  if (!token) return undefined;
  const name = liveTokens.get(token);
  return name !== undefined && name === scope?.assumedRole ? name : undefined;
}

type PermissionRecord = Record<string, unknown>;

/**
 * The shape the tier guard reads from a role or grant permission record. The
 * values are not validated here (the policy is schema-checked); readers keep
 * their own fail-closed checks.
 */
export interface PolicyPermissionRecord {
  allow_read?: string[];
  allow_write?: string[];
  deny_read?: unknown;
  deny_read_descendants?: unknown;
  narrow?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is PermissionRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The permission record the tier guard evaluates for `role`: its
 * `authority_role_permissions` entry, else — only while that store grant is
 * live in the current scope — its `store_grants` declaration. A name that is
 * both is a policy defect; the role entry is never shadowed by a grant.
 * Returns `undefined` when there is no record, and the raw (possibly
 * malformed) value otherwise so callers keep their own fail-closed checks.
 */
export function rolePermissionRecord(
  policy: unknown,
  role: string | undefined
): PolicyPermissionRecord | undefined {
  if (!role || !isRecord(policy)) return undefined;
  const roles = policy.authority_role_permissions;
  if (isRecord(roles) && Object.hasOwn(roles, role))
    return roles[role] as PolicyPermissionRecord | undefined;
  if (!isDeclaredStoreGrantName(role) || liveDeclaredStoreGrant() !== role) return undefined;
  const grants = policy.store_grants;
  return isRecord(grants) && Object.hasOwn(grants, role)
    ? (grants[role] as PolicyPermissionRecord | undefined)
    : undefined;
}
