/**
 * Shared onboarding-authority identity ceremony for owner CLIs
 * (`onboarding authority`, `approvals --delegate`): unavailable identity
 * fails; an installation-backed checkout redirects to the canonical
 * governance root (message customizable per command); a local checkout
 * requires reviewed personal identity and a registered operator principal.
 * Kept out of installed-identity.ts so that file stays metadata-only.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { loadPersonalIdentityAtPath } from '@agent/core/personal-identity-state';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import {
  resolveCliApprovalRequester,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import type { OnboardingAuthorityPrincipal } from '@agent/core/organization/onboarding-authority';
import { inspectInstalledIdentity, canonicalAuthorityCommand } from './installed-identity.js';

export function withLocalAuthorityPrincipal<T>(
  argv: string[],
  run: (principal: OnboardingAuthorityPrincipal) => T,
  installationMessage?: (governanceRoot: string) => string
): T {
  const installed = inspectInstalledIdentity();
  if (installed.source === 'unavailable') throw new Error(installed.next);
  if (installed.source === 'installation')
    throw new Error(
      installationMessage?.(installed.governance_root) ??
        `Onboarding authority is managed at ${installed.governance_root}. Run there: ${canonicalAuthorityCommand(installed.governance_root, argv)}`
    );
  return withExecutionContext('sovereign_concierge', () => {
    if (!loadPersonalIdentityAtPath(path.join(resolveActiveProfileRoot(), 'my-identity.json')))
      throw new Error('Complete reviewed identity onboarding first.');
    const owner = resolveCliOperatorIdentity();
    if (!owner.principalId)
      throw new Error('Registered operator identity required. Complete identity onboarding first.');
    const requester = resolveCliApprovalRequester({ legacy: 'onboarding-authority' });
    return run({
      requesterId: requester.actorId,
      accountableId: owner.principalId,
      personalOwner: true,
      tenantSlugs: 'all',
    });
  });
}
