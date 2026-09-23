import { mutateTenant, type TenantLifecycleVerb, listTenants } from '@agent/core/tenant-governance';
import { readTenantProfile, recordTenantProviderAttestation } from '@agent/core/tenant-registry';
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
    json: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--apply') result.apply = true;
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
    '    [--attested-by <who>] [--valid-for-days <n>]   (none requires all three evidence fields; --apply)',
    '  Attestations are written to the tenant profile under knowledge/personal/, which is',
    '  outside git: a contract is a fact about your account, not about the project.',
    '  create/update require --apply to write; without it they are dry-run only.',
    '  --display-name <text> --assigned-role <role> --knowledge-root <repo-relative-path>',
    '  --json',
  ].join('\n');
}

export function main(argv: string[] = [], print: Print = () => undefined): void {
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
    if (!args.apply) {
      print(
        JSON.stringify(
          { dryRun: true, slug: args.slug, provider: args.provider, training_use: trainingUse },
          null,
          2
        )
      );
      return;
    }
    const profile = withExecutionContext('sovereign_concierge', () =>
      recordTenantProviderAttestation({
        slug: args.slug!,
        provider: args.provider!,
        training_use: trainingUse,
        ...(args.plan ? { plan: args.plan } : {}),
        ...(args.basis ? { basis: args.basis } : {}),
        ...(args.attestedBy ? { attested_by: args.attestedBy } : {}),
        ...(typeof args.validForDays === 'number' ? { valid_for_days: args.validForDays } : {}),
      })
    );
    print(JSON.stringify(profile.provider_attestations?.[args.provider], null, 2));
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
