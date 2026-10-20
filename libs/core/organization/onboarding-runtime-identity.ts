/** Read-only host proof. No caller action or URL can nominate a human or NHI. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { resolveActiveProfileRoot } from '../profile-root.js';
import { loadPersonalAgentIdentityAtPath } from '../personal-identity-state.js';
import { getAgentIdentity, deriveAgentNhiId } from '../agent/agent-identity.js';
import { parseNhiId } from '../nhi-id.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import { resolveMemberByPrincipal } from './member-registry.js';
import type { CharterScope } from '../governance/accountability-charter.js';

/** Exact reviewed names have distinct durable identities, including lossy slug forms. */
export function normalizeOnboardingAgentSlug(agentId: string): string {
  if (!agentId.trim()) throw new Error('Reviewed agent identity is required.');
  const normalized = agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const prefix = /^[a-z]/.test(normalized) ? normalized : `agent-${normalized}`;
  return `${prefix.slice(0, 40).replace(/-+$/, '')}-${createHash('sha256').update(agentId).digest('hex')}`;
}

/** Preserve a prior explicit link only for the exact reviewed name and accountable human. */
export function onboardingAgentIdentityParameters(
  agentId: string,
  accountableId: string
): { slug: string; organizationId?: string } {
  const previous = loadPersonalAgentIdentityAtPath(
    path.join(resolveActiveProfileRoot(), 'agent-identity.json')
  );
  if (previous?.agent_id === agentId && typeof previous.nhi_id === 'string') {
    const parsed = parseNhiId(previous.nhi_id);
    const registered = getAgentIdentity(previous.nhi_id);
    if (parsed && registered) {
      if (registered.accountable_human_id !== accountableId)
        throw new Error('Installed agent accountability mismatch.');
      return { slug: parsed.slug, organizationId: parsed.organization_id };
    }
  }
  return { slug: normalizeOnboardingAgentSlug(agentId) };
}

export type InstalledOnboardingRuntime =
  | { ready: true; ownerId: string; agentId: string; agentActive: boolean; scope: CharterScope }
  | { ready: false; reason: string };

export function inspectInstalledOnboardingRuntime(scope: CharterScope): InstalledOnboardingRuntime {
  if (getPluginExecutionContext()) return { ready: false, reason: 'host_runtime_required' };
  try {
    // This callback only reads canonical identity records. The worker body is
    // never run with this role; successful proof exposes no profile contents.
    return withExecutionContext('sovereign_concierge', () => {
      const owner = resolveMemberByPrincipal({ source: 'loopback' });
      if (!owner || owner.status !== 'active')
        return { ready: false, reason: 'operator_identity_required' };
      if (
        scope.kind === 'organization' &&
        !owner.memberships.some((m) => m.tenant_slug === scope.tenant_slug && m.role === 'owner')
      )
        return { ready: false, reason: 'operator_tenant_owner_required' };
      const profile = loadPersonalAgentIdentityAtPath(
        path.join(resolveActiveProfileRoot(), 'agent-identity.json')
      );
      if (!profile) return { ready: false, reason: 'onboarding_agent_identity_required' };
      const profileId =
        typeof profile.nhi_id === 'string'
          ? profile.nhi_id
          : typeof profile.agent_id === 'string' && parseNhiId(profile.agent_id)
            ? profile.agent_id
            : typeof profile.agent_id === 'string'
              ? deriveAgentNhiId(profile.agent_id)
              : null;
      const agent = profileId ? getAgentIdentity(profileId) : null;
      if (!agent || !['active', 'provisioned'].includes(agent.lifecycle_status))
        return { ready: false, reason: 'registered_non_suspended_agent_required' };
      const ownerId = `user:${owner.member_id}`;
      if (agent.accountable_human_id !== ownerId)
        return { ready: false, reason: 'agent_accountability_mismatch' };
      if (
        agent.affiliation.tenant_slug &&
        (scope.kind !== 'organization' || agent.affiliation.tenant_slug !== scope.tenant_slug)
      )
        return { ready: false, reason: 'agent_tenant_mismatch' };
      return {
        ready: true,
        ownerId,
        agentId: agent.nhi_id,
        agentActive: agent.lifecycle_status === 'active',
        scope: structuredClone(scope),
      };
    });
  } catch {
    return { ready: false, reason: 'runtime_identity_unavailable' };
  }
}
