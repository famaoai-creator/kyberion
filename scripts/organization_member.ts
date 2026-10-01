import { withExecutionContext } from '@agent/core/governance';
import {
  linkMemberExternalIdentity,
  unlinkMemberExternalIdentity,
} from '@agent/core/organization/member-identity-link';
import { CHANNEL_IDENTITY_ISSUERS } from '@agent/core/surface/channel-speaker-principal';

type Print = (value: string) => void;

const HELP = [
  'Usage: pnpm organization member <link-identity|unlink-identity> <member-id> [options]',
  '',
  'Links a chat or IdP identity to an existing member (knowledge/personal/members/).',
  'Team channels resolve the speaker through this link (Team Channel P1).',
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

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value.trim();
}

export function parseMemberCommand(args: string[]): MemberCommand | null {
  const [action, memberId, ...rest] = args;
  if (!action || action === '--help' || action === 'help') return null;
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
  const identity = {
    issuer: command.issuer,
    subject: command.subject,
    ...(command.email ? { email: command.email } : {}),
  };
  const result = withExecutionContext('sovereign_concierge', () =>
    command.action === 'link-identity'
      ? linkMemberExternalIdentity(command.memberId, identity)
      : unlinkMemberExternalIdentity(command.memberId, identity)
  );
  if (result.status === 'member_not_found') {
    throw new Error(`member '${command.memberId}' does not exist`);
  }
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
