import { withExecutionContext } from '@agent/core/authority';
import { listIdentityDirectory, showIdentity } from '@agent/core/organization/identity-directory';

const HELP = [
  'Usage: pnpm organization identity <list|show> [options]',
  '',
  'Unified human + NHI directory reader (ActorRef: human=user:<member_id>, agent/service=kyberion://agent/<org>/<slug>).',
  'Writes stay on existing governed verbs (member link-identity, mission team/staff/restaff,',
  'onboarding company, tenant activation probe) — this command never writes the ledger.',
  'organization_id filters NHI only (memberships are tenant-scoped); orphan=true means reassignment needed.',
  '',
  '  list [--organization-id <id>] [--tenant-slug <slug>] [--kind human|agent|service] [--include-retired] [--json]',
  '  show --actor <user:<member_id>|kyberion://agent/<org>/<slug>> [--json]',
  'Empty list ([]) means no match; show throws identity not found.',
].join('\n');

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} requires a value`);
  return v.trim();
}

export async function runOrganizationIdentity(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === '--help' || cmd === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (cmd === 'list') {
    const kind = flag(rest, '--kind');
    if (kind && kind !== 'human' && kind !== 'agent' && kind !== 'service') {
      throw new Error(`--kind must be human|agent|service (got '${kind}')`);
    }
    const result = withExecutionContext('sovereign_concierge', () =>
      listIdentityDirectory({
        organization_id: flag(rest, '--organization-id'),
        tenant_slug: flag(rest, '--tenant-slug'),
        kind: (kind as 'human' | 'agent' | 'service' | undefined) ?? undefined,
        includeRetired: rest.includes('--include-retired'),
      })
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (cmd === 'show') {
    const actor = flag(rest, '--actor') ?? rest.find((a) => !a.startsWith('--'));
    if (!actor)
      throw new Error('show requires --actor <user:<member_id>|kyberion://agent/<org>/<slug>>');
    const result = withExecutionContext('sovereign_concierge', () => showIdentity(actor));
    if (!result) throw new Error(`identity not found: ${actor}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(`unknown identity command '${cmd}'`);
}
