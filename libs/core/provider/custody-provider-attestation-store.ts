/**
 * Provider attestations for material without a tenant — system and person
 * custody (INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05 P1, SM-06).
 *
 * Tenant attestations live in the tenant profile. Material that belongs to no
 * tenant — a system role draft, or a person's own material — had no place for
 * the same statement, so it could never leave the machine on the reasoning
 * face. This store holds that statement with the tenant attestation's exact
 * shape and semantics (training_use none|used|unknown, attested_at,
 * expires_at, policy TTL) plus the approval basis a `none` claim needs.
 *
 * Placement (runtime-storage-layout, storage-layout.ts): one registered
 * partitioned runtime state root (`PARTITIONED_RUNTIME_STATE_ROOTS
 * .provider_attestations`):
 * - system custody → `<root>/system/attestations.json` — the platform-wide
 *   partition, which carries no tenant or personal data;
 * - person custody → `<root>/personal/shared/<owner>.json` — the personal tier
 *   with no tenant, so tier-guard applies personal-tier read/write authority.
 *   `<owner>` is `operator` on a single-user installation (design Q-02) or a
 *   digest of the principal id.
 * The contract facts are installation-specific, so they never go in the
 * shipped `provider-egress-policy.json`.
 *
 * Reads are governed: a process bound to a tenant scope cannot read either
 * store (a tenant's material must be decided by its own attestation), and a
 * record that fails validation — including a `none` claim without its approval
 * basis — is reported as an error, which callers treat as "no attestation".
 * Writes happen only through the approval-mediated facade in
 * `custody-provider-attestation-governance.ts`.
 *
 * What a record means (decided 2026-11-05, design option C):
 * - system custody — the installation owner's statement that the provider
 *   does not train on material sent to it under the purchased plan;
 * - person custody — that person's CONSENT to send their own personal
 *   material to the provider under that condition. It is not evidence that
 *   the provider does not train: the egress gate also needs the system
 *   attestation (or a policy declaration `training_use: none`). A person
 *   record counts as consent only when it was decided by its subject
 *   ({@link personCustodyConsentGap}); a record decided by anyone else — e.g.
 *   by the installation owner before this rule — stays on disk untouched but
 *   is read as "no consent".
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { resolveIdentityContext } from '../authority.js';
import { custodyOwnerLabel, type CustodyOwner } from '../custody-owner.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { normalizeApprovalPrincipalId } from '../governance/approval-principal-id.js';
import type { ApprovalConsent } from '../governance/approval-separation-of-duties.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir } from '../secure-io.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS, storagePartitionSegments } from '../storage-layout.js';

export type NonTenantCustodyOwner = Exclude<CustodyOwner, { kind: 'tenant' }>;

export interface CustodyProviderAttestationEntry {
  training_use: 'none' | 'used' | 'unknown';
  plan?: string;
  basis?: string;
  attested_by?: string;
  attested_at: string;
  expires_at?: string;
  /** The human approval a `none` claim was applied under (required for `none`). */
  approval?: { request_id: string; approved_by: string };
}

export interface CustodyProviderAttestationFile {
  version: 1;
  custody: NonTenantCustodyOwner;
  provider_attestations: Record<string, CustodyProviderAttestationEntry>;
}

export const CUSTODY_PROVIDER_ATTESTATION_ROOT =
  PARTITIONED_RUNTIME_STATE_ROOTS.provider_attestations;

/** Owner file name of person custody: `operator` (single user) or a principal digest. */
export function personCustodyOwnerKey(principalId: string | undefined): string {
  const principal = principalId?.trim();
  if (!principal) return 'operator';
  return `principal-${createHash('sha256').update(principal, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * The installation owner as an approval principal: the local owner member
 * (`INSTALLATION_OWNER_MEMBER_ID` in surface/installation-owner-access.ts, as
 * `user:<member_id>`). Kept literal so this store stays a leaf module.
 */
export const INSTALLATION_OWNER_APPROVAL_PRINCIPAL = 'user:owner';

/**
 * Whose consent a person-custody attestation records, as carried on its
 * approval request (`accountability.consent`):
 * - a principal-keyed person (`principal_id`) — that principal, and nobody
 *   else may decide it (`subject_only`);
 * - the `operator` key (single-user installation, or the installation owner's
 *   own material) — the installation owner, who is also the decider of the
 *   owner-role workflow, so an authenticated human decision through that
 *   workflow is the subject's consent (unchanged), and the owner deciding a
 *   request they opened is not a self-approval.
 */
export function personCustodyConsentSubject(
  owner: Extract<NonTenantCustodyOwner, { kind: 'person' }>
): ApprovalConsent {
  const principal = owner.principal_id?.trim();
  return principal
    ? { subject: principal, subject_only: true }
    : { subject: INSTALLATION_OWNER_APPROVAL_PRINCIPAL, subject_only: false };
}

/**
 * Why a person-custody decision by `approvedBy` is not the person's own
 * consent, else undefined. A principal-keyed person consents only through a
 * decision recorded under their own principal id; the `operator` key accepts
 * the owner-role decision. System custody is never consent (undefined).
 */
export function personCustodyConsentGap(
  owner: NonTenantCustodyOwner,
  approvedBy: string | undefined
): string | undefined {
  if (owner.kind !== 'person') return undefined;
  const consent = personCustodyConsentSubject(owner);
  if (!consent.subject_only) return undefined;
  const decider = normalizeApprovalPrincipalId(approvedBy);
  if (decider && decider === normalizeApprovalPrincipalId(consent.subject)) return undefined;
  return `it was decided by '${approvedBy || '(none)'}', not by '${consent.subject}' — only the person can consent to sending their own material`;
}

/** Repo-relative store file of a system or person custody owner. */
export function custodyProviderAttestationRelativePath(owner: NonTenantCustodyOwner): string {
  if (owner.kind === 'system') {
    return path.posix.join(
      CUSTODY_PROVIDER_ATTESTATION_ROOT,
      ...storagePartitionSegments({ kind: 'system' }),
      'attestations.json'
    );
  }
  return path.posix.join(
    CUSTODY_PROVIDER_ATTESTATION_ROOT,
    ...storagePartitionSegments({ kind: 'tier', tier: 'personal' }),
    `${personCustodyOwnerKey(owner.principal_id)}.json`
  );
}

function storeFilePath(owner: NonTenantCustodyOwner): string {
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(custodyProviderAttestationRelativePath(owner)),
    { allowMissingLeaf: true }
  );
}

/**
 * The active tenant binding, if any. A tenant-bound process must never read or
 * write installation / person attestations: its material is decided by the
 * tenant's own statement, and borrowing the installation's would let tenant
 * material ride on a claim the tenant never made.
 */
function tenantScopeRefusal(owner: NonTenantCustodyOwner): string | undefined {
  let active: string | undefined;
  try {
    active = resolveIdentityContext().tenantSlug?.trim() || undefined;
  } catch (error) {
    return `active tenant scope could not be resolved: ${error instanceof Error ? error.message : String(error)}`;
  }
  return active
    ? `${custodyOwnerLabel(owner)} attestations are not readable from the active tenant scope '${active}'`
    : undefined;
}

const TRAINING_USES = new Set(['none', 'used', 'unknown']);

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Semantic validation of one stored entry; returns the problems (empty when valid). */
export function validateCustodyProviderAttestationEntry(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    return ['entry is not an object'];
  const record = entry as Record<string, unknown>;
  const errors: string[] = [];
  if (!TRAINING_USES.has(String(record.training_use))) errors.push('training_use is invalid');
  if (!nonEmpty(record.attested_at)) errors.push('attested_at is required');
  for (const key of ['plan', 'basis', 'attested_by', 'expires_at'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      errors.push(`${key} must be a string`);
    }
  }
  if (record.training_use === 'none') {
    for (const key of ['plan', 'basis', 'attested_by'] as const) {
      if (!nonEmpty(record[key])) errors.push(`training_use 'none' requires ${key}`);
    }
    const approval = record.approval as Record<string, unknown> | undefined;
    if (!approval || !nonEmpty(approval.request_id) || !nonEmpty(approval.approved_by)) {
      errors.push("training_use 'none' requires an approval basis (request_id, approved_by)");
    }
  }
  return errors;
}

function readStoreFile(owner: NonTenantCustodyOwner): CustodyProviderAttestationFile | null {
  const raw = readJsonIfPresent<unknown>(storeFilePath(owner));
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('store file is not an object');
  }
  const file = raw as Partial<CustodyProviderAttestationFile>;
  if (file.version !== 1 || !file.custody || file.custody.kind !== owner.kind) {
    throw new Error('store file version or custody does not match its location');
  }
  if (
    !file.provider_attestations ||
    typeof file.provider_attestations !== 'object' ||
    Array.isArray(file.provider_attestations)
  ) {
    throw new Error('provider_attestations is missing');
  }
  return file as CustodyProviderAttestationFile;
}

export interface CustodyProviderAttestationRead {
  entry?: CustodyProviderAttestationEntry;
  /** Set when the read could not be completed or the record is invalid; treat as absent. */
  error?: string;
}

/**
 * Governed reader of one provider's attestation for a system or person
 * custody owner. Never throws. Refuses (with `error`) under a tenant scope,
 * and reports an invalid record — e.g. `none` without an approval basis — as
 * an error instead of returning it.
 */
export function readCustodyProviderAttestationEntry(
  owner: NonTenantCustodyOwner,
  provider: string
): CustodyProviderAttestationRead {
  const providerId = String(provider || '').trim();
  if (!providerId) return { error: 'provider is required' };
  const refusal = tenantScopeRefusal(owner);
  if (refusal) return { error: refusal };
  let file: CustodyProviderAttestationFile | null;
  try {
    file = readStoreFile(owner);
  } catch (error) {
    return {
      error: `${custodyOwnerLabel(owner)} attestation store could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const entry = file?.provider_attestations[providerId];
  if (!entry) return {};
  const problems = validateCustodyProviderAttestationEntry(entry);
  if (problems.length > 0) {
    return {
      error: `${custodyOwnerLabel(owner)} attestation for '${providerId}' is invalid: ${problems.join('; ')}`,
    };
  }
  return { entry };
}

/**
 * Low-level write of one entry. Validates the entry (a `none` claim must carry
 * its approval basis) and refuses under a tenant scope. Only the governance
 * facade calls this, after the approval has been checked and claimed.
 */
export function writeCustodyProviderAttestationEntry(
  owner: NonTenantCustodyOwner,
  provider: string,
  entry: CustodyProviderAttestationEntry
): { path: string; entry: CustodyProviderAttestationEntry } {
  const providerId = String(provider || '').trim();
  if (!providerId) throw new Error('[custody-attestation] provider is required.');
  const refusal = tenantScopeRefusal(owner);
  if (refusal) throw new Error(`[custody-attestation] ${refusal}.`);
  const problems = validateCustodyProviderAttestationEntry(entry);
  if (problems.length > 0) {
    throw new Error(
      `[custody-attestation] refusing an invalid attestation: ${problems.join('; ')}`
    );
  }
  const filePath = storeFilePath(owner);
  const current = readStoreFile(owner);
  const next: CustodyProviderAttestationFile = {
    version: 1,
    custody: owner.kind === 'system' ? { kind: 'system' } : { kind: 'person' },
    provider_attestations: { ...(current?.provider_attestations ?? {}), [providerId]: entry },
  };
  safeMkdir(path.dirname(filePath), { recursive: true });
  writeJson(filePath, next);
  return { path: custodyProviderAttestationRelativePath(owner), entry };
}
