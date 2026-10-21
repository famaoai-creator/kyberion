/** Onboarding approval/delegation, with no agent-accessible human decision path. */
import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { withExecutionContext } from '@agent/core/authority';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { loadPersonalIdentityAtPath } from '@agent/core/personal-identity-state';
import { ensureOwnerMember } from '@agent/core/organization/member-registry';
import {
  resolveCliApprovalRequester,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import {
  onboardingAuthorityScope,
  readOnboardingAuthority,
  previewOnboardingAuthority,
  requestOnboardingAuthority,
  onboardingAuthorityRequestStatus,
  applyOnboardingAuthority,
  type OnboardingAuthorityPrincipal,
} from '@agent/core/organization/onboarding-authority';
import { defineScript, isDirectScript } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

export async function main(
  argv: string[],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const args = await createStandardYargs([process.execPath, 'onboarding_authority.ts', ...argv])
    .scriptName('pnpm onboarding authority')
    .command('$0 [action]', 'Review scoped action authority', (y) =>
      y.positional('action', {
        choices: ['show', 'preview', 'request', 'status', 'apply'] as const,
        default: 'show',
      })
    )
    .option('scope', { choices: ['person', 'organization'] as const, default: 'person' })
    .option('tenant', { type: 'string' })
    .option('file', { type: 'string' })
    .option('request-id', { type: 'string' })
    .option('json', { type: 'boolean', default: false })
    .strict()
    .parse();
  const result = withExecutionContext('sovereign_concierge', () => {
    if (!loadPersonalIdentityAtPath(path.join(resolveActiveProfileRoot(), 'my-identity.json')))
      throw new Error('Complete reviewed identity onboarding first.');
    ensureOwnerMember();
    const owner = resolveCliOperatorIdentity();
    if (!owner.principalId) throw new Error('Registered operator identity required.');
    const requester = resolveCliApprovalRequester({ legacy: 'onboarding-authority' });
    const principal: OnboardingAuthorityPrincipal = {
      requesterId: requester.actorId,
      accountableId: owner.principalId,
      personalOwner: true,
      tenantSlugs: 'all',
    };
    const scope = onboardingAuthorityScope({
      scope_kind: args.scope,
      ...(args.tenant ? { tenant_slug: args.tenant } : {}),
    });
    if (args.action === 'show') return readOnboardingAuthority(principal, scope);
    if (args.action === 'status' || args.action === 'apply') {
      if (!args.requestId) throw new Error('--request-id is required.');
      return args.action === 'status'
        ? onboardingAuthorityRequestStatus(principal, scope, args.requestId)
        : applyOnboardingAuthority(principal, scope, args.requestId);
    }
    if (!args.file) throw new Error('--file is required.');
    const file = assertSafeRepositoryPath(args.file, { allowMissingLeaf: false });
    const envelope = readSafeJsonFile<Record<string, unknown>>(file, 'Onboarding authority plan');
    const input = envelope.input ?? envelope;
    if (args.action === 'preview')
      return { ...previewOnboardingAuthority(principal, input), input };
    if (
      args.action !== 'request' ||
      typeof envelope.digest !== 'string' ||
      typeof envelope.base_hash !== 'string'
    )
      throw new Error(
        'Request requires the exact reviewed preview envelope with input, digest and base_hash.'
      );
    return requestOnboardingAuthority(principal, input, {
      digest: envelope.digest,
      base_hash: envelope.base_hash,
    });
  });
  print(result);
}
const script = defineScript({
  name: 'onboarding-authority',
  flags: ['json'],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'onboarding_authority.ts') ||
  isDirectScript(import.meta.url, 'onboarding_authority.js')
)
  void script();
