/** Personal account consent: authenticated agent request, separate human decision. */
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { withExecutionContextAsync } from '@agent/core/authority';
import {
  assertSafeRepositoryPath,
  safeLstat,
  withSensitivePathMediation,
} from '@agent/core/secure-io';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { currentScopeEnvelope } from '@agent/core/scope-envelope';
import { credentialExecutionIdentity } from '@agent/core/foundation/credential-binding';
import { currentResourceAccessScope } from '@agent/core/foundation/resource-access-scope';
import { getPluginExecutionContext } from '@agent/core/shell/sandbox-policy';
import { hasDelegatedExecutionContext } from '@agent/core/governance/delegated-execution';
import { withSecretResolutionSession } from '@agent/core/foundation/secret-resolution-session';
import { resolveAuthnPrincipal } from '@agent/core/authn-principal-resolver';
import '@agent/core/authn/authn-providers';
import { parseNhiId } from '@agent/core/contracts/nhi-id';
import { inspectInstalledOnboardingRuntime } from '@agent/core/organization/onboarding-runtime-identity';
import {
  resolveCliApprovalRequester,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import { computeApprovalPayloadHash } from '@agent/core/governance/approval-store';
import type { OnboardingAuthorityPrincipal } from '@agent/core/organization/onboarding-authority';
import {
  requestPersonalCredentialGrantApproval,
  grantPersonalCredentialUse,
  revokePersonalCredentialGrant,
  type PersonalCredentialGrantSelection,
} from '@agent/core/governance/personal-credential-grant';
import { defineScript, isDirectScript } from './lib/harness.js';
import { inspectInstalledIdentity } from './lib/installed-identity.js';
import { readSafeJsonFile } from './lib/json-input.js';
import { readHiddenToken } from './lib/tty/hidden-token-input.js';
import { readPrivateTokenPipe } from './lib/tty/private-token-pipe.js';

const fail = (message: string): never => {
  throw new Error(`[PERSONAL_CONSENT_CLI] ${message}`);
};
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parse(argv: string[]) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: 'boolean' },
        selection: { type: 'string' },
        'approval-id': { type: 'string' },
        reason: { type: 'string' },
        'token-pipe': { type: 'boolean' },
      },
    });
  } catch {
    // Native parser errors may echo a credential mistakenly supplied in argv.
    return fail('Unsupported arguments. Use hidden token entry or the explicit private pipe.');
  }
  const [action, grantId] = parsed.positionals;
  if (action !== 'request' && action !== 'apply' && action !== 'revoke')
    return fail('Expected request, apply or revoke.');
  if (
    parsed.positionals.length !== (action === 'revoke' ? 2 : 1) ||
    (action === 'revoke' && !identifier.test(grantId ?? ''))
  )
    return fail('Invalid positional arguments.');
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) return fail('Duplicate option refused.');
    seen.add(token.name);
  }
  const flags = parsed.values;
  const allowed =
    action === 'request'
      ? ['json', 'selection', 'token-pipe']
      : action === 'apply'
        ? ['json', 'selection', 'approval-id', 'token-pipe']
        : ['json', 'reason'];
  if (Object.keys(flags).some((key) => !allowed.includes(key)))
    return fail('Unsupported option for this consent step.');
  if (action !== 'revoke' && (typeof flags.selection !== 'string' || !flags.selection.trim()))
    return fail('An exact --selection JSON file is required.');
  if (
    action === 'apply' &&
    (typeof flags['approval-id'] !== 'string' || !identifier.test(flags['approval-id']))
  )
    return fail('A valid --approval-id is required.');
  if (
    action === 'revoke' &&
    (typeof flags.reason !== 'string' || !flags.reason.trim() || flags.reason.length > 500)
  )
    return fail('A nonempty --reason of at most 500 characters is required.');
  return { action, grantId, flags };
}

/** Host ceremony only; an ambient worker/tenant ceiling must never be discarded. */
function assertHostContext(): void {
  const identity = credentialExecutionIdentity();
  if (
    identity.tenantSlug ||
    identity.personalClaim ||
    identity.missionId ||
    identity.taskId ||
    currentScopeEnvelope() ||
    currentResourceAccessScope() ||
    getPluginExecutionContext() ||
    hasDelegatedExecutionContext()
  )
    fail('Run consent management in an unscoped installed operator session.');
}

function readSelection(fileName: string): PersonalCredentialGrantSelection {
  try {
    const file = assertSafeRepositoryPath(fileName, { allowMissingLeaf: false });
    const relative = path.relative(resolveActiveProfileRoot(), file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      return fail('Selection must be inside the active personal profile.');
    const stat = safeLstat(file);
    if (!stat.isFile() || stat.size > 16 * 1024) return fail('Invalid selection file.');
    const value = readSafeJsonFile<Record<string, unknown>>(file, 'Personal consent selection');
    const fields = [
      'bindingId',
      'projectId',
      'missionId',
      'taskId',
      'allowedActions',
      'purpose',
      'ttlDays',
    ];
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== fields.length ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      typeof value.bindingId !== 'string' ||
      !identifier.test(value.bindingId) ||
      typeof value.projectId !== 'string' ||
      !identifier.test(value.projectId) ||
      typeof value.missionId !== 'string' ||
      !identifier.test(value.missionId) ||
      typeof value.taskId !== 'string' ||
      !identifier.test(value.taskId) ||
      !Array.isArray(value.allowedActions) ||
      !value.allowedActions.length ||
      value.allowedActions.length > 64 ||
      value.allowedActions.some(
        (action) => typeof action !== 'string' || !identifier.test(action)
      ) ||
      new Set(value.allowedActions).size !== value.allowedActions.length ||
      typeof value.purpose !== 'string' ||
      !value.purpose.trim() ||
      value.purpose.length > 500 ||
      typeof value.ttlDays !== 'number' ||
      !Number.isSafeInteger(value.ttlDays) ||
      value.ttlDays < 1
    )
      return fail('Invalid selection metadata.');
    return {
      bindingId: value.bindingId,
      projectId: value.projectId,
      missionId: value.missionId,
      taskId: value.taskId,
      allowedActions: value.allowedActions as string[],
      purpose: value.purpose,
      ttlDays: value.ttlDays,
    };
  } catch {
    return fail('Invalid selection metadata or file boundary.');
  }
}

function authenticatedAgent(token: string, ownerId: string): OnboardingAuthorityPrincipal {
  try {
    const installed = inspectInstalledOnboardingRuntime({ kind: 'person' });
    const { principal } = resolveAuthnPrincipal(
      { credential: { type: 'agent-token', token } },
      { providerIds: ['agent-token'], pin: false }
    );
    const nhi = parseNhiId(principal.actor.id);
    if (
      !installed.ready ||
      !installed.agentActive ||
      installed.ownerId !== ownerId ||
      resolveCliOperatorIdentity().principalId !== ownerId ||
      principal.provider !== 'agent-token' ||
      principal.source !== 'agent' ||
      principal.assurance !== 'high' ||
      principal.actor.kind !== 'agent' ||
      principal.actor.id !== installed.agentId ||
      principal.actor.on_behalf_of !== ownerId ||
      !nhi ||
      nhi.legacy ||
      nhi.tenant_slug !== null ||
      nhi.organization_id !== null ||
      !Array.isArray(principal.tenantSlugs) ||
      principal.tenantSlugs.length !== 0 ||
      !principal.expiresAt ||
      !Number.isFinite(Date.parse(principal.expiresAt)) ||
      Date.parse(principal.expiresAt) <= Date.now()
    )
      return fail('Agent authentication refused.');
    return {
      requesterId: principal.actor.id,
      accountableId: ownerId,
      personalOwner: true,
      tenantSlugs: [],
    };
  } catch {
    return fail(
      'Agent authentication refused. Existing workload credential and owner binding required.'
    );
  }
}

/** No injected identity, authentication dependencies or input collector in production. */
export async function runPersonalCredentialConsentCli(argv: string[]): Promise<unknown> {
  const { action, grantId, flags } = parse(argv);
  assertHostContext();
  return withSecretResolutionSession(() =>
    withExecutionContextAsync('sovereign_concierge', async () => {
      const ownerId = withSensitivePathMediation(() => {
        const ownerId = resolveCliOperatorIdentity().principalId;
        if (!ownerId) return fail('Existing registered local owner required.');
        return ownerId;
      });
      if (action === 'revoke') {
        return withSensitivePathMediation(() => {
          const requester = resolveCliApprovalRequester({ legacy: 'personal-credential-consent' });
          if (requester.source !== 'operator' || requester.actorId !== ownerId)
            return fail('Withdrawal requires the local owner operator session.');
          const revoked = revokePersonalCredentialGrant(
            { requesterId: ownerId, accountableId: ownerId, personalOwner: true, tenantSlugs: [] },
            grantId!,
            String(flags.reason)
          );
          return { grant_id: revoked.grant_id, status: 'revoked' };
        });
      }
      const selection = withSensitivePathMediation(() => {
        const local = inspectInstalledIdentity();
        const installed = inspectInstalledOnboardingRuntime({ kind: 'person' });
        if (
          !local.ready ||
          local.source !== 'local' ||
          !installed.ready ||
          !installed.agentActive ||
          installed.ownerId !== ownerId
        )
          return fail(
            'Existing active personal identity in the installed owner checkout required.'
          );
        return readSelection(String(flags.selection));
      });
      let token = '';
      try {
        // Sensitive-path mediation is synchronous and must not span terminal input.
        token = flags['token-pipe']
          ? await readPrivateTokenPipe()
          : await readHiddenToken('Existing agent workload token (hidden): ');
        return withSensitivePathMediation(() => {
          assertHostContext();
          authenticatedAgent(token, ownerId);
          const current = readSelection(String(flags.selection));
          if (
            computeApprovalPayloadHash({ selection }) !==
            computeApprovalPayloadHash({ selection: current })
          )
            return fail('Selection changed during authentication. Review it and retry.');
          // Authenticate again after all input work; the facade then rechecks approval/generation.
          const principal = authenticatedAgent(token, ownerId);
          if (action === 'request') {
            const record = requestPersonalCredentialGrantApproval(principal, selection);
            return {
              approval_id: record.id,
              status: record.status,
              approval_url: `/?approvalId=${encodeURIComponent(record.id)}&approvalChannel=${encodeURIComponent(record.channel)}`,
            };
          }
          const record = grantPersonalCredentialUse(
            principal,
            selection,
            String(flags['approval-id'])
          );
          return { grant_id: record.grant_id, status: 'granted', expires_at: record.expires_at };
        });
      } finally {
        token = '';
      }
    })
  );
}

export async function main(argv: string[], print: (value: unknown) => void): Promise<unknown> {
  const result = await runPersonalCredentialConsentCli(argv);
  print(result);
  return result;
}

export const runPersonalCredentialConsent = defineScript({
  name: 'personal-credential-consent',
  flags: ['json'],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'personal_credential_consent.ts') ||
  isDirectScript(import.meta.url, 'personal_credential_consent.js')
)
  void runPersonalCredentialConsent();
