import { parseArgs } from 'node:util';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { credentialExecutionIdentity } from '@agent/core/foundation/credential-binding';
import { resolveCliApprovalRequester } from '@agent/core/governance/cli-operator-principal';
import {
  requestGrantApproval,
  grantStanding,
  revokeGrant,
  grantStatusAt,
} from '@agent/core/governance/grant-store';
import { requireReasoningApiProvider } from '@agent/core/reasoning/reasoning-api-credentials';
import {
  listCredentialAllocations,
  assertCredentialAllocation,
  CREDENTIAL_USE_CAPABILITY,
} from '@agent/core/secret/credential-allocations';
import { resolveRevoker } from './cli-grants.js';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { ScriptExitError } from './lib/harness.js';

export const ALLOCATION_ACTIONS = new Set(['assign', 'allocations', 'revoke', 'check', 'probe']);
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
    },
  });
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
      ? ['provider', 'tenant', 'purpose', 'days', 'approval', 'json', 'quiet']
      : action === 'probe'
        ? ['tenant', 'provider', 'mission', 'model', 'allow-paid', 'json', 'quiet']
        : action === 'revoke'
          ? ['tenant', 'grant', 'reason', 'json', 'quiet']
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
  return withExecutionContextAsync(
    'credential_allocation_manager',
    async () => {
      if (action === 'assign') {
        const profile = withExecutionContext(
          'workspace_tenant_registry_reader',
          () => readTenantProfile(tenant),
          undefined,
          tenant
        );
        if (!profile || profile.status !== 'active')
          throw new ScriptExitError(2, 'An existing active tenant is required.');
        const provider = requireReasoningApiProvider(values.provider ?? '').mode;
        const reference = requireReasoningApiProvider(provider).secret_refs![0]!;
        if (!values.purpose) throw new ScriptExitError(2, '--purpose is required.');
        const draft = {
          capability: CREDENTIAL_USE_CAPABILITY,
          tenant_slug: tenant,
          credential_provider: provider,
          purpose: values.purpose,
          credential_ref: `${reference.service_id}/${reference.secret_key}`,
          ...(values.days ? { ttl_days: Number(values.days) } : {}),
        };
        if (values.approval) {
          const grant = grantStanding(draft, { approvalRequestId: values.approval });
          print(
            JSON.stringify({
              status: 'allocated',
              grant_id: grant.grant_id,
              tenant,
              provider,
              expires_at: grant.expires_at,
            })
          );
        } else {
          const requester = resolveCliApprovalRequester({ legacy: 'operator' });
          const request = requestGrantApproval(draft, { requester });
          print(
            JSON.stringify({
              status: 'approval_required',
              approval_id: request.id,
              tenant,
              provider,
              next: [
                `pnpm scope use --tier confidential --tenant ${tenant}`,
                `pnpm kyberion approvals --approve ${request.id}`,
              ],
              scope_note:
                'Stash with scope push before changing scope, unless already stashed; restore with scope pop after the workflow.',
              apply:
                'Repeat the same assign options with --approval <approval_id> after human approval.',
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
      const provider = values.provider
        ? requireReasoningApiProvider(values.provider).mode
        : undefined;
      const grants = listCredentialAllocations(tenant).filter(
        (g) => !provider || g.scope.credential_provider === provider
      );
      const rows = grants.map((g) => ({
        grant_id: g.grant_id,
        provider: g.scope.credential_provider,
        credential_ref: g.scope.credential_ref,
        status: grantStatusAt(g, new Date()),
        expires_at: g.expires_at,
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
    },
    undefined,
    tenant,
    undefined,
    { missionId: identity.missionId ?? null, taskId: identity.taskId ?? null }
  );
}
