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
  charterScopeTenantSlug,
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
import { describeInvalidExternalOperationGrants } from '@agent/core/governance/external-operation-target';
import { defineScript, isDirectScript } from '../lib/harness.js';
import { readSafeJsonFile } from '../lib/json-input.js';
import { inspectInstalledIdentity, canonicalAuthorityCommand } from '../lib/installed-identity.js';

/** Sequential argv scan: each `--grant` opens a grant; `--grant-field k=v` attaches
 * to the most recent one. The composed objects go through the delegation
 * registry parser — unknown operations, fields and wildcards fail closed. */
function grantsFromFlagArgv(argv: string[]): Record<string, unknown>[] {
  const grants: Record<string, unknown>[] = [];
  const attach = (kv: string | undefined) => {
    const eq = kv?.indexOf('=') ?? -1;
    if (!kv || eq <= 0) throw new Error('--grant-field expects key=value.');
    if (!grants.length) throw new Error('--grant-field must follow a --grant.');
    const last = grants[grants.length - 1];
    if (kv.slice(0, eq) === 'operation_id')
      throw new Error('operation_id comes from --grant, not --grant-field.');
    last[kv.slice(0, eq)] = kv.slice(eq + 1);
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--grant') {
      const op = argv[++i];
      if (!op || op.startsWith('--')) throw new Error('--grant expects an operation_id.');
      grants.push({ operation_id: op });
    } else if (token.startsWith('--grant=')) {
      grants.push({ operation_id: token.slice('--grant='.length) });
    } else if (token === '--grant-field') {
      attach(argv[++i]);
    } else if (token.startsWith('--grant-field=')) {
      attach(token.slice('--grant-field='.length));
    }
  }
  const problems = describeInvalidExternalOperationGrants(grants);
  if (problems.length) throw new Error(`invalid delegation grant: ${problems.join('; ')}`);
  return grants;
}

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
    .option('grant', {
      type: 'array',
      string: true,
      description:
        'preview only: an operation_id to delegate; repeat for several grants. ' +
        'Attach exact target fields with --grant-field key=value after each --grant.',
    })
    .option('grant-field', {
      type: 'array',
      string: true,
      description:
        'preview only: key=value target field for the most recent --grant (exact target fields only; validated by the delegation registry)',
    })
    .option('mode', {
      choices: ['grant', 'revoke'] as const,
      description: 'preview only with --grant: grant (default) or revoke the listed targets',
    })
    .option('expires-at', {
      type: 'string',
      description: 'preview only with --grant: charter expiry ISO date (required in flag mode)',
    })
    .option('out', {
      type: 'string',
      description: 'Save the reviewed preview under the active personal profile',
    })
    .option('request-id', { type: 'string' })
    .option('json', { type: 'boolean', default: false })
    .strict()
    .parse();
  const flagMode = Boolean(args.grant?.length) || Boolean(args.grantField?.length);
  const usesFile = args.action === 'request' || (args.action === 'preview' && !flagMode);
  const usesRequestId = args.action === 'status' || args.action === 'apply';
  if (args.out && args.action !== 'preview') throw new Error('--out is only valid for preview.');
  if (flagMode && args.action !== 'preview')
    throw new Error(
      '--grant/--grant-field are only valid for preview; request takes the reviewed preview file.'
    );
  if (flagMode && args.file) throw new Error('--file and --grant are mutually exclusive.');
  if (usesFile !== Boolean(args.file)) {
    throw new Error(
      usesFile
        ? args.action === 'preview'
          ? '--file or --grant is required.'
          : '--file is required.'
        : '--file is only valid for preview or request.'
    );
  }
  if (flagMode && !args.expiresAt)
    throw new Error('--expires-at is required with --grant (an explicit charter expiry).');
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
    const flagScopeTenant = flagMode ? charterScopeTenantSlug(selectedScope!) : undefined;
    const envelope = flagMode
      ? ({
          scope_kind: selectedScope!.kind,
          ...(flagScopeTenant ? { tenant_slug: flagScopeTenant } : {}),
          mode: args.mode ?? 'grant',
          grants: grantsFromFlagArgv(argv),
          expires_at: args.expiresAt,
        } as Record<string, unknown>)
      : readSafeJsonFile<Record<string, unknown>>(
          assertSafeRepositoryPath(args.file!, { allowMissingLeaf: false }),
          'Onboarding authority plan'
        );
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
