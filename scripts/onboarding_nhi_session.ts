/** NHI session-admission ceremony CLI.
 *
 *   pnpm onboarding nhi-session request --tenant <slug> --nhi <nhi_id> [--ttl-hours N]
 *   pnpm onboarding nhi-session status  --tenant <slug> --request-id <id>
 *   pnpm onboarding nhi-session apply   --tenant <slug> --request-id <id>
 *   pnpm onboarding nhi-session revoke  --tenant <slug> --nhi <nhi_id> [--instance <id>|--session <id>]
 *   pnpm onboarding nhi-session list    [--tenant <slug>]
 *
 * A human-approved admission binds a session token to an organization NHI in
 * the governed agent-identity journal. Export the printed env pair
 * (KYBERION_NHI_ACTOR + KYBERION_NHI_SESSION) so this session's delegated
 * external operations run under the admitted NHI instead of a bare
 * `pipeline:<hash>` actor.
 */
import { createStandardYargs } from '@agent/core/cli-utils';
import { withExecutionContext } from '@agent/core/authority';
import { ensureOwnerMember } from '@agent/core/organization/member-registry';
import {
  resolveCliApprovalRequester,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import {
  applyNhiSessionAdmission,
  listNhiSessionAdmissions,
  nhiSessionAdmissionStatus,
  NHI_SESSION_ENV,
  requestNhiSessionAdmission,
  revokeNhiSessionAdmission,
  type NhiSessionAdmissionPrincipal,
} from '@agent/core/organization/nhi-session-admission';
import { defineScript, isDirectScript } from './lib/harness.js';
import { inspectInstalledIdentity, canonicalAuthorityCommand } from './lib/installed-identity.js';

export async function main(
  argv: string[],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const args = await createStandardYargs([process.execPath, 'onboarding_nhi_session.ts', ...argv])
    .scriptName('pnpm onboarding nhi-session')
    .command('$0 <action>', 'Manage NHI session admission', (y) =>
      y.positional('action', {
        choices: ['request', 'status', 'apply', 'revoke', 'list'] as const,
        demandOption: true,
      })
    )
    .option('tenant', { type: 'string', description: 'Tenant slug (org scope)' })
    .option('nhi', { type: 'string', description: 'Canonical nhi_id to admit' })
    .option('request-id', { type: 'string' })
    .option('ttl-hours', { type: 'number' })
    .option('instance', { type: 'string', description: 'Bound instance_id (revoke)' })
    .option('session', { type: 'string', description: 'Bound session_id (revoke)' })
    .option('provider', { type: 'string', description: 'Execution backend label for audit' })
    .option('model', { type: 'string', description: 'Model label for audit' })
    .option('json', { type: 'boolean', default: false })
    .strict()
    .parse();
  const installed = inspectInstalledIdentity();
  if (installed.source === 'unavailable') throw new Error(installed.next);
  if (installed.source === 'installation') {
    throw new Error(
      `NHI session admission is managed at ${installed.governance_root}. Run there with the same explicit tenant: ${canonicalAuthorityCommand(installed.governance_root, argv)}.`
    );
  }
  const result = withExecutionContext('sovereign_concierge', () => {
    ensureOwnerMember();
    const owner = resolveCliOperatorIdentity();
    if (!owner.principalId) throw new Error('Registered operator identity required.');
    const requester = resolveCliApprovalRequester({ legacy: 'onboarding-nhi-session' });
    const principal: NhiSessionAdmissionPrincipal = {
      requesterId: requester.actorId,
      accountableId: owner.principalId,
      tenantSlugs: 'all',
    };
    const tenant = args.tenant?.trim();
    switch (args.action) {
      case 'list': {
        const admissions = listNhiSessionAdmissions(tenant ? { tenant_slug: tenant } : {}).map(
          (entry) => ({
            nhi_id: entry.nhi_id,
            lifecycle_status: entry.lifecycle_status,
            instance_id: entry.instance.instance_id,
            session_id: entry.instance.session_id
              ? `${entry.instance.session_id.slice(0, 13)}…`
              : undefined,
            bound_at: entry.instance.bound_at,
            expires_at: entry.instance.expires_at,
            provider: entry.instance.provider,
            expired: entry.expired,
          })
        );
        return { ok: true as const, admissions };
      }
      case 'request': {
        if (!tenant || !args.nhi) throw new Error('--tenant and --nhi are required.');
        const outcome = requestNhiSessionAdmission(principal, {
          nhi_id: args.nhi.trim(),
          tenant_slug: tenant,
          ...(args.ttlHours ? { ttl_seconds: Math.round(args.ttlHours * 3600) } : {}),
        });
        return {
          ...outcome,
          next: `Approve in a human terminal: pnpm kyberion approvals --approve ${outcome.request_id} — or open ${outcome.approval_url} in the concierge (passkey). Then: pnpm onboarding nhi-session apply --tenant ${tenant} --request-id ${outcome.request_id}`,
        };
      }
      case 'status': {
        if (!tenant || !args.requestId) throw new Error('--tenant and --request-id are required.');
        return nhiSessionAdmissionStatus(principal, tenant, args.requestId);
      }
      case 'apply': {
        if (!tenant || !args.requestId) throw new Error('--tenant and --request-id are required.');
        const outcome = applyNhiSessionAdmission(principal, tenant, args.requestId, {
          ...(args.provider ? { provider: args.provider } : {}),
          ...(args.model ? { modelId: args.model } : {}),
        });
        return {
          ...outcome,
          next:
            'Export for this session: ' +
            `KYBERION_NHI_ACTOR=${outcome.nhi_id} ${NHI_SESSION_ENV}=${outcome.session_id} ` +
            `(valid until ${outcome.expires_at})`,
        };
      }
      case 'revoke': {
        if (!tenant || !args.nhi) throw new Error('--tenant and --nhi are required.');
        const record = revokeNhiSessionAdmission(principal, {
          nhi_id: args.nhi.trim(),
          tenant_slug: tenant,
          ...(args.instance ? { instance_id: args.instance } : {}),
          ...(args.session ? { session_id: args.session } : {}),
        });
        return { ok: true as const, nhi_id: record?.nhi_id, released: true };
      }
      default:
        throw new Error(`Unknown action: ${args.action}`);
    }
  });
  print(args.json ? JSON.stringify(result, null, 2) : result);
}

const script = defineScript({
  name: 'onboarding-nhi-session',
  flags: ['json'],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'onboarding_nhi_session.ts') ||
  isDirectScript(import.meta.url, 'onboarding_nhi_session.js')
)
  void script();
