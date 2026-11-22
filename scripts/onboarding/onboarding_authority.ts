/** Onboarding approval/delegation, with no agent-accessible human decision path. */
import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { withExecutionContext } from '@agent/core/authority';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import { writeJson } from '@agent/core/foundation/json';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { loadPersonalIdentityAtPath } from '@agent/core/personal-identity-state';
import {
  resolveCliApprovalRequester,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import {
  CHARTER_SCOPE_KINDS,
  charterScopesEqual,
} from '@agent/core/governance/accountability-charter';
import {
  onboardingAuthorityScope,
  readOnboardingAuthority,
  previewOnboardingAuthority,
  requestOnboardingAuthority,
  onboardingAuthorityRequestStatus,
  applyOnboardingAuthority,
  type OnboardingAuthorityPrincipal,
} from '@agent/core/organization/onboarding-authority';
import { defineScript, isDirectScript } from '../lib/harness.js';
import { readSafeJsonFile } from '../lib/json-input.js';
import { inspectInstalledIdentity, canonicalAuthorityCommand } from '../lib/installed-identity.js';

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
    .option('scope', { choices: CHARTER_SCOPE_KINDS, default: 'person' })
    .option('tenant', { type: 'string' })
    .option('file', { type: 'string' })
    .option('out', {
      type: 'string',
      description: 'Save the reviewed preview under the active personal profile',
    })
    .option('request-id', { type: 'string' })
    .option('json', { type: 'boolean', default: false })
    .strict()
    .parse();
  const usesFile = args.action === 'preview' || args.action === 'request';
  const usesRequestId = args.action === 'status' || args.action === 'apply';
  if (args.out && args.action !== 'preview') throw new Error('--out is only valid for preview.');
  if (usesFile !== Boolean(args.file)) {
    throw new Error(
      usesFile ? '--file is required.' : '--file is only valid for preview or request.'
    );
  }
  if (usesRequestId !== Boolean(args.requestId)) {
    throw new Error(
      usesRequestId
        ? '--request-id is required.'
        : '--request-id is only valid for status or apply.'
    );
  }
  const explicitScope = !usesFile || argv.some((arg) => /^--(?:scope|tenant)(?:=|$)/.test(arg));
  const selectedScope = explicitScope
    ? onboardingAuthorityScope({
        scope_kind: args.scope,
        ...(args.tenant ? { tenant_slug: args.tenant } : {}),
      })
    : undefined;
  const installed = inspectInstalledIdentity();
  if (installed.source === 'unavailable') throw new Error(installed.next);
  if (installed.source === 'installation') {
    // Files are intentionally not copied: the reviewed envelope stays in its owner checkout.
    throw new Error(
      `Onboarding authority is managed at ${installed.governance_root}. Run there with the same explicit scope and reviewed file: ${canonicalAuthorityCommand(installed.governance_root, argv)}. A file outside that checkout is rejected; create and review the plan in the installed checkout before requesting approval.`
    );
  }
  const result = withExecutionContext('sovereign_concierge', () => {
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
    if (args.action === 'show') return readOnboardingAuthority(principal, selectedScope!);
    if (args.action === 'status' || args.action === 'apply') {
      if (!args.requestId) throw new Error('--request-id is required.');
      return args.action === 'status'
        ? onboardingAuthorityRequestStatus(principal, selectedScope!, args.requestId)
        : applyOnboardingAuthority(principal, selectedScope!, args.requestId);
    }
    if (!args.file) throw new Error('--file is required.');
    const file = assertSafeRepositoryPath(args.file, { allowMissingLeaf: false });
    const envelope = readSafeJsonFile<Record<string, unknown>>(file, 'Onboarding authority plan');
    const input = envelope.input ?? envelope;
    const fileScope = onboardingAuthorityScope(input);
    if (selectedScope && !charterScopesEqual(selectedScope, fileScope))
      throw new Error(
        'The reviewed file scope does not match --scope/--tenant. Use the scope in the file or review a new plan.'
      );
    if (args.action === 'preview') {
      const preview = { ...previewOnboardingAuthority(principal, input), input };
      if (!args.out) return preview;
      const out = assertSafeRepositoryPath(args.out, { allowMissingLeaf: true });
      const relative = path.relative(resolveActiveProfileRoot(), out);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('--out must be a file under the active personal profile.');
      if (safeExistsSync(out))
        throw new Error('--out already exists; choose a new reviewed preview file.');
      writeJson(out, preview, { createOnly: true });
      return { ...preview, reviewed_file: out };
    }
    if (
      args.action !== 'request' ||
      typeof envelope.digest !== 'string' ||
      typeof envelope.base_hash !== 'string'
    )
      throw new Error(
        'Request requires the exact reviewed preview envelope with input, digest and base_hash. ' +
          'Generate it first — the digest binds to YOUR identity, so run preview yourself:\n' +
          '  pnpm onboarding authority preview --file <plan.json> --scope <person|organization> [--tenant <slug>] --out knowledge/personal/<name>-preview.json\n' +
          'then request with that file.'
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
