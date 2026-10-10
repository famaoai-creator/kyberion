import { withExecutionContext } from '@agent/core/governance';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import {
  isChannelIdentityIssuer,
  issueScimToken,
  listScimTokens,
  revokeScimToken,
} from '@agent/core/organization/scim-token-registry';
import { loadStoredOidcLoginSettings } from '@agent/core/surface/oidc-login-settings';

type Print = (value: string) => void;

const HELP = [
  'Usage: pnpm organization scim-token issue --tenant <slug> --label <text> [options]',
  '       pnpm organization scim-token list --tenant <slug>',
  '       pnpm organization scim-token revoke --tenant <slug> --id <token-id> [--by <member-id>]',
  '',
  'Manages the SCIM 2.0 provisioning tokens an IdP (Entra ID, Okta, ...) uses to',
  'provision members into one organization at <concierge>/scim/v2. The token is',
  'printed once and stored only as a hash; it reaches no other API and no other tenant.',
  '',
  'Options (issue):',
  '  --issuer <iss>        OIDC issuer the SCIM externalId binds under',
  '                        (default: KYBERION_OIDC_ISSUER or the stored SSO settings)',
  '  --default-role <r>    Role for new members: viewer (default), operator or approver.',
  '                        SCIM never creates owners and never changes roles.',
  '  --by <member-id>      Issuing owner (default: owner)',
].join('\n');

export type ScimTokenCommand =
  | {
      action: 'issue';
      tenant: string;
      label: string;
      issuer?: string;
      defaultRole?: string;
      by: string;
    }
  | { action: 'list'; tenant: string }
  | { action: 'revoke'; tenant: string; tokenId: string; by: string };

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value.trim();
}

function required(args: string[], name: string): string {
  const value = readFlag(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseScimTokenCommand(args: string[]): ScimTokenCommand | null {
  const [action, ...rest] = args;
  if (!action || action === '--help' || action === 'help') return null;
  const by = readFlag(rest, '--by') ?? 'owner';
  if (action === 'issue') {
    const issuer = readFlag(rest, '--issuer');
    const defaultRole = readFlag(rest, '--default-role');
    return {
      action,
      tenant: required(rest, '--tenant'),
      label: required(rest, '--label'),
      ...(issuer ? { issuer } : {}),
      ...(defaultRole ? { defaultRole } : {}),
      by,
    };
  }
  if (action === 'list') return { action, tenant: required(rest, '--tenant') };
  if (action === 'revoke') {
    return { action, tenant: required(rest, '--tenant'), tokenId: required(rest, '--id'), by };
  }
  throw new Error(`unknown scim-token command '${action}'`);
}

function configuredIssuer(): string | undefined {
  return (
    getRegisteredEnvText('KYBERION_OIDC_ISSUER')?.trim() || loadStoredOidcLoginSettings()?.issuer
  );
}

/** `pnpm organization scim-token ...` — owner-only SCIM provisioning token lifecycle. */
export async function runOrganizationScimToken(
  args: string[],
  print: Print = (value) => process.stdout.write(`${value}\n`)
): Promise<void> {
  const command = parseScimTokenCommand(args);
  if (!command) {
    print(HELP);
    return;
  }
  const inTenant = <T>(fn: () => T): T =>
    withExecutionContext('sovereign_concierge', fn, undefined, command.tenant);
  if (command.action === 'list') {
    print(JSON.stringify({ tokens: inTenant(() => listScimTokens(command.tenant)) }, null, 2));
    return;
  }
  if (command.action === 'revoke') {
    const token = inTenant(() =>
      revokeScimToken({
        tenantSlug: command.tenant,
        tokenId: command.tokenId,
        revokedByMemberId: command.by,
      })
    );
    print(JSON.stringify({ status: 'revoked', token }, null, 2));
    return;
  }
  const issuer = command.issuer ?? configuredIssuer();
  if (!issuer) {
    throw new Error(
      'no OIDC issuer for SCIM identity binding — externalId must bind under the issuer members sign in with | pass --issuer <iss> or configure KYBERION_OIDC_ISSUER / first-run SSO settings'
    );
  }
  if (isChannelIdentityIssuer(issuer)) {
    throw new Error(
      `issuer '${issuer}' is a chat-surface identity issuer — SCIM binds IdP sign-ins, not chat accounts | pass --issuer <the OIDC issuer members sign in with>`
    );
  }
  const issued = inTenant(() =>
    issueScimToken({
      tenantSlug: command.tenant,
      label: command.label,
      issuer,
      ...(command.defaultRole ? { defaultRole: command.defaultRole } : {}),
      issuedByMemberId: command.by,
    })
  );
  print(
    JSON.stringify(
      {
        status: 'issued',
        token: issued.token,
        note: 'Shown once. Paste it into the IdP as the SCIM secret token; it is stored only as a hash.',
        scim_base_path: '/scim/v2',
        record: issued.record,
      },
      null,
      2
    )
  );
}
