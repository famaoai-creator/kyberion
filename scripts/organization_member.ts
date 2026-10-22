import { withExecutionContext } from '@agent/core/governance';
import { auditChain } from '@agent/core/governance/audit-chain';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { ensureOwnerMember } from '@agent/core/organization/member-registry';
import type { MemberRole } from '@agent/core/organization/member-registry';
import {
  createManagedMember,
  listManagedMembers,
  updateManagedMember,
} from '@agent/core/organization/member-management';
import { resolveCliOperatorIdentity } from '@agent/core/governance/cli-operator-principal';
import { resolveScopeContext } from '@agent/core/scope-context';
import { CHANNEL_IDENTITY_ISSUERS } from '@agent/core/surface/channel-speaker-principal';

type Print = (value: string) => void;

const HELP = [
  'Usage: pnpm organization member <link-identity|unlink-identity> <member-id> [options]',
  '       pnpm organization member ensure-owner',
  '       pnpm organization member list|show [<member-id>] --tenant <slug>',
  '       pnpm organization member create <member-id> --name <name> --tenant <slug> --role <owner|approver|operator|viewer> --apply',
  '       pnpm organization member update <member-id> --name <name> --apply',
  '       pnpm organization member grant|revoke <member-id> --tenant <slug> [--role <role>] --apply',
  '       pnpm organization member suspend|resume <member-id> --apply',
  '       Existing member changes accept --expected-version from list/show.',
  '',
  'Links a chat or IdP identity to an existing member (knowledge/personal/members/).',
  'Team channels resolve the speaker through this link (Team Channel P1).',
  '',
  'ensure-owner provisions the local owner member (idempotent). The terminal records',
  'approvals as this member (user:owner), so separation of duties can tell who acted.',
  '',
  'Options:',
  '  --slack <user-id>        Slack user id (issuer https://slack.com)',
  '  --issuer <iss>           Generic issuer (with --subject)',
  '  --subject <sub>          Generic subject',
  '  --email <email>          Optional email recorded with the identity',
].join('\n');

interface MemberCommand {
  action: 'link-identity' | 'unlink-identity';
  memberId: string;
  issuer: string;
  subject: string;
  email?: string;
}
interface ManagedMemberCommand {
  kind: 'managed';
  action: 'list' | 'show' | 'create' | 'update' | 'grant' | 'revoke' | 'suspend' | 'resume';
  memberId?: string;
  tenantSlug?: string;
  displayName?: string;
  role?: string;
  expectedVersion?: string;
  apply: boolean;
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value.trim();
}

export function parseMemberCommand(
  args: string[]
): MemberCommand | ManagedMemberCommand | { action: 'ensure-owner' } | null {
  const [action, memberId, ...rest] = args;
  if (!action || action === '--help' || action === 'help') return null;
  if (action === 'ensure-owner') return { action };
  if (
    ['list', 'show', 'create', 'update', 'grant', 'revoke', 'suspend', 'resume'].includes(action)
  ) {
    const flags = action === 'list' ? args.slice(1) : rest;
    if (action !== 'list' && (!memberId || memberId.startsWith('--')))
      throw new Error('member id is required');
    const allowed = new Set([
      '--tenant',
      '--tenant-slug',
      '--name',
      '--display-name',
      '--role',
      '--expected-version',
      '--apply',
      '--json',
    ]);
    for (let i = 0; i < flags.length; i++) {
      if (!allowed.has(flags[i])) throw new Error(`unknown member option '${flags[i]}'`);
      if (!['--apply', '--json'].includes(flags[i])) {
        readFlag(flags, flags[i]);
        i++;
      }
    }
    return {
      kind: 'managed',
      action: action as ManagedMemberCommand['action'],
      ...(action !== 'list' ? { memberId } : {}),
      tenantSlug: readFlag(flags, '--tenant') ?? readFlag(flags, '--tenant-slug'),
      displayName: readFlag(flags, '--name') ?? readFlag(flags, '--display-name'),
      role: readFlag(flags, '--role'),
      expectedVersion: readFlag(flags, '--expected-version'),
      apply: flags.includes('--apply'),
    };
  }
  if (action !== 'link-identity' && action !== 'unlink-identity') {
    throw new Error(`unknown member command '${action}'`);
  }
  if (!memberId || memberId.startsWith('--')) throw new Error('member id is required');
  const slack = readFlag(rest, '--slack');
  const issuer = slack ? CHANNEL_IDENTITY_ISSUERS.slack : readFlag(rest, '--issuer');
  const subject = slack ?? readFlag(rest, '--subject');
  if (!issuer || !subject) throw new Error('pass --slack <user-id> or --issuer and --subject');
  const email = readFlag(rest, '--email');
  return { action, memberId, issuer, subject, ...(email ? { email } : {}) };
}

/** `pnpm organization member ...` — governed member identity edits. */
export async function runOrganizationMember(
  args: string[],
  print: Print = (value) => process.stdout.write(`${value}\n`)
): Promise<void> {
  const command = parseMemberCommand(args);
  if (!command) {
    print(HELP);
    return;
  }
  if (command.action === 'ensure-owner') {
    const owner = withExecutionContext('sovereign_concierge', () => ensureOwnerMember());
    auditChain.record({
      agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
      action: 'member.ensure-owner',
      operation: `user:${owner.member_id}`,
      result: 'completed',
      metadata: { tenants: owner.memberships.map((membership) => membership.tenant_slug) },
    });
    print(
      JSON.stringify(
        {
          status: 'ok',
          member_id: owner.member_id,
          principal: `user:${owner.member_id}`,
          display_name: owner.display_name,
          memberships: owner.memberships,
        },
        null,
        2
      )
    );
    return;
  }
  const operator = withExecutionContext('sovereign_concierge', () => resolveCliOperatorIdentity());
  if (!operator.principalId?.startsWith('user:'))
    throw new Error(
      'Registered owner required; run pnpm organization member ensure-owner after reviewed onboarding.'
    );
  const principal = { memberId: operator.principalId.slice(5), allowedTenantSlugs: 'all' as const };
  if ('kind' in command) {
    const tenant = command.tenantSlug ?? resolveScopeContext().tenant_slug;
    if (!tenant)
      throw new Error('--tenant <slug> is required, or select a tenant with pnpm scope use.');
    if (
      command.role !== undefined &&
      !['owner', 'approver', 'operator', 'viewer'].includes(command.role)
    )
      throw new Error('--role must be owner, approver, operator or viewer.');
    if (command.action === 'list' || command.action === 'show') {
      if (!tenant) throw new Error('--tenant <slug> is required.');
      const members = await listManagedMembers(principal, tenant);
      const result =
        command.action === 'show'
          ? members.find((member) => member.member_id === command.memberId)
          : members;
      if (!result) throw new Error('Member not found in this tenant.');
      print(JSON.stringify(result, null, 2));
      return;
    }
    if (['create', 'grant', 'revoke'].includes(command.action) && !tenant)
      throw new Error('--tenant <slug> is required.');
    if (['create', 'grant'].includes(command.action) && !command.role)
      throw new Error('--role <owner|approver|operator|viewer> is required.');
    if (command.action === 'create' && !command.displayName) throw new Error('--name is required.');
    if (command.action === 'update' && !command.displayName) throw new Error('--name is required.');
    if (!command.apply) {
      print(
        JSON.stringify(
          {
            status: 'dry-run',
            operation: 'member.' + command.action,
            member_id: command.memberId,
            tenant_slug: tenant,
            display_name: command.displayName,
            role: command.role,
            expected_version: command.expectedVersion,
            note: 'Repeat with --apply to save.',
          },
          null,
          2
        )
      );
      return;
    }
    const result =
      command.action === 'create'
        ? await createManagedMember(principal, {
            memberId: command.memberId!,
            displayName: command.displayName!,
            tenantSlug: tenant!,
            role: command.role as MemberRole,
          })
        : await updateManagedMember(principal, {
            memberId: command.memberId!,
            expectedVersion: command.expectedVersion,
            ...(command.action === 'grant'
              ? { tenantSlug: tenant!, role: command.role as MemberRole }
              : {}),
            ...(command.action === 'revoke' ? { removeTenantSlug: tenant! } : {}),
            ...(command.action === 'update' ? { displayName: command.displayName } : {}),
            ...(command.action === 'suspend' || command.action === 'resume'
              ? {
                  status:
                    command.action === 'suspend' ? ('suspended' as const) : ('active' as const),
                }
              : {}),
          });
    print(JSON.stringify(result, null, 2));
    return;
  }
  const identity = {
    issuer: command.issuer,
    subject: command.subject,
    ...(command.email ? { email: command.email } : {}),
  };
  const member = await updateManagedMember(principal, {
    memberId: command.memberId,
    ...(command.action === 'link-identity'
      ? { externalIdentity: identity }
      : { removeExternalIdentity: identity }),
  });
  const result = { status: command.action === 'link-identity' ? 'linked' : 'unlinked', member };
  // An identity link grants a chat actor the member's authority: audit it.
  auditChain.record({
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
    action: `member.${command.action}`,
    operation: `user:${command.memberId}`,
    result: 'completed',
    metadata: { status: result.status, issuer: identity.issuer, subject: identity.subject },
  });
  print(
    JSON.stringify(
      {
        status: result.status,
        member_id: result.member.member_id,
        identity: { issuer: identity.issuer, subject: identity.subject },
        external_identities: result.member.external_identities ?? [],
      },
      null,
      2
    )
  );
}
