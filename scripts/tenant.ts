import {
  attestTenantProvider,
  captureAttestationInvoker,
  providerAttestationApplyArgs,
  requestTenantProviderAttestationApproval,
  shellQuoteArg,
  type AttestTenantProviderInput,
  mutateTenant,
  type TenantLifecycleVerb,
  listTenants,
} from '@agent/core/organization/tenant-governance';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { withExecutionContext } from '@agent/core/authority';
import { defineScript, isDirectScript } from './lib/harness.js';

type Args = {
  command:
    | 'create'
    | 'update'
    | 'suspend'
    | 'resume'
    | 'archive'
    | 'list'
    | 'show'
    | 'attest-provider'
    | 'help';
  slug?: string;
  displayName?: string;
  assignedRole?: string;
  knowledgeRoot?: string;
  provider?: string;
  trainingUse?: string;
  plan?: string;
  basis?: string;
  attestedBy?: string;
  validForDays?: number;
  apply: boolean;
  accept: boolean;
  requestApproval: boolean;
  approvalRequestId?: string;
  json: boolean;
};

type Print = (value: unknown) => void;

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const result: Args = {
    command: ([
      'create',
      'update',
      'suspend',
      'resume',
      'archive',
      'list',
      'show',
      'attest-provider',
    ].includes(command)
      ? command
      : 'help') as Args['command'],
    apply: false,
    accept: false,
    requestApproval: false,
    json: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--accept') result.accept = true;
    else if (arg === '--request-approval') result.requestApproval = true;
    else if (arg === '--approval-request-id') result.approvalRequestId = rest[++i];
    else if (arg === '--json') result.json = true;
    else if (arg === '--slug' || arg === '--tenant') result.slug = rest[++i];
    else if (arg === '--display-name') result.displayName = rest[++i];
    else if (arg === '--assigned-role') result.assignedRole = rest[++i];
    else if (arg === '--knowledge-root') result.knowledgeRoot = rest[++i];
    else if (arg === '--provider') result.provider = rest[++i];
    else if (arg === '--training-use') result.trainingUse = rest[++i];
    else if (arg === '--plan') result.plan = rest[++i];
    else if (arg === '--basis') result.basis = rest[++i];
    else if (arg === '--attested-by') result.attestedBy = rest[++i];
    else if (arg === '--valid-for-days') result.validForDays = Number(rest[++i]);
    else if (!arg.startsWith('--') && !result.slug) result.slug = arg;
  }
  return result;
}

function usage(): string {
  return [
    'Usage: pnpm tenant <create|update|suspend|resume|archive|list|show|attest-provider> [slug] [options]',
    '  attest-provider records how this installation is contracted with a provider:',
    '    --provider <id> --training-use <none|used|unknown> [--plan <text>] [--basis <url|ref>]',
    '    [--attested-by <who>] [--valid-for-days <n>]   (none requires all three evidence fields)',
    '    Writes only with --apply --accept (--accept is your statement about the plan terms);',
    '    otherwise it is a dry-run. training_use none opens confidential egress, so it also',
    '    needs a human approval: --request-approval opens it, a human runs',
    '    pnpm kyberion approvals --approve <id>, then re-run with',
    '    --apply --accept --approval-request-id <id>. used/unknown need no approval.',
    '  Attestations are written to the tenant profile under knowledge/personal/, which is',
    '  outside git: a contract is a fact about your account, not about the project.',
    '  The provider must be declared in provider-egress-policy.json; every attestation is',
    '  written to the audit chain (tenant.attest_provider). Onboarding equivalent:',
    '  pnpm onboarding llm attest.',
    '  create/update require --apply to write; without it they are dry-run only.',
    '  --display-name <text> --assigned-role <role> --knowledge-root <repo-relative-path>',
    '  --json',
  ].join('\n');
}

export function main(
  argv: string[] = [],
  print: Print = () => undefined,
  options: { rootDir?: string } = {}
): void {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    print(usage());
    return;
  }
  if (args.command === 'list') {
    print(JSON.stringify(listTenants(), null, 2));
    return;
  }
  if (!args.slug) throw new Error(`${args.command} requires a tenant slug`);
  if (args.command === 'show') {
    const profile = readTenantProfile(args.slug);
    if (!profile) throw new Error(`Tenant '${args.slug}' does not exist.`);
    print(
      args.json ? JSON.stringify(profile, null, 2) : `${profile.tenant_slug}: ${profile.status}`
    );
    return;
  }
  if (args.command === 'attest-provider') {
    if (!args.provider) throw new Error('attest-provider requires --provider');
    const trainingUse = args.trainingUse;
    if (trainingUse !== 'none' && trainingUse !== 'used' && trainingUse !== 'unknown') {
      throw new Error('attest-provider requires --training-use <none|used|unknown>');
    }
    if (trainingUse === 'none') {
      const missing = [
        !args.plan?.trim() ? '--plan' : '',
        !args.basis?.trim() ? '--basis' : '',
        !args.attestedBy?.trim() ? '--attested-by' : '',
      ].filter(Boolean);
      if (missing.length > 0) {
        throw new Error(
          `attest-provider --training-use none requires ${missing.join(', ')} for evidence and attribution`
        );
      }
    }
    if (
      args.validForDays !== undefined &&
      (!Number.isFinite(args.validForDays) || args.validForDays <= 0)
    ) {
      throw new Error('attest-provider requires --valid-for-days to be a finite positive number');
    }
    if (args.apply && !args.accept) {
      throw new Error(
        'attest-provider --apply requires --accept: the attestation is your statement about the plan’s training-use terms'
      );
    }
    // --request-approval opens the approval request; it is not a dry-run.
    if (!args.apply && !args.requestApproval) {
      print(
        JSON.stringify(
          {
            dryRun: true,
            slug: args.slug,
            provider: args.provider,
            training_use: trainingUse,
            ...(trainingUse === 'none' && !args.approvalRequestId
              ? { needs_approval: 'run with --request-approval first' }
              : {}),
          },
          null,
          2
        )
      );
      return;
    }
    // Capture who asked (and their tenant binding) before elevating.
    const invoker = captureAttestationInvoker();
    const attestInput: AttestTenantProviderInput = {
      invoker,
      slug: args.slug!,
      provider: args.provider!,
      training_use: trainingUse,
      ...(args.plan ? { plan: args.plan } : {}),
      ...(args.basis ? { basis: args.basis } : {}),
      ...(args.attestedBy ? { attested_by: args.attestedBy } : {}),
      ...(typeof args.validForDays === 'number' ? { valid_for_days: args.validForDays } : {}),
      ...(options.rootDir ? { rootDir: options.rootDir } : {}),
      ...(args.approvalRequestId ? { approvalRequestId: args.approvalRequestId } : {}),
    };
    if (args.requestApproval) {
      const request = withExecutionContext(
        'sovereign_concierge',
        () => requestTenantProviderAttestationApproval(attestInput),
        undefined,
        args.slug
      );
      print(
        JSON.stringify(
          {
            ...request,
            next: [
              `A human decides: ${request.approve_command}`,
              `Then apply: ${[
                'pnpm',
                'tenant',
                'attest-provider',
                args.slug!,
                ...providerAttestationApplyArgs(attestInput, request.request_id),
              ]
                .map(shellQuoteArg)
                .join(' ')}`,
            ],
          },
          null,
          2
        )
      );
      return;
    }
    const result = withExecutionContext(
      'sovereign_concierge',
      () => attestTenantProvider(attestInput),
      undefined,
      args.slug
    );
    print(JSON.stringify(result.attestation, null, 2));
    return;
  }
  const result = withExecutionContext('sovereign_concierge', () =>
    mutateTenant({
      verb: args.command as TenantLifecycleVerb,
      slug: args.slug!,
      displayName: args.displayName,
      assignedRole: args.assignedRole,
      knowledgeRoot: args.knowledgeRoot,
      apply: args.apply,
    })
  );
  print(JSON.stringify(result, null, 2));
}

const script = defineScript({
  name: 'tenant',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (isDirectScript(import.meta.url, 'tenant.ts') || isDirectScript(import.meta.url, 'tenant.js')) {
  void script();
}
