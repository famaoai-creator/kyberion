/**
 * Lent reasoning credential broker (CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN §2–§3, §6).
 *
 * The private half of the local allocation broker (credential-allocations.ts)
 * for `credential.use` grants that carry `credential_lending`:
 *
 * - the registered credential record (`<service>[.<label>].record.json`) is the
 *   only source of kind / plan / terms / expiry / contract tenant and of the
 *   value fingerprint; a grant whose terms or fingerprint no longer match it is
 *   refused (`[CREDENTIAL_RECORD_MISMATCH]` / `[CREDENTIAL_VALUE_CHANGED]`);
 * - eligibility (credential-custody.ts) and the monthly budget are checked at
 *   bind and at every use;
 * - a tenant-custody value read for another tenant runs inside the brokered
 *   exact-file capability bound to the owner and records a durable
 *   `credential.lent_read`; the value only enters the in-memory binding;
 * - registration writes go through the credential custody store grant
 *   (issuance right `credential_custody_store`); replacing a registered tenant
 *   value needs an owner approval.
 */
import { assertStoreGrantIssuanceAllowed, withStoreGrant } from '../authority.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import {
  CREDENTIAL_CUSTODY_STORE_ISSUANCE_RIGHT,
  CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT,
  isTenantCredentialCustody,
  withCredentialCustodyWriteCapability,
  withCredentialMaterialCapability,
  withLentCredentialMaterialCapability,
  type CredentialStoreCustody,
} from '../foundation/credential-material-capability.js';
import { readJson } from '../foundation/json.js';
import { parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import type { ScopeContext } from '../foundation/scope-context-validation.js';
import { auditChain } from '../governance/audit-chain.js';
import type { ApprovalRequesterInput } from '../governance/approval-requester.js';
import {
  grantStatusAt,
  loadGrant,
  registerCredentialLendingPolicy,
  verifyGrantBasis,
  type GrantRecord,
} from '../governance/grant-store.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
  withSensitivePathMediation,
} from '../secure-io.js';
import { assertPluginGrantAllows } from '../shell/sandbox-policy.js';
import { providerTenantIsolationForBackend } from '../provider/provider-tenant-isolation.js';
import {
  assertCredentialEligible,
  buildCredentialRecord,
  credentialConnectionPath,
  credentialRecordErrors,
  credentialRecordPath,
  credentialServiceBackends,
  credentialValueFingerprint,
  lendingMatchesRecord,
  memberIdOfPrincipal,
  parseCredentialRef,
  requireCredentialService,
  type CredentialEligibilityDeps,
  type CredentialKind,
  type CredentialLendingScope,
  type CredentialPlan,
  type CredentialRecord,
} from './credential-custody.js';
import {
  consumeCredentialCustodyApproval,
  requestCredentialCustodyApproval,
} from './credential-custody-approval.js';
import {
  defaultCredentialEligibilityDeps,
  isTenantOwnerMember,
} from './credential-eligibility-deps.js';
import {
  assertCredentialBudget,
  assertCredentialBudgetCached,
  type CredentialUsageHistory,
} from './credential-usage-ledger.js';
import {
  decryptConnectionDocument,
  encryptConnectionDocument,
  isEncryptedConnectionEnvelope,
  resolveSecretEncryptionMode,
} from './secret-encryption.js';
import { loadConnectionDocument } from './secret-guard.js';

export const CREDENTIAL_USE_CAPABILITY = 'credential.use';

export const allocationDenied = () =>
  new Error('[CREDENTIAL_ALLOCATION_DENIED] Allocation missing, expired, revoked, or changed');

/** The tenant-bound grant store read of a borrower's allocations. */
export function allocationReader<T>(tenant: string, run: () => T): T {
  const identity = credentialExecutionIdentity();
  if (identity.personalClaim || (identity.tenantSlug && identity.tenantSlug !== tenant))
    throw allocationDenied();
  return withStoreGrant('credential_allocation_reader', run, {
    tenantSlug: tenant,
    identity: { missionId: identity.missionId ?? null, taskId: identity.taskId ?? null },
  });
}

// ---------------------------------------------------------------------------
// Rules and test seams
// ---------------------------------------------------------------------------

let eligibilityDeps: CredentialEligibilityDeps = defaultCredentialEligibilityDeps;
let usageHistory: CredentialUsageHistory | undefined;
let tenantOwnerMember: (memberId: string, tenant: string) => boolean = isTenantOwnerMember;
export function setCredentialLendingDepsForTests(
  deps: {
    eligibility?: CredentialEligibilityDeps;
    usageHistory?: CredentialUsageHistory;
    tenantOwnerMember?: (memberId: string, tenant: string) => boolean;
  } = {}
): void {
  eligibilityDeps = deps.eligibility ?? defaultCredentialEligibilityDeps;
  usageHistory = deps.usageHistory;
  tenantOwnerMember = deps.tenantOwnerMember ?? isTenantOwnerMember;
  installCredentialLendingPolicy();
}
export function installCredentialLendingPolicy(): void {
  registerCredentialLendingPolicy({
    ownsTenant: (memberId, tenant) => tenantOwnerMember(memberId, tenant),
    installationPerson: () => eligibilityDeps.installationPerson(),
    assertEligible: (lending, borrower, now) =>
      assertCredentialEligible(lending, borrower, now, eligibilityDeps),
  });
}
installCredentialLendingPolicy();

/** Backends a lending grant may feed in this envelope. */
export function lendingGrantBackends(
  grant: GrantRecord,
  allowedReasoningBackends?: readonly string[]
): string[] {
  const lending = grant.scope.credential_lending;
  if (!lending) return [];
  return lending.allowed_backends.filter(
    (backend) =>
      credentialServiceBackends().includes(backend) &&
      (allowedReasoningBackends === undefined || allowedReasoningBackends.includes(backend))
  );
}

/**
 * The ONE selection of the lent credential a run binds (review S6): lending
 * grants feeding a backend the run may use (`allowed`, the envelope's
 * allowed_reasoning_backends — the resident Dot pins it to its charter
 * backend), latest expiry first. The Dot pre-check calls the same function.
 */
export function selectLendingGrants(
  grants: readonly GrantRecord[],
  allowedReasoningBackends?: readonly string[]
): GrantRecord[] {
  return grants
    .filter((grant) => lendingGrantBackends(grant, allowedReasoningBackends).length > 0)
    .sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at));
}

/** Eligibility now, then the month's budget (bind time: exact ledger read). */
export function assertLendingUsable(
  grant: GrantRecord,
  tenant: string,
  now: Date = new Date()
): CredentialLendingScope {
  const lending = grant.scope.credential_lending;
  if (!lending) throw allocationDenied();
  assertCredentialEligible(lending, tenant, now, eligibilityDeps);
  assertCredentialBudget(lending, tenant, grant.grant_id, now, { history: usageHistory });
  return lending;
}

// ---------------------------------------------------------------------------
// Owner-store reads (record and value)
// ---------------------------------------------------------------------------

function ownerRead<T>(tenant: string, credentialRef: string, file: string, read: () => T): T {
  const ref = parseCredentialRef(credentialRef);
  assertStoreGrantIssuanceAllowed(CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT);
  const caller = credentialExecutionIdentity();
  const active = resolvePolicyIdentityContext().tenantSlug;
  if (active && active !== tenant)
    throw new Error(
      `[ROLE_TENANT_SCOPE_MISMATCH] credential material grant for tenant '${tenant}' used by a caller bound to '${active}'`
    );
  const {
    tenantCleared: _cleared,
    organizationId: _organization,
    ...current
  } = currentExecutionScope() ?? { tenantBound: false };
  const executionIdentity = Object.freeze({
    ...current.executionIdentity,
    missionId: caller.missionId ?? null,
    taskId: caller.taskId ?? null,
  });
  const scoped = (slug: string) =>
    runInExecutionScope(
      { ...current, tenantBound: true, tenantSlug: slug, executionIdentity },
      () => withSensitivePathMediation(read)
    );
  return ref.custody === 'person'
    ? withCredentialMaterialCapability(tenant, file, () => scoped(tenant))
    : withLentCredentialMaterialCapability(ref.owner, tenant, file, () => scoped(ref.owner));
}

function documentOf(raw: unknown, label: string): Record<string, unknown> {
  return parseSafeJsonObjectValue(
    isEncryptedConnectionEnvelope(raw) ? decryptConnectionDocument(raw) : raw,
    label
  );
}

/** The registered record of a credential, read for the borrower `tenant` (non-secret). */
export function readCredentialRecord(tenant: string, credentialRef: string): CredentialRecord {
  const ref = parseCredentialRef(credentialRef);
  const file = credentialRecordPath(ref);
  const record = ownerRead(tenant, credentialRef, file, () =>
    documentOf(readJson<unknown>(pathResolver.rootResolve(file)), 'credential record')
  ) as unknown as CredentialRecord;
  const errors = credentialRecordErrors(record);
  if (errors.length || record.credential_ref !== credentialRef)
    throw new Error(
      `[CREDENTIAL_RECORD_INVALID] ${credentialRef} has no valid registered record | next: pnpm kyberion reasoning credentials register --custody ${ref.custody}${ref.custody === 'tenant' ? ` --owner ${ref.owner}` : ''} --service ${ref.service}${ref.label ? ` --label ${ref.label}` : ''}`
    );
  return record;
}

/**
 * Value of a lent credential for this binding. Re-loads the grant, re-reads the
 * record (terms must still match the grant) and the value (its fingerprint must
 * be the approved one). A tenant-custody read for another tenant is audited
 * durably before the value leaves (once per binding, at bind).
 */
export function readLentValue(
  tenant: string,
  grant: GrantRecord,
  phase: 'bind' | 'revalidate'
): string {
  const lending = grant.scope.credential_lending;
  if (!lending) throw allocationDenied();
  const current = allocationReader(tenant, () => loadGrant(tenant, grant.grant_id));
  if (
    !current ||
    current.capability !== CREDENTIAL_USE_CAPABILITY ||
    JSON.stringify(current.scope) !== JSON.stringify(grant.scope) ||
    grantStatusAt(current, new Date()) !== 'active' ||
    !verifyGrantBasis(current)
  )
    throw allocationDenied();
  const ref = parseCredentialRef(lending.credential_ref);
  const spec = requireCredentialService(ref.service);
  assertPluginGrantAllows('secrets', spec.envKey);
  assertPluginGrantAllows('secrets', `connection:${ref.service}`);
  const record = readCredentialRecord(tenant, lending.credential_ref);
  if (!lendingMatchesRecord(lending, record))
    throw new Error(
      `[CREDENTIAL_RECORD_MISMATCH] ${lending.credential_ref} was re-registered with other terms than grant ${grant.grant_id} approved | next: re-assign it: pnpm kyberion reasoning credentials assign --tenant ${tenant} --credential ${lending.credential_ref} --purpose "<why>"`
    );
  const caller = credentialExecutionIdentity();
  if (ref.custody === 'tenant' && ref.owner !== tenant && phase === 'bind')
    auditChain.recordDurable({
      agentId: 'credential-allocation-broker',
      action: 'credential.lent_read',
      operation: grant.grant_id,
      result: 'completed',
      tenantSlug: tenant,
      metadata: {
        credential_ref: lending.credential_ref,
        owner_tenant: ref.owner,
        borrower_tenant: tenant,
        kind: lending.kind,
        grant_id: grant.grant_id,
        ...(caller.missionId ? { mission_id: caller.missionId } : {}),
        ...(caller.taskId ? { task_id: caller.taskId } : {}),
      },
    });
  const file = credentialConnectionPath(ref);
  const value = ownerRead(tenant, lending.credential_ref, file, () => {
    const field = documentOf(readJson<unknown>(pathResolver.rootResolve(file)), 'lent credential')[
      spec.connectionField
    ];
    return typeof field === 'string' ? field : '';
  });
  if (!value.trim()) throw allocationDenied();
  if (credentialValueFingerprint(value) !== lending.value_fingerprint)
    throw new Error(
      `[CREDENTIAL_VALUE_CHANGED] the value of ${lending.credential_ref} is not the one grant ${grant.grant_id} was approved for | next: re-assign it so the owner approves the new value: pnpm kyberion reasoning credentials assign --tenant ${tenant} --credential ${lending.credential_ref} --purpose "<why>"`
    );
  return value;
}

// ---------------------------------------------------------------------------
// Isolated provider environments (design §3)
// ---------------------------------------------------------------------------

// Each provider's isolated env is built by its tenant-isolation spec
// (provider-tenant-isolation.ts); re-exported here for the existing import
// path through credential-allocations.
export {
  CLAUDE_NETWORK_PASSTHROUGH_ENV_KEYS,
  claudeNetworkPassthroughEnv,
  claudeProviderEnvironment,
} from '../provider/claude-cli-tenant-isolation.js';

// ---------------------------------------------------------------------------
// Binding (design §3 output)
// ---------------------------------------------------------------------------

export interface LentCredentialBinding {
  envKey: string;
  value: string;
  kind: CredentialKind;
  source: { credentialRef: string; allocationGrantId: string };
  providerEnvironments?: Record<string, NodeJS.ProcessEnv>;
  /** Per-use recheck: grant, eligibility, record, value fingerprint, budget. */
  validate(): void;
}

export function bindLentCredential(input: {
  tenant: string;
  tier: ScopeContext['tier'];
  grants: readonly GrantRecord[];
  allowed?: readonly string[];
  reserved: ReadonlySet<string>;
  now: Date;
}): LentCredentialBinding | null {
  const grant = selectLendingGrants(input.grants, input.allowed)[0];
  if (!grant) return null;
  const lending = assertLendingUsable(grant, input.tenant, input.now);
  const spec = requireCredentialService(lending.service);
  if (input.reserved.has(spec.envKey)) throw allocationDenied();
  const value = readLentValue(input.tenant, grant, 'bind');
  const backends = lendingGrantBackends(grant, input.allowed);
  const providerEnvironments: Record<string, NodeJS.ProcessEnv> = {};
  for (const backend of backends) {
    const isolation = providerTenantIsolationForBackend(backend);
    if (isolation && !providerEnvironments[isolation.provider])
      providerEnvironments[isolation.provider] = isolation.buildEnvironment(
        input.tier,
        input.tenant,
        lending.credential_ref
      );
  }
  return {
    envKey: spec.envKey,
    value,
    kind: lending.kind,
    source: { credentialRef: lending.credential_ref, allocationGrantId: grant.grant_id },
    ...(Object.keys(providerEnvironments).length ? { providerEnvironments } : {}),
    validate: () => {
      const now = new Date();
      assertCredentialEligible(lending, input.tenant, now, eligibilityDeps);
      assertCredentialBudgetCached(lending, input.tenant, grant.grant_id, now, {
        history: usageHistory,
      });
      const current = readLentValue(input.tenant, grant, 'revalidate');
      if (current !== value) throw allocationDenied();
    },
  };
}

// ---------------------------------------------------------------------------
// Registration (design §2.1, review S2/S3)
// ---------------------------------------------------------------------------

function serialize(document: Record<string, unknown>): string {
  return (
    (resolveSecretEncryptionMode() === 'none'
      ? JSON.stringify(document, null, 2)
      : JSON.stringify(encryptConnectionDocument(document), null, 2)) + '\n'
  );
}

function custodyWrite(custody: CredentialStoreCustody, file: string, content: string): void {
  assertStoreGrantIssuanceAllowed(CREDENTIAL_CUSTODY_STORE_ISSUANCE_RIGHT);
  const {
    tenantCleared: _c,
    organizationId: _o,
    ...current
  } = currentExecutionScope() ?? {
    tenantBound: false,
  };
  withCredentialCustodyWriteCapability(custody, file, () => {
    const write = () =>
      withSensitivePathMediation(() => {
        safeMkdir(pathResolver.rootResolve(file.replace(/\/[^/]+$/u, '')), { recursive: true });
        safeWriteFile(pathResolver.rootResolve(file), content, { mode: 0o600 });
      });
    return isTenantCredentialCustody(custody)
      ? runInExecutionScope({ ...current, tenantBound: true, tenantSlug: custody.owner }, write)
      : write();
  });
}

export type TenantCredentialRegistration =
  | {
      status: 'registered';
      credential_ref: string;
      path: string;
      kind: CredentialKind;
      plan: CredentialPlan;
      value_fingerprint: string;
    }
  | {
      status: 'approval_required';
      credential_ref: string;
      approval_id: string;
      approver: string;
      value_fingerprint: string;
      token_expires_at?: string;
    };

/**
 * Register a tenant-custody credential (value + non-secret record). Only an
 * owner member of the owner tenant may. Replacing an existing value needs an
 * owner approval bound to the new value's fingerprint (`--approval <id>` to
 * apply). Audited durably; the value is never printed or audited.
 */
export function registerTenantCredential(input: {
  credentialRef: string;
  value: string;
  plan?: CredentialPlan;
  tokenExpiresAt?: string;
  contractTenant?: string;
  registeredBy: string;
  requester?: ApprovalRequesterInput;
  approvalRequestId?: string;
  now?: Date;
}): TenantCredentialRegistration {
  const ref = parseCredentialRef(input.credentialRef);
  if (ref.custody !== 'tenant')
    throw new Error('[CREDENTIAL_REF_INVALID] person custody is registered with --custody person');
  const record = buildCredentialRecord(input);
  const member = memberIdOfPrincipal(input.registeredBy);
  if (!member || !tenantOwnerMember(member, ref.owner))
    throw new Error(
      `[CREDENTIAL_OWNER_REQUIRED] only an owner member of tenant ${ref.owner} registers its credentials (caller ${input.registeredBy || '(unknown)'})`
    );
  const active = resolvePolicyIdentityContext().tenantSlug;
  if (active && active !== ref.owner)
    throw new Error(
      `[ROLE_TENANT_SCOPE_MISMATCH] tenant ${ref.owner} credentials registered by a caller bound to '${active}'`
    );
  const file = credentialConnectionPath(ref);
  const recordFile = credentialRecordPath(ref);
  const exists = withCredentialCustodyWriteCapability(
    { kind: 'tenant', owner: ref.owner },
    file,
    () =>
      runInExecutionScope({ tenantBound: true, tenantSlug: ref.owner }, () =>
        safeExistsSync(pathResolver.rootResolve(file))
      )
  );
  let approvedBy: string | undefined;
  if (exists) {
    // Review 5: the approval binds every term of the record, not only the value.
    const effect = {
      action: 'tenant_credential_overwrite' as const,
      credential_ref: record.credential_ref,
      kind: record.kind,
      plan: record.plan,
      terms: record.terms,
      contract_tenant: record.contract_tenant ?? null,
      token_expires_at: record.token_expires_at ?? null,
      value_fingerprint: record.value_fingerprint,
    };
    if (!input.approvalRequestId) {
      const approval = requestCredentialCustodyApproval(effect, {
        requester: input.requester ?? { requestedBy: input.registeredBy },
        approver: `an owner member of tenant ${ref.owner}`,
      });
      return {
        status: 'approval_required',
        credential_ref: record.credential_ref,
        approval_id: approval.id,
        approver: `an owner member of tenant ${ref.owner}`,
        value_fingerprint: record.value_fingerprint,
        // Repeat exactly these terms on apply (the approval is bound to them).
        ...(record.token_expires_at ? { token_expires_at: record.token_expires_at } : {}),
      };
    }
    approvedBy = consumeCredentialCustodyApproval(
      effect,
      input.approvalRequestId,
      (decider) => {
        const id = memberIdOfPrincipal(decider);
        return Boolean(id && tenantOwnerMember(id, ref.owner));
      },
      record.credential_ref
    ).humanDecider;
  }
  auditChain.recordDurable({
    agentId: input.registeredBy,
    action: exists ? 'credential.replaced' : 'credential.registered',
    operation: record.credential_ref,
    result: 'completed',
    tenantSlug: ref.owner,
    metadata: {
      credential_ref: record.credential_ref,
      kind: record.kind,
      plan: record.plan,
      terms: record.terms,
      value_fingerprint: record.value_fingerprint,
      ...(record.token_expires_at ? { token_expires_at: record.token_expires_at } : {}),
      ...(record.contract_tenant ? { contract_tenant: record.contract_tenant } : {}),
      ...(approvedBy ? { approved_by: approvedBy } : {}),
    },
  });
  const custody = { kind: 'tenant' as const, owner: ref.owner };
  custodyWrite(
    custody,
    file,
    serialize({ [requireCredentialService(ref.service).connectionField]: input.value.trim() })
  );
  custodyWrite(custody, recordFile, serialize({ ...record }));
  return {
    status: 'registered',
    credential_ref: record.credential_ref,
    path: file,
    kind: record.kind,
    plan: record.plan,
    value_fingerprint: record.value_fingerprint,
  };
}

/**
 * Record of a person-custody credential whose value secret introduction
 * already stored (`knowledge/personal/connections/<service>[.<label>].json`).
 * Only the installation person (owner of knowledge/personal) may register; the
 * fingerprint is taken from the stored value, never from argv.
 */
export function registerPersonCredentialRecord(input: {
  credentialRef: string;
  plan?: CredentialPlan;
  tokenExpiresAt?: string;
  contractTenant?: string;
  registeredBy: string;
  now?: Date;
}): CredentialRecord {
  const ref = parseCredentialRef(input.credentialRef);
  const person = eligibilityDeps.installationPerson();
  if (
    ref.custody !== 'person' ||
    !person ||
    ref.owner !== person ||
    memberIdOfPrincipal(input.registeredBy) !== person
  )
    throw new Error(
      `[CREDENTIAL_CUSTODY_PERSON_MISMATCH] person credentials of this installation belong to '${person ?? '(unknown)'}' and are registered by that person only`
    );
  const serviceId = `${ref.service}${ref.label ? `.${ref.label}` : ''}`;
  const stored =
    loadConnectionDocument(serviceId)[requireCredentialService(ref.service).connectionField];
  if (typeof stored !== 'string' || !stored.trim())
    throw new Error(`[CREDENTIAL_VALUE_INVALID] no stored value for ${input.credentialRef}`);
  const record = buildCredentialRecord({ ...input, value: stored });
  auditChain.recordDurable({
    agentId: input.registeredBy,
    action: 'credential.registered',
    operation: record.credential_ref,
    result: 'completed',
    metadata: {
      credential_ref: record.credential_ref,
      kind: record.kind,
      plan: record.plan,
      terms: record.terms,
      value_fingerprint: record.value_fingerprint,
      ...(record.token_expires_at ? { token_expires_at: record.token_expires_at } : {}),
      ...(record.contract_tenant ? { contract_tenant: record.contract_tenant } : {}),
    },
  });
  custodyWrite(
    { kind: 'person', owner: person },
    credentialRecordPath(ref),
    serialize({ ...record })
  );
  return record;
}
