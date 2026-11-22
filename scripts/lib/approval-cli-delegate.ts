/**
 * `pnpm kyberion approvals --delegate <id>` — converts a pending, charter-
 * delegable external-operation request into an onboarding-authority grant
 * plan in one step. The stored delegation_target was derived server-side
 * from the trusted effect at request creation; it is re-validated through
 * the delegation registry parser before any charter grant is composed.
 * The human approve + apply ceremony is unchanged.
 */
import path from 'node:path';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { parseExternalOperationGrant } from '@agent/core/governance/external-operation-target';
import {
  previewOnboardingAuthority,
  requestOnboardingAuthority,
  type OnboardingAuthorityPrincipal,
} from '@agent/core/organization/onboarding-authority';
import {
  resolveCliApprovalRequester,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import { loadPersonalIdentityAtPath } from '@agent/core/personal-identity-state';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { withExecutionContext } from '@agent/core/authority';
import { inspectInstalledIdentity, canonicalAuthorityCommand } from './installed-identity.js';

const DEFAULT_DELEGATE_EXPIRY_MS = 90 * 86_400_000;

/** Returns a refusal reason, or runs preview+request and prints next steps. */
export function delegateApprovalToCharter(
  request: ApprovalRequestRecord,
  expiresAtArg: string | undefined,
  printOutput: (line: string) => void
): { ok: boolean } {
  const grant = parseExternalOperationGrant(request.delegation_target);
  if (!grant) {
    const reason = request.delegation_target
      ? 'its recorded delegation target failed re-validation'
      : `'${request.subject ?? request.id}' is not registered as a charter-delegable operation`;
    printOutput(
      `Cannot delegate ${request.id}: ${reason}. This request still needs a human decision (--approve/--deny).`
    );
    return { ok: false };
  }
  const expiresAtMs = expiresAtArg
    ? Date.parse(expiresAtArg)
    : Date.now() + DEFAULT_DELEGATE_EXPIRY_MS;
  if (!Number.isFinite(expiresAtMs)) {
    printOutput(`Invalid --expires-at '${expiresAtArg}'; pass an ISO date.`);
    return { ok: false };
  }
  const tenantSlug = request.scope?.tenant_slug;
  const input = {
    scope_kind: tenantSlug ? ('organization' as const) : ('person' as const),
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    mode: 'grant' as const,
    grants: [grant],
    expires_at: new Date(expiresAtMs).toISOString(),
  };
  const installed = inspectInstalledIdentity();
  if (installed.source === 'unavailable') throw new Error(installed.next);
  if (installed.source === 'installation') {
    throw new Error(
      `Onboarding authority is managed at ${installed.governance_root}. Approve and delegate there: ${canonicalAuthorityCommand(installed.governance_root, ['onboarding', 'authority', 'show'])}`
    );
  }
  const { preview, receipt } = withExecutionContext('sovereign_concierge', () => {
    if (!loadPersonalIdentityAtPath(path.join(resolveActiveProfileRoot(), 'my-identity.json')))
      throw new Error('Complete reviewed identity onboarding first.');
    const owner = resolveCliOperatorIdentity();
    if (!owner.principalId)
      throw new Error('Registered operator identity required. Complete identity onboarding first.');
    const requester = resolveCliApprovalRequester({ legacy: 'onboarding-authority' });
    const principal: OnboardingAuthorityPrincipal = {
      requesterId: requester.actorId,
      accountableId: owner.principalId,
      personalOwner: true,
      tenantSlugs: 'all',
    };
    const preview = previewOnboardingAuthority(principal, input);
    const receipt = requestOnboardingAuthority(principal, input, {
      digest: preview.digest,
      base_hash: preview.base_hash,
    });
    return { preview, receipt };
  });
  printOutput(`Delegation plan request created: ${receipt.request_id}`);
  printOutput('');
  for (const line of preview.statement.split('\n')) printOutput(`  ${line}`);
  printOutput('');
  printOutput(`  Approve the plan:   pnpm kyberion approvals --approve ${receipt.request_id}`);
  printOutput(
    `  Then apply it:      pnpm onboarding authority apply --request-id ${receipt.request_id}`
  );
  printOutput(
    `  The pending request ${request.id} still needs its own decision (--approve/--deny) — delegation applies to future calls.`
  );
  return { ok: true };
}
