/**
 * Tenant `personal_owner` (review B1 of CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN §2.3).
 *
 * The one explicit fact that a tenant is a person's own tenant (a home
 * development tenant), and so may be served by that person's consumer
 * subscription token. Member-registry `owner` memberships and the profile's
 * `assigned_role` are bootstrapped for every tenant (member-registry
 * ensureOwnerMember) and never count. This field changes only here: an
 * approval hash-bound to the exact change, decided by the person being named
 * (or, to clear it, by the person currently named), consumed once, with a
 * durable audit row.
 */
import { auditChain } from '../governance/audit-chain.js';
import { withEntityLifecycleLock } from './entity-lifecycle-lock.js';
import type { ApprovalRequesterInput } from '../governance/approval-requester.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  consumeCredentialCustodyApproval,
  personalOwnerEffectRef,
  requestCredentialCustodyApproval,
} from '../secret/credential-custody-approval.js';
import { withStoreGrant } from '../authority.js';
import { verifyTenantPersonalOwnerBasis } from '../secret/credential-custody-approval.js';
import {
  listTenantProfileSlugs,
  readTenantProfile,
  writeTenantProfile,
  type TenantProfile,
  type TenantRegistryPathOptions,
} from './tenant-registry.js';

const PRINCIPAL = /^user:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function load(slug: string, options: TenantRegistryPathOptions): TenantProfile {
  const profile = readTenantProfile(slug, options);
  if (!profile) throw new Error(`[tenant-personal-owner] tenant '${slug}' does not exist.`);
  if (profile.status !== 'active')
    throw new Error(`[tenant-personal-owner] tenant '${slug}' is ${profile.status}.`);
  return profile;
}

function normalize(personalOwner: string | null): string | null {
  if (personalOwner === null) return null;
  const value = personalOwner.trim();
  if (!PRINCIPAL.test(value))
    throw new Error('[tenant-personal-owner] --person must be a member principal user:<member>');
  return value;
}

/** The approver of a change: the person being named, or the one being removed. */
function approverOf(profile: TenantProfile, personalOwner: string | null): string {
  const approver = personalOwner ?? profile.personal_owner;
  if (!approver)
    throw new Error(
      `[tenant-personal-owner] tenant '${profile.tenant_slug}' has no personal owner to clear.`
    );
  return approver;
}

export function requestTenantPersonalOwner(input: {
  slug: string;
  personalOwner: string | null;
  requester: ApprovalRequesterInput;
  options?: TenantRegistryPathOptions;
}): { approval: ApprovalRequestRecord; approver: string } {
  const personalOwner = normalize(input.personalOwner);
  const profile = load(input.slug, input.options ?? {});
  const approver = approverOf(profile, personalOwner);
  const approval = requestCredentialCustodyApproval(
    {
      action: 'tenant_personal_owner',
      tenant_slug: profile.tenant_slug,
      personal_owner: personalOwner,
    },
    { requester: input.requester, approver }
  );
  return { approval, approver };
}

export function applyTenantPersonalOwner(input: {
  slug: string;
  personalOwner: string | null;
  approvalRequestId: string;
  actor: string;
  options?: TenantRegistryPathOptions;
}): TenantProfile {
  return withEntityLifecycleLock(() => updateTenantPersonalOwner(input));
}

function updateTenantPersonalOwner(
  input: Parameters<typeof applyTenantPersonalOwner>[0]
): TenantProfile {
  const personalOwner = normalize(input.personalOwner);
  const options = input.options ?? {};
  const profile = load(input.slug, options);
  const approver = approverOf(profile, personalOwner);
  const previous = profile.personal_owner ?? null;
  const { humanDecider, approvalId, consumedAt } = consumeCredentialCustodyApproval(
    {
      action: 'tenant_personal_owner',
      tenant_slug: profile.tenant_slug,
      personal_owner: personalOwner,
    },
    input.approvalRequestId,
    (decider) => decider === approver,
    personalOwnerEffectRef(profile.tenant_slug)
  );
  // Durable first: a change whose audit row cannot land is not made.
  const audit = auditChain.recordDurable({
    agentId: input.actor,
    action: 'tenant.personal_owner_changed',
    operation: `tenant:${profile.tenant_slug}:personal_owner`,
    result: 'completed',
    tenantSlug: profile.tenant_slug,
    metadata: {
      previous_personal_owner: previous,
      personal_owner: personalOwner,
      approved_by: humanDecider,
      approval_request_id: approvalId,
    },
  });
  const { personal_owner: _previous, personal_owner_basis: _basis, ...rest } = profile;
  return writeTenantProfile(
    personalOwner
      ? {
          ...rest,
          personal_owner: personalOwner,
          personal_owner_basis: {
            approval_request_id: approvalId,
            decided_at: consumedAt,
            audit_id: audit.id,
          },
        }
      : rest,
    options
  );
}

export interface TenantPersonalOwnerEntry {
  tenant_slug: string;
  personal_owner: string;
  decided_at?: string;
  verified: boolean;
}

/** Every tenant marked as a person's own tenant (review 8: doctor visibility). */
export function listTenantPersonalOwners(
  options: TenantRegistryPathOptions = {}
): TenantPersonalOwnerEntry[] {
  const slugs = withStoreGrant('workspace_tenant_registry_index_reader', () =>
    listTenantProfileSlugs(options)
  );
  const entries: TenantPersonalOwnerEntry[] = [];
  for (const slug of slugs) {
    let profile: TenantProfile | null = null;
    try {
      profile = withStoreGrant(
        'workspace_tenant_registry_reader',
        () => readTenantProfile(slug, options),
        {
          tenantSlug: slug,
        }
      );
    } catch {
      continue;
    }
    if (!profile?.personal_owner) continue;
    entries.push({
      tenant_slug: slug,
      personal_owner: profile.personal_owner,
      ...(profile.personal_owner_basis?.decided_at
        ? { decided_at: profile.personal_owner_basis.decided_at }
        : {}),
      verified: verifyTenantPersonalOwnerBasis(
        slug,
        profile.personal_owner,
        profile.personal_owner_basis
      ),
    });
  }
  return entries;
}

export const TENANT_PERSONAL_OWNERS_PROBE_ID = 'tenant-personal-owners';

/**
 * Doctor warning (optional capability): lists every personal tenant so marking a
 * company tenant personal — which lets a consumer subscription token serve it —
 * is visible. Nothing marked = satisfied.
 */
export async function probeTenantPersonalOwners(
  list: () => TenantPersonalOwnerEntry[] = listTenantPersonalOwners
): Promise<{ available: boolean; reason?: string }> {
  let entries: TenantPersonalOwnerEntry[];
  try {
    entries = list();
  } catch (error) {
    return { available: false, reason: `could not read the tenant registry: ${String(error)}` };
  }
  if (!entries.length) return { available: true };
  return {
    available: false,
    reason: `tenants marked personal (a person's consumer subscription token may serve them): ${entries
      .map(
        (entry) =>
          `${entry.tenant_slug} → ${entry.personal_owner} (decided ${entry.decided_at ?? 'unknown'}${entry.verified ? '' : ', UNVERIFIED basis — ignored'})`
      )
      .join('; ')}. Clear any company tenant: pnpm tenant personal-owner <slug> --clear`,
  };
}
