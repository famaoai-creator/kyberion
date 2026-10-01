/**
 * "Setting up an organization": which of the four steps are done, derived from
 * state that already exists (no new authority, nothing is written here).
 *
 *   1. organization — the tenant profile exists and is active
 *   2. members      — someone besides the owner has joined, or an invite is out
 *   3. connections  — at least one connection is owned by the organization
 *   4. charter      — an accountability charter is in force
 *
 * Tenant activation (the governed gate with its own checks) is a separate
 * operator-side procedure; this list never claims it.
 */

export type OrgReadinessStepId = 'organization' | 'members' | 'connections' | 'charter';

export interface OrgReadinessInput {
  tenantSlug: string;
  tenantStatus: 'active' | 'suspended' | 'archived' | null;
  /** Members whose memberships include this tenant, the viewer included. */
  memberCount: number;
  pendingInvites: number;
  organizationConnections: number;
  charterInForce: boolean;
}

export interface OrgReadinessStep {
  id: OrgReadinessStepId;
  done: boolean;
  /** Settings anchor that fixes it. */
  href: string;
}

export interface OrgReadiness {
  tenant_slug: string;
  steps: OrgReadinessStep[];
  done: number;
  total: number;
  all_done: boolean;
}

export function buildOrgReadiness(input: OrgReadinessInput): OrgReadiness {
  const steps: OrgReadinessStep[] = [
    { id: 'organization', done: input.tenantStatus === 'active', href: '#settings-members' },
    {
      id: 'members',
      // The owner alone is not a team: someone else joined, or an invite is waiting.
      done: input.memberCount > 1 || input.pendingInvites > 0,
      href: '#settings-invites',
    },
    { id: 'connections', done: input.organizationConnections > 0, href: '#setup-services' },
    { id: 'charter', done: input.charterInForce, href: '#settings-charter' },
  ];
  const done = steps.filter((step) => step.done).length;
  return {
    tenant_slug: input.tenantSlug,
    steps,
    done,
    total: steps.length,
    all_done: done === steps.length,
  };
}

export function parseOrgReadiness(value: unknown): OrgReadiness[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || !Array.isArray(v.organizations)) return undefined;
  for (const org of v.organizations) {
    const e = org as Record<string, unknown> | null;
    if (
      !e ||
      typeof e.tenant_slug !== 'string' ||
      typeof e.all_done !== 'boolean' ||
      !Array.isArray(e.steps) ||
      e.steps.some(
        (step) =>
          !step ||
          typeof (step as Record<string, unknown>).id !== 'string' ||
          typeof (step as Record<string, unknown>).done !== 'boolean' ||
          typeof (step as Record<string, unknown>).href !== 'string'
      )
    ) {
      return undefined;
    }
  }
  return v.organizations as OrgReadiness[];
}
