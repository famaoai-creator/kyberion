/** Read-only host proof. No caller action or URL can nominate a human or NHI. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { resolveActiveProfileRoot } from '../authn/profile-root.js';
import { readPersonalAgentIdentityStrictAtPath as loadPersonalAgentIdentityAtPath } from '../authn/personal-identity-state.js';
import {
  getAgentIdentity,
  captureRuntimeBindingReference,
  type RuntimeBindingReference,
} from '../agent/agent-identity.js';
import { parseNhiId } from '../contracts/nhi-id.js';
import { inspectInstalledPersonalRuntime } from './personal-runtime-identity.js';
import {
  resolvePersonaIdentity,
  personaIdentityBindingsSchema,
} from '../authn/persona-identity.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import {
  findLiveSessionAdmission,
  claimedNhiIdentity,
  claimedSessionId,
} from './nhi-session-admission.js';
import { resolveMemberByPrincipal } from './member-registry.js';
import type { CharterScope } from '../governance/accountability-charter.js';

/** Exact reviewed names have distinct durable identities, including lossy slug forms. */
export function normalizeOnboardingAgentSlug(agentId: string): string {
  if (!agentId.trim()) throw new Error('Reviewed agent identity is required.');
  let normalized = agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-');
  // Runs are collapsed, so each boundary contains at most one hyphen.
  if (normalized.startsWith('-')) normalized = normalized.slice(1);
  if (normalized.endsWith('-')) normalized = normalized.slice(0, -1);
  const prefix = /^[a-z]/.test(normalized) ? normalized : `agent-${normalized}`;
  const short = prefix.slice(0, 40);
  const readable = short.endsWith('-') ? short.slice(0, -1) : short;
  return `${readable}-${createHash('sha256').update(agentId).digest('hex')}`;
}

/** Preserve a prior explicit link only for the exact reviewed name and accountable human. */
export function onboardingAgentIdentityParameters(
  agentId: string,
  accountableId: string
): { slug: string; tenantSlug?: string; organizationId?: string; personScope: true } {
  const previous = loadPersonalAgentIdentityAtPath(
    path.join(resolveActiveProfileRoot(), 'agent-identity.json')
  );
  if (previous?.persona_identity_bindings !== undefined) {
    const bindings = personaIdentityBindingsSchema.parse(previous.persona_identity_bindings);
    if (bindings.accountable_human_id !== accountableId)
      throw new Error('Installed persona accountability mismatch.');
    if (
      previous.agent_id !== agentId &&
      (bindings.personal_nhi_id || bindings.tenant_bindings.length)
    )
      throw new Error('Explicitly clear persona bindings before changing the persona handle.');
  }
  if (previous?.agent_id === agentId && typeof previous.nhi_id === 'string') {
    const registered = getAgentIdentity(previous.nhi_id);
    // Read the recorded (possibly migrated) id, never the stale profile link.
    const parsed = registered ? parseNhiId(registered.nhi_id) : null;
    if (parsed && registered) {
      if (registered.accountable_human_id !== accountableId)
        throw new Error('Installed agent accountability mismatch.');
      // Same tenant/org the record has (or migrates to), so it is found again.
      const tenantSlug = registered.affiliation.tenant_slug;
      const org = registered.affiliation.organization_id;
      return {
        slug: parsed.slug,
        ...(tenantSlug ? { tenantSlug } : {}),
        ...(tenantSlug && org && org !== '_' && org !== 'default' ? { organizationId: org } : {}),
        personScope: true,
      };
    }
  }
  // Personal onboarding never inherits the ambient tenant (person scope).
  return { slug: normalizeOnboardingAgentSlug(agentId), personScope: true };
}

export type InstalledOnboardingRuntime =
  | {
      ready: true;
      ownerId: string;
      agentId: string;
      agentActive: boolean;
      scope: CharterScope;
      runtimeBindingHistory?:
        | { status: 'available'; assurance: 'metadata_only'; reference: RuntimeBindingReference }
        | { status: 'unavailable' };
    }
  | { ready: false; reason: string };

export function inspectInstalledOnboardingRuntime(scope: CharterScope): InstalledOnboardingRuntime {
  if (scope.kind === 'person') return inspectInstalledPersonalRuntime();
  if (getPluginExecutionContext()) return { ready: false, reason: 'host_runtime_required' };
  try {
    // This callback only reads canonical identity records. The worker body is
    // never run with this role; successful proof exposes no profile contents.
    return withExecutionContext('sovereign_concierge', () => {
      const owner = resolveMemberByPrincipal({ source: 'loopback' });
      if (!owner || owner.status !== 'active')
        return { ready: false, reason: 'operator_identity_required' };
      if (!owner.memberships.some((m) => m.tenant_slug === scope.tenant_slug && m.role === 'owner'))
        return { ready: false, reason: 'operator_tenant_owner_required' };
      // Org-scoped delegated operations run under an admitted session, never
      // the ambient personal profile: the process must claim an nhi_id that
      // carries a live, governed runtime-instance binding for the claimed
      // session token (issued by the nhi-session admission ceremony).
      const claimedNhi = claimedNhiIdentity();
      const sessionId = claimedSessionId();
      if (!claimedNhi || !parseNhiId(claimedNhi) || !sessionId)
        return { ready: false, reason: 'session_admission_required' };
      const admitted = getAgentIdentity(claimedNhi);
      if (!admitted || !['active', 'provisioned'].includes(admitted.lifecycle_status))
        return { ready: false, reason: 'registered_non_suspended_agent_required' };
      const binding = findLiveSessionAdmission(claimedNhi, sessionId, scope.tenant_slug);
      if (!binding) return { ready: false, reason: 'session_admission_required' };
      const ownerId = `user:${owner.member_id}`;
      if (admitted.accountable_human_id !== ownerId)
        return { ready: false, reason: 'agent_accountability_mismatch' };
      // A profile mapping is optional for old installations, but when present
      // it must agree with the admitted actor. It can never create admission.
      const profile = loadPersonalAgentIdentityAtPath(
        path.join(resolveActiveProfileRoot(), 'agent-identity.json')
      );
      if (
        profile?.persona_identity_bindings !== undefined &&
        resolvePersonaIdentity(profile, {
          kind: 'tenant',
          accountableHumanId: ownerId,
          tenantSlug: scope.tenant_slug,
        })?.nhi_id !== admitted.nhi_id
      )
        return { ready: false, reason: 'persona_identity_mismatch' };
      // Diagnostic only: strict history failure must not change legacy admission.
      let runtimeBindingHistory: Extract<
        InstalledOnboardingRuntime,
        { ready: true }
      >['runtimeBindingHistory'] = { status: 'unavailable' };
      try {
        const reference = captureRuntimeBindingReference({
          nhiId: admitted.nhi_id,
          instanceId: binding.instance_id,
          sessionId,
          tenantSlug: scope.tenant_slug,
        });
        if (reference)
          runtimeBindingHistory = { status: 'available', assurance: 'metadata_only', reference };
      } catch {
        /* Explicitly unavailable; never promote a tolerant replay into proof. */
      }
      return {
        ready: true,
        ownerId,
        agentId: admitted.nhi_id,
        agentActive: admitted.lifecycle_status === 'active',
        scope: structuredClone(scope),
        runtimeBindingHistory,
      };
    });
  } catch {
    return { ready: false, reason: 'runtime_identity_unavailable' };
  }
}
