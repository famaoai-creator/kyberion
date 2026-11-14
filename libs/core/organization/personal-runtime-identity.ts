/** Read-only installed person proof, independent of organization session admission. */
import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import { resolveActiveProfileRoot } from '../authn/profile-root.js';
import { readPersonalAgentIdentityStrictAtPath } from '../authn/personal-identity-state.js';
import { getAgentIdentity } from '../agent/agent-identity.js';
import { buildTenantlessNhiId, NHI_SLUG_PATTERN, parseNhiId } from '../contracts/nhi-id.js';
import { resolvePersonaIdentity } from '../authn/persona-identity.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import { resolveMemberByPrincipal } from './member-registry.js';

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
      const profileId =
        profile.persona_identity_bindings !== undefined
          ? resolvePersonaIdentity(profile, {
              kind: 'person',
              accountableHumanId: `user:${owner.member_id}`,
            })?.nhi_id
          : typeof profile.nhi_id === 'string'
            ? profile.nhi_id
            : typeof profile.agent_id === 'string' && parseNhiId(profile.agent_id)
              ? profile.agent_id
              : typeof profile.agent_id === 'string'
                ? NHI_SLUG_PATTERN.test(profile.agent_id)
                  ? buildTenantlessNhiId(profile.agent_id)
                  : null
                : null;
      const agent = profileId ? getAgentIdentity(profileId) : null;
      if (!agent || !['active', 'provisioned'].includes(agent.lifecycle_status))
        return { ready: false, reason: 'registered_non_suspended_agent_required' };
      const ownerId = `user:${owner.member_id}`;
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
