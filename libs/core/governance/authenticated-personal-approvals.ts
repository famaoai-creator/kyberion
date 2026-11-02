import { resolveAssumedRole } from '../authority.js';
/** Human surface composition only: identity comes from authenticated member + installed NHI. */
import { withScopeEnvOnly } from '../foundation/scope-resolution-mode.js';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  narrowScopeEnvelope,
  withScopeEnvelope,
} from '../scope-envelope.js';
import { inspectInstalledOnboardingRuntime } from '../organization/onboarding-runtime-identity.js';
import type { OnboardingAuthorityPrincipal } from '../organization/onboarding-authority.js';

/** The principal must be produced by the existing authenticated owner adapter, never request JSON. */
export function withAuthenticatedPersonalApprovals<T>(
  principal: OnboardingAuthorityPrincipal,
  run: () => T
): T | null {
  // In-process role is governed by the existing role-assumption policy. Neither
  // a plain principal object nor SYSTEM_ROLE/CLI flags establish this surface.
  if (resolveAssumedRole() !== 'sovereign_concierge' || !principal.personalOwner) return null;
  const installed = inspectInstalledOnboardingRuntime({ kind: 'person' });
  if (!installed.ready || installed.ownerId !== principal.accountableId) return null;
  const parent = currentScopeEnvelope();
  if (
    parent &&
    (parent.identity.tier !== 'personal' ||
      parent.identity.tenant_slug ||
      (parent.identity.nhi_id && parent.identity.nhi_id !== installed.agentId) ||
      !parent.policy.read_tiers.includes('personal'))
  )
    return null;
  const identity = { tier: 'personal' as const, nhi_id: installed.agentId };
  const envelope = parent
    ? narrowScopeEnvelope(parent, { identity })
    : withScopeEnvOnly(() =>
        mintScopeEnvelope({
          identity: { ...identity, session_id: `personal-approvals:${principal.accountableId}` },
          policy: {
            purpose: 'authenticated owner approval review',
            read_tiers: ['public', 'personal'],
            write_tier: 'personal',
          },
          env: {
            ...process.env,
            MISSION_ID: '',
            KYBERION_TASK_ID: '',
            KYBERION_PROJECT_ID: '',
            KYBERION_ORGANIZATION_ID: '',
            KYBERION_TENANT: '',
            KYBERION_TIER: 'personal',
          },
        })
      );
  // This scope supplies data visibility, never a human decision or stronger assurance.
  return withScopeEnvelope(envelope, run);
}
