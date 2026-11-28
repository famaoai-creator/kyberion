import { parseArgs } from 'node:util';
import { withExecutionContext, withStoreGrant } from '@agent/core/authority';
import { credentialExecutionIdentity } from '@agent/core/foundation/credential-binding';
import {
  resolveCliApprovalRequester,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import {
  requestGrantApproval,
  grantStanding,
  revokeGrant,
  grantStatusAt,
  grantDaysLeft,
  requestGrantExtension,
  extendStandingGrant,
  GRANT_EXTENSION_GRACE_DAYS,
} from '@agent/core/governance/grant-store';
import { requireReasoningApiProvider } from '@agent/core/reasoning/reasoning-api-credentials';
import {
  assessCredentialBudget,
  CREDENTIAL_PLANS,
  CREDENTIAL_SERVICES,
  formatCredentialRef,
  lendingFromRecord,
  monthOf,
  parseCredentialRef,
  requireCredentialService,
  subscriptionTokenDaysLeft,
  summarizeCredentialUsage,
  type CredentialPlan,
  listCredentialAllocations,
  assertCredentialAllocation,
  readCredentialRecord,
  registerPersonCredentialRecord,
  registerTenantCredential,
  CREDENTIAL_USE_CAPABILITY,
} from '@agent/core/secret/credential-allocations';
import { resolveRevoker } from '../cli/cli-grants.js';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { ScriptExitError } from '../lib/harness.js';

export const ALLOCATION_ACTIONS = new Set([
  'assign',
  'allocations',
  'revoke',
  'check',
  'probe',
  'extend',
  'register',
  'usage',
]);

function planOf(value: string | undefined): CredentialPlan | undefined {
  if (value === undefined) return undefined;
  if (!(CREDENTIAL_PLANS as readonly string[]).includes(value))
    throw new ScriptExitError(2, `--plan must be one of ${CREDENTIAL_PLANS.join('|')}.`);
  return value as CredentialPlan;
}

/**
 * `register` (design §7): person custody delegates to the governed personal
 * secret introduction (approval + keychain + knowledge/personal/connections);
 * tenant custody writes the owner tenant's connection through the broker's
 * exact write capability. The value is read hidden or from --from-file, never argv.
 */
async function registerCredential(
  values: Record<string, string | boolean | undefined>,
  print: (s: string) => void
): Promise<number> {
  const custody = values.custody;
  const service = String(values.service ?? '');
  if (custody !== 'person' && custody !== 'tenant')
    throw new ScriptExitError(2, '--custody person|tenant is required.');
  if (!Object.hasOwn(CREDENTIAL_SERVICES, service))
    throw new ScriptExitError(
      2,
      `--service must be one of ${Object.keys(CREDENTIAL_SERVICES).join('|')}.`
    );
  const spec = requireCredentialService(service);
  const label = typeof values.label === 'string' ? values.label : undefined;
  const plan = planOf(values.plan as string | undefined);
  // The loopback owner lives in knowledge/personal/members/: read it under the
  // same execution context organization_member uses, or the caller is unknown
  // and every owner-gated register fails with [CREDENTIAL_OWNER_REQUIRED].
  const operator = withExecutionContext('sovereign_concierge', () =>
    resolveCliOperatorIdentity()
  ).principalId;
  const fromFile = typeof values['from-file'] === 'string' ? values['from-file'] : undefined;
  const tokenExpiresAt = values['token-expires'] as string | undefined;
  const contractTenant = values['contract-tenant'] as string | undefined;
  const approval = typeof values.approval === 'string' ? values.approval : undefined;
  if (custody === 'person') {
    // Review S1: person custody is the installation person (owner of knowledge/personal/).
    const member = operator?.replace(/^user:/u, '');
    if (!member) throw new ScriptExitError(2, 'No installation person is configured.');
    const credentialRef = formatCredentialRef({
      custody,
      owner: member,
      service,
      ...(label ? { label } : {}),
    });
    const { runSecretCli } = await import('../secret/secret_introduce.js');
    const result = await runSecretCli(
      [
        'introduce',
        `${service}${label ? `.${label}` : ''}`,
        spec.secretKey,
        '--json',
        ...(fromFile ? ['--from-file', fromFile] : []),
      ],
      { print: () => undefined }
    );
    if (result.phase !== 'applied') {
      print(
        JSON.stringify({
          status: result.status,
          credential_ref: credentialRef,
          ...(result.next ? { next: [result.next] } : {}),
          then: 'Re-run this register command after the value is applied to write its record.',
        })
      );
      return 0;
    }
    // The registered record (terms + value fingerprint) is the only source of lending terms.
    const record = registerPersonCredentialRecord({
      credentialRef,
      plan,
      tokenExpiresAt,
      contractTenant,
      registeredBy: operator ?? '',
    });
    print(
      JSON.stringify({
        status: 'registered',
        credential_ref: credentialRef,
        kind: record.kind,
        plan: record.plan,
        ...(record.token_expires_at ? { token_expires_at: record.token_expires_at } : {}),
        value_fingerprint: record.value_fingerprint,
        assign: `pnpm kyberion reasoning credentials assign --tenant <borrower> --credential ${credentialRef} --backends ${spec.backends.join(',')} --purpose "<why>"`,
      })
    );
    return 0;
  }
  const owner = typeof values.owner === 'string' ? values.owner : '';
  const credentialRef = (() => {
    try {
      return formatCredentialRef(
        parseCredentialRef(`tenant:${owner}:${service}${label ? `:${label}` : ''}`)
      );
    } catch (error) {
      throw new ScriptExitError(2, error instanceof Error ? error.message : String(error));
    }
  })();
  const { collectSecret } = await import('../secret/secret_introduce.js');
  const value = await collectSecret(fromFile ? { 'from-file': fromFile } : {});
  const stored = registerTenantCredential({
    credentialRef,
    value,
    plan,
    tokenExpiresAt,
    contractTenant,
    registeredBy: operator ?? '',
    requester: resolveCliApprovalRequester({ legacy: 'operator' }),
    ...(approval ? { approvalRequestId: approval } : {}),
  });
  print(
    JSON.stringify({
      ...stored,
      value: 'not printed',
      ...(stored.status === 'approval_required'
        ? {
            next: [`pnpm kyberion approvals --approve ${stored.approval_id}`],
            apply: `Repeat the same register options (same value)${stored.token_expires_at ? ` with --token-expires ${stored.token_expires_at}` : ''} and --approval <approval_id>.`,
          }
        : {
            assign: `pnpm kyberion reasoning credentials assign --tenant <borrower> --credential ${credentialRef} --backends ${spec.backends.join(',')} --purpose "<why>"`,
          }),
    })
  );
  return 0;
}
export async function runCredentialAllocationCommand(
  args: string[],
  print: (s: string) => void
): Promise<number> {
  const action = args[0];
  const { values } = parseArgs({
    args: args.slice(1).filter((s) => s !== '--'),
    strict: true,
    options: {
      provider: { type: 'string' },
      tenant: { type: 'string' },
      purpose: { type: 'string' },
      days: { type: 'string' },
      approval: { type: 'string' },
      grant: { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      mission: { type: 'string' },
      model: { type: 'string' },
      'allow-paid': { type: 'boolean' },
      credential: { type: 'string' },
      backends: { type: 'string' },
      'budget-usd': { type: 'string' },
      plan: { type: 'string' },
      'token-expires': { type: 'string' },
      'contract-tenant': { type: 'string' },
      custody: { type: 'string' },
      owner: { type: 'string' },
      service: { type: 'string' },
      label: { type: 'string' },
      'from-file': { type: 'string' },
      month: { type: 'string' },
    },
  });
  if (action === 'register') {
    const allowedRegister = [
      'approval',
      'contract-tenant',
      'custody',
      'owner',
      'service',
      'label',
      'plan',
      'token-expires',
      'from-file',
      'json',
      'quiet',
    ];
    if (Object.keys(values).some((k) => !allowedRegister.includes(k)))
      throw new ScriptExitError(2, 'Option not supported for this action.');
    return registerCredential(values, print);
  }
  const tenant = values.tenant;
  if (!tenant || !/^[a-z][a-z0-9-]{1,30}$/.test(tenant))
    throw new ScriptExitError(2, 'A valid --tenant is required.');
  const identity = credentialExecutionIdentity();
  if (identity.tenantSlug && identity.tenantSlug !== tenant)
    throw new ScriptExitError(
      1,
      'Cross-tenant allocation administration is denied. Select the intended operator/tenant scope first.'
    );
  const allowed =
    action === 'assign'
      ? [
          'provider',
          'credential',
          'backends',
          'budget-usd',
          'plan',
          'token-expires',
          'contract-tenant',
          'tenant',
          'purpose',
          'days',
          'approval',
          'json',
          'quiet',
        ]
      : action === 'usage'
        ? ['tenant', 'month', 'json', 'quiet']
        : action === 'probe'
          ? ['tenant', 'provider', 'mission', 'model', 'allow-paid', 'json', 'quiet']
          : action === 'revoke'
            ? ['tenant', 'grant', 'reason', 'json', 'quiet']
            : action === 'extend'
              ? ['tenant', 'grant', 'days', 'approval', 'json', 'quiet']
              : ['tenant', 'provider', 'json', 'quiet'];
  if (Object.keys(values).some((k) => !allowed.includes(k)))
    throw new ScriptExitError(2, 'Option not supported for this action.');
  if (action === 'probe') {
    const { probeAllocatedCredential } = await import('./reasoning_credential_probe.js');
    if (!values.provider || !values.mission || !values.model)
      throw new ScriptExitError(2, 'Probe requires --provider, --tenant, --mission and --model.');
    if (!values['allow-paid'])
      throw new ScriptExitError(2, 'Probe requires --allow-paid; a small API charge is possible.');
    const result = await probeAllocatedCredential({
      tenant,
      provider: values.provider,
      mission: values.mission,
      model: values.model,
      allowPaid: values['allow-paid'] === true,
    });
    print(JSON.stringify(result));
    return result.proof?.status === 'success' ? 0 : 1;
  }
  return await (async () => {
    if (action === 'assign') {
      const profile = withStoreGrant(
        'workspace_tenant_registry_reader',
        () => readTenantProfile(tenant),
        { tenantSlug: tenant }
      );
      if (!profile || profile.status !== 'active')
        throw new ScriptExitError(2, 'An existing active tenant is required.');
      if (!values.purpose) throw new ScriptExitError(2, '--purpose is required.');
      if (values.credential && values.provider)
        throw new ScriptExitError(2, 'Use either --credential or --provider, not both.');
      let provider: string;
      let draft: Parameters<typeof requestGrantApproval>[0];
      if (values.credential) {
        // Design §2.2 / review S2: lending terms come from the REGISTERED record;
        // --plan / --token-expires / --contract-tenant are consistency checks only.
        let lending;
        try {
          const record = readCredentialRecord(tenant, values.credential);
          lending = lendingFromRecord(record, {
            backends: values.backends
              ?.split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
            budgetMonthlyUsd:
              values['budget-usd'] !== undefined ? Number(values['budget-usd']) : undefined,
            expect: {
              ...(values.plan ? { plan: values.plan } : {}),
              ...(values['token-expires'] ? { tokenExpiresAt: values['token-expires'] } : {}),
              ...(values['contract-tenant'] ? { contractTenant: values['contract-tenant'] } : {}),
            },
          });
        } catch (error) {
          throw new ScriptExitError(2, error instanceof Error ? error.message : String(error));
        }
        const spec = requireCredentialService(lending.service);
        provider = spec.primaryBackend;
        draft = {
          capability: CREDENTIAL_USE_CAPABILITY,
          tenant_slug: tenant,
          credential_provider: provider,
          credential_ref: `${spec.service}/${spec.secretKey}`,
          credential_lending: lending,
          purpose: values.purpose,
          ...(values.days ? { ttl_days: Number(values.days) } : {}),
        };
      } else {
        if (values.backends || values['budget-usd'] || values.plan || values['token-expires'])
          throw new ScriptExitError(
            2,
            '--backends/--budget-usd/--plan/--token-expires need --credential.'
          );
        provider = requireReasoningApiProvider(values.provider ?? '').mode;
        const reference = requireReasoningApiProvider(provider).secret_refs![0]!;
        draft = {
          capability: CREDENTIAL_USE_CAPABILITY,
          tenant_slug: tenant,
          credential_provider: provider,
          purpose: values.purpose,
          credential_ref: `${reference.service_id}/${reference.secret_key}`,
          ...(values.days ? { ttl_days: Number(values.days) } : {}),
        };
      }
      const request = values.approval
        ? undefined
        : requestGrantApproval(draft, {
            requester: resolveCliApprovalRequester({ legacy: 'operator' }),
          });
      const approvalRequestId =
        values.approval ?? (request?.status === 'approved' ? request.id : undefined);
      if (approvalRequestId) {
        const grant = grantStanding(draft, { approvalRequestId });
        print(
          JSON.stringify({
            status: 'allocated',
            grant_id: grant.grant_id,
            tenant,
            provider,
            ...(draft.credential_lending
              ? { credential_ref: draft.credential_lending.credential_ref }
              : {}),
            expires_at: grant.expires_at,
          })
        );
      } else if (request) {
        print(
          JSON.stringify({
            status: 'approval_required',
            approval_id: request.id,
            tenant,
            provider,
            ...(draft.credential_lending
              ? {
                  credential_ref: draft.credential_lending.credential_ref,
                  approver:
                    draft.credential_lending.custody === 'person'
                      ? `user:${draft.credential_lending.owner}`
                      : `an owner of tenant ${draft.credential_lending.owner}`,
                }
              : {}),
            next: request.scope?.tenant_slug
              ? [
                  'Owner: open Concierge /inbox?reason=approval and review this approval ID.',
                  `Or, from an interactive Owner terminal in the request scope: pnpm kyberion approvals --approve ${request.id}`,
                ]
              : [
                  `pnpm scope use --tier confidential --tenant ${tenant}`,
                  `pnpm kyberion approvals --approve ${request.id}`,
                ],
            ...(!request.scope?.tenant_slug
              ? {
                  scope_note:
                    'Stash with scope push before changing scope, unless already stashed; restore with scope pop after the workflow.',
                }
              : {}),
            apply:
              'After human approval, rerun this assign command with the same options. The CLI applies the matching approved request.',
          })
        );
      }
      return 0;
    }
    if (action === 'extend') {
      // Same grant (id, principal, scope): only expires_at moves, by at most the
      // capability maximum from approval, after an owner approval of exactly this step.
      if (!values.grant) throw new ScriptExitError(2, '--grant is required.');
      const eligible = listCredentialAllocations(tenant).find((g) => g.grant_id === values.grant);
      if (!eligible) throw new ScriptExitError(1, 'Credential allocation not found.');
      if (values.days !== undefined && !/^\d+$/u.test(values.days))
        throw new ScriptExitError(2, '--days must be a positive integer.');
      const draft = {
        grant_id: values.grant,
        tenant_slug: tenant,
        ...(values.days ? { extend_days: Number(values.days) } : {}),
      };
      if (values.approval) {
        const grant = extendStandingGrant(draft, { approvalRequestId: values.approval });
        print(
          JSON.stringify({
            status: 'extended',
            grant_id: grant.grant_id,
            tenant,
            expires_at: grant.expires_at,
            days_left: grantDaysLeft(grant, new Date()),
          })
        );
      } else {
        const requester = resolveCliApprovalRequester({ legacy: 'operator' });
        const request = requestGrantExtension(draft, { requester });
        print(
          JSON.stringify({
            status: 'approval_required',
            approval_id: request.id,
            grant_id: values.grant,
            tenant,
            current_expires_at: eligible.expires_at,
            next: [`pnpm kyberion approvals --approve ${request.id}`],
            apply:
              'Repeat the same extend options with --approval <approval_id> after the owner approves.',
            grace: `An expired grant can be extended for ${GRANT_EXTENSION_GRACE_DAYS} days after expiry; a revoked one never.`,
          })
        );
      }
      return 0;
    }
    if (action === 'revoke') {
      if (!values.grant || !values.reason)
        throw new ScriptExitError(2, '--grant and --reason are required.');
      const eligible = listCredentialAllocations(tenant).find((g) => g.grant_id === values.grant);
      if (!eligible) throw new ScriptExitError(1, 'Credential allocation not found.');
      const grant = revokeGrant(values.grant, {
        tenant_slug: tenant,
        by: resolveRevoker(),
        reason: values.reason,
      });
      print(
        JSON.stringify({
          status: 'revoked',
          grant_id: grant.grant_id,
          effect:
            'New bindings and subsequent managed API sends are denied; in-flight calls are not cancelled.',
        })
      );
      return 0;
    }
    if (action === 'usage') {
      const month = values.month ?? monthOf(new Date());
      if (!/^\d{4}-\d{2}$/u.test(month)) throw new ScriptExitError(2, '--month must be YYYY-MM.');
      const now = new Date();
      const budgets = listCredentialAllocations(tenant)
        .filter((g) => g.scope.credential_lending?.budget_monthly_usd && !g.revoked)
        .map((g) => ({
          grant_id: g.grant_id,
          credential_ref: g.scope.credential_lending!.credential_ref,
          ...assessCredentialBudget(g.scope.credential_lending!, tenant, now),
        }));
      print(
        JSON.stringify({ tenant, month, usage: summarizeCredentialUsage(tenant, month), budgets })
      );
      return 0;
    }
    const provider = values.provider
      ? requireReasoningApiProvider(values.provider).mode
      : undefined;
    const grants = listCredentialAllocations(tenant).filter(
      (g) => !provider || g.scope.credential_provider === provider
    );
    const rows = grants.map((g) => ({
      grant_id: g.grant_id,
      provider: g.scope.credential_provider,
      credential_ref: g.scope.credential_lending?.credential_ref ?? g.scope.credential_ref,
      ...(g.scope.credential_lending
        ? {
            custody: g.scope.credential_lending.custody,
            kind: g.scope.credential_lending.kind,
            plan: g.scope.credential_lending.plan,
            backends: g.scope.credential_lending.allowed_backends,
            ...(g.scope.credential_lending.budget_monthly_usd !== undefined
              ? { budget_monthly_usd: g.scope.credential_lending.budget_monthly_usd }
              : {}),
            ...(g.scope.credential_lending.token_expires_at
              ? {
                  token_expires_at: g.scope.credential_lending.token_expires_at,
                  token_days_left: subscriptionTokenDaysLeft(
                    g.scope.credential_lending,
                    new Date()
                  ),
                }
              : {}),
          }
        : { custody: 'person', kind: 'api_key' }),
      status: grantStatusAt(g, new Date()),
      expires_at: g.expires_at,
      days_left: grantDaysLeft(g, new Date()),
      ...(g.extensions?.length ? { extensions: g.extensions.length } : {}),
      purpose: g.purpose,
    }));
    if (action === 'check') {
      if (!provider) throw new ScriptExitError(2, '--provider is required for check.');
      const active = grants.some((g) => {
        try {
          assertCredentialAllocation(tenant, g.grant_id, provider);
          return true;
        } catch {
          return false;
        }
      });
      print(
        JSON.stringify({
          tenant,
          provider,
          allocated: active,
          source: 'local-standing-grant',
          task_binding: 'created_only_by_claimed_task_dispatch',
          api_verification: 'not_checked',
        })
      );
      return active ? 0 : 1;
    }
    print(JSON.stringify({ tenant, allocations: rows }));
    return 0;
  })();
}
