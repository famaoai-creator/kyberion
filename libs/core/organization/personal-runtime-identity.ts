/** Read-only installed person proof, independent of organization session admission. */
import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import { resolveActiveProfileRoot } from '../authn/profile-root.js';
import { readPersonalAgentIdentityStrictAtPath } from '../authn/personal-identity-state.js';
import { getAgentIdentity } from '../agent/agent-identity.js';
import { buildTenantlessNhiId, NHI_SLUG_PATTERN, parseNhiId } from '../contracts/nhi-id.js';
import { resolvePersonaIdentity } from '../authn/persona-identity.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import {
  ownerAccountableHumanId,
  readMemberProfile,
  resolveMemberByPrincipal,
} from './member-registry.js';

export interface PersonalIdentityRegistration {
  owner: 'missing' | 'active' | 'suspended';
  profile: 'missing' | 'installed';
  nhi: 'missing' | 'unresolved' | 'provisioned' | 'active' | 'suspended' | 'retired' | 'conflict';
  agentId?: string;
  profileHandle?: string;
  explicitNhiBinding?: boolean;
}

function installedPersonalNhiId(
  profile: Record<string, unknown>,
  ownerId: string
): string | undefined {
  if (profile.persona_identity_bindings !== undefined) {
    return resolvePersonaIdentity(profile, { kind: 'person', accountableHumanId: ownerId })?.nhi_id;
  }
  if (typeof profile.nhi_id === 'string') return profile.nhi_id;
  const handle = profile.agent_id;
  if (typeof handle !== 'string') return undefined;
  if (parseNhiId(handle)) return handle;
  return NHI_SLUG_PATTERN.test(handle) ? buildTenantlessNhiId(handle) : undefined;
}

/** Read the two registries independently so a missing Member cannot hide a missing NHI. */
export function inspectPersonalIdentityRegistration(): PersonalIdentityRegistration {
  if (getPluginExecutionContext()) throw new Error('Host runtime required.');
  return withExecutionContext('sovereign_concierge', () => {
    const ownerId = ownerAccountableHumanId();
    const owner = readMemberProfile(ownerId.slice('user:'.length));
    const profile = readPersonalAgentIdentityStrictAtPath(
      path.join(resolveActiveProfileRoot(), 'agent-identity.json')
    );
    const result: PersonalIdentityRegistration = {
      owner: owner?.status ?? 'missing',
      profile: profile ? 'installed' : 'missing',
      nhi: 'unresolved',
    };
    if (!profile) return result;
    const handle = typeof profile.agent_id === 'string' ? profile.agent_id : undefined;
    result.profileHandle = handle;
    result.explicitNhiBinding =
      profile.persona_identity_bindings !== undefined ||
      typeof profile.nhi_id === 'string' ||
      Boolean(handle && parseNhiId(handle));
    const agentId = installedPersonalNhiId(profile, ownerId);
    if (!agentId) {
      if (handle && !result.explicitNhiBinding) result.nhi = 'missing';
      return result;
    }
    const parsed = parseNhiId(agentId);
    result.agentId = agentId;
    const agent = getAgentIdentity(agentId);
    if (
      !parsed ||
      parsed.tenant_slug ||
      (parsed.legacy && !agent) ||
      (agent && (agent.accountable_human_id !== ownerId || agent.affiliation.tenant_slug))
    ) {
      result.nhi = 'conflict';
    } else {
      result.nhi = agent?.lifecycle_status ?? 'missing';
    }
    return result;
  });
}

export type InstalledPersonalRuntime =
  | {
      ready: true;
      ownerId: string;
      agentId: string;
      agentActive: boolean;
      scope: { kind: 'person' };
    }
  | { ready: false; reason: string };

/** No writes, identity repair, caller-selected owner, or organization session fallback. */
export function inspectInstalledPersonalRuntime(): InstalledPersonalRuntime {
  if (getPluginExecutionContext()) return { ready: false, reason: 'host_runtime_required' };
  try {
    // Only canonical identity reads run in this scope; no worker callback is accepted.
    return withExecutionContext('sovereign_concierge', () => {
      const owner = resolveMemberByPrincipal({ source: 'loopback' });
      if (!owner || owner.status !== 'active')
        return { ready: false, reason: 'operator_identity_required' };
      const profile = readPersonalAgentIdentityStrictAtPath(
        path.join(resolveActiveProfileRoot(), 'agent-identity.json')
      );
      if (!profile) return { ready: false, reason: 'onboarding_agent_identity_required' };
      const ownerId = `user:${owner.member_id}`;
      const profileId = installedPersonalNhiId(profile, ownerId);
      const agent = profileId ? getAgentIdentity(profileId) : null;
      if (!agent || !['active', 'provisioned'].includes(agent.lifecycle_status))
        return { ready: false, reason: 'registered_non_suspended_agent_required' };
      if (agent.accountable_human_id !== ownerId)
        return { ready: false, reason: 'agent_accountability_mismatch' };
      if (agent.affiliation.tenant_slug) return { ready: false, reason: 'agent_tenant_mismatch' };
      return {
        ready: true,
        ownerId,
        agentId: agent.nhi_id,
        agentActive: agent.lifecycle_status === 'active',
        scope: { kind: 'person' },
      };
    });
  } catch {
    return { ready: false, reason: 'runtime_identity_unavailable' };
  }
}
