import {
  listTenants,
  mutateTenant,
  readTenantProfile,
  type TenantLifecycleVerb,
} from '@agent/core';
import { defineScript } from './lib/harness.js';

type Args = {
  command: 'create' | 'update' | 'suspend' | 'resume' | 'archive' | 'list' | 'show' | 'help';
  slug?: string;
  displayName?: string;
  assignedRole?: string;
  knowledgeRoot?: string;
  apply: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const result: Args = {
    command: (['create', 'update', 'suspend', 'resume', 'archive', 'list', 'show'].includes(command)
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
    else if (!arg.startsWith('--') && !result.slug) result.slug = arg;
  }
  return result;
}

function usage(): string {
  return [
    'Usage: pnpm tenant <create|update|suspend|resume|archive|list|show> [slug] [options]',
    '  create/update require --apply to write; without it they are dry-run only.',
    '  --display-name <text> --assigned-role <role> --knowledge-root <repo-relative-path>',
    '  --json',
  ].join('\n');
}

export function main(argv: string[] = []): void {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    console.log(usage());
    return;
  }
  if (args.command === 'list') {
    console.log(JSON.stringify(listTenants(), null, 2));
    return;
  }
  if (!args.slug) throw new Error(`${args.command} requires a tenant slug`);
  if (args.command === 'show') {
    const profile = readTenantProfile(args.slug);
    if (!profile) throw new Error(`Tenant '${args.slug}' does not exist.`);
    console.log(
      args.json ? JSON.stringify(profile, null, 2) : `${profile.tenant_slug}: ${profile.status}`
    );
    return;
  }
  const result = mutateTenant({
    verb: args.command as TenantLifecycleVerb,
    slug: args.slug,
    displayName: args.displayName,
    assignedRole: args.assignedRole,
    knowledgeRoot: args.knowledgeRoot,
    apply: args.apply,
  });
  console.log(JSON.stringify(result, null, 2));
}

void defineScript({
  name: 'tenant',
  flags: [],
  run: ({ argv }) => main(argv),
})();
