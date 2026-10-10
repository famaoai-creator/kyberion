#!/usr/bin/env node
/**
 * scripts/nhi.ts — governed CLI for non-human identities (NHI ledger).
 *
 * Route-3 tenant onboarding needs a provisioned NHI before activation's
 * nhi_provisioned probe passes; previously the only issuance paths were
 * `onboard company` (route 2, ceo-operator) or mission staffing — which needs
 * an already-active tenant. This facade exposes the same governed ledger
 * writes the mission controller performs.
 *
 *   pnpm nhi issue --slug <agent-slug> --organization-id <org> \
 *     --accountable-human human:<owner> [--tenant-slug <t>] [--kind agent|service] \
 *     [--display-name <name>] [--provider-hint <p>] [--model-hint <m>] \
 *     [--trust-ref <ref>] --apply
 *   pnpm nhi list [--organization-id <org>] [--status <s>] [--kind <k>] [--json]
 *   pnpm nhi show <nhi-id>
 *   pnpm nhi suspend <nhi-id> [--reason <r>] --apply
 *   pnpm nhi resume <nhi-id> --apply
 *   pnpm nhi retire <nhi-id> --reason <r> --apply
 *
 * Mutations are dry-run unless --apply is passed. Writes run under the
 * mission_controller execution context (the AGENT_IDENTITY_WRITE_ROLES
 * allowlist) and are journaled to the NHI ledger; reads are ungated.
 * Retired identities are terminal — re-issue under a new slug instead.
 */
import {
  issueAgentIdentity,
  activateAgentIdentity,
  suspendAgentIdentity,
  retireAgentIdentity,
  getAgentIdentity,
  listAgentIdentities,
  deriveAgentNhiId,
  AGENT_IDENTITY_KINDS,
  type AgentIdentityKind,
  type AgentIdentityLifecycleStatus,
} from '@agent/core/agent/agent-identity';
import { withExecutionContext } from '@agent/core/authority';
import { defineScript, isDirectScript } from './lib/harness.js';

type Args = {
  command: 'issue' | 'list' | 'show' | 'suspend' | 'resume' | 'retire' | 'help';
  nhiId?: string;
  slug?: string;
  organizationId?: string;
  tenantSlug?: string;
  accountableHuman?: string;
  kind?: string;
  status?: string;
  displayName?: string;
  providerHint?: string;
  modelHint?: string;
  trustRef?: string;
  reason?: string;
  apply: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const result: Args = {
    command: (['issue', 'list', 'show', 'suspend', 'resume', 'retire'].includes(command)
      ? command
      : 'help') as Args['command'],
    apply: false,
    json: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--organization-id' || arg === '--org') result.organizationId = rest[++i];
    else if (arg === '--tenant-slug' || arg === '--tenant') result.tenantSlug = rest[++i];
    else if (arg === '--accountable-human' || arg === '--owner-id') {
      result.accountableHuman = rest[++i];
    } else if (arg === '--slug') result.slug = rest[++i];
    else if (arg === '--kind') result.kind = rest[++i];
    else if (arg === '--status') result.status = rest[++i];
    else if (arg === '--display-name') result.displayName = rest[++i];
    else if (arg === '--provider-hint') result.providerHint = rest[++i];
    else if (arg === '--model-hint') result.modelHint = rest[++i];
    else if (arg === '--trust-ref') result.trustRef = rest[++i];
    else if (arg === '--reason') result.reason = rest[++i];
    else if (!arg.startsWith('--') && !result.nhiId && !result.slug) {
      if (arg.startsWith('kyberion://')) result.nhiId = arg;
      else result.slug = arg;
    }
  }
  return result;
}

function usage(): string {
  return [
    'Usage: pnpm nhi <issue|list|show|suspend|resume|retire> [args] [--apply] [--json]',
    '  issue   --slug <agent-slug> --organization-id <org> --accountable-human <id>',
    '          [--tenant-slug <t>] [--kind agent|service] [--display-name <n>]',
    '          [--provider-hint <p>] [--model-hint <m>] [--trust-ref <ref>]',
    '  list    [--organization-id <org>] [--status provisioned|active|suspended|retired]',
    '          [--kind agent|service]',
    '  show    <nhi-id>',
    '  suspend <nhi-id> [--reason <r>] --apply',
    '  resume  <nhi-id> --apply',
    '  retire  <nhi-id> --reason <r> --apply   (terminal — the slug can never be re-issued)',
    '',
    'Mutations write only with --apply; without it they print the dry-run.',
    'After issue, verify activation readiness with:',
    '  pnpm tenant:activation probe --customer-slug <c> --tenant-slug <t> \\',
    '    --organization-id <org> --nhi-id kyberion://agent/<org>/<slug>',
  ].join('\n');
}

function requireNhiId(args: Args, command: string): string {
  const id = args.nhiId || (args.slug ? deriveAgentNhiId(args.slug, args.organizationId) : null);
  if (!id || !id.startsWith('kyberion://')) {
    throw new Error(
      `${command} requires an nhi_id (kyberion://agent/<org>/<slug>) or a valid --slug [--organization-id <org>]`
    );
  }
  return id;
}

export function main(argv: string[] = [], print: (value: unknown) => void = () => undefined): void {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    print(usage());
    return;
  }

  if (args.command === 'list') {
    const records = listAgentIdentities({
      ...(args.kind ? { kind: args.kind as AgentIdentityKind } : {}),
      ...(args.status ? { lifecycle_status: args.status as AgentIdentityLifecycleStatus } : {}),
      ...(args.organizationId ? { organization_id: args.organizationId } : {}),
    });
    print(JSON.stringify(records, null, 2));
    return;
  }

  if (args.command === 'issue') {
    if (!args.slug) throw new Error('issue requires --slug <agent-slug>');
    if (!AGENT_IDENTITY_KINDS.includes(args.kind as AgentIdentityKind)) {
      if (args.kind) {
        throw new Error(`issue --kind must be one of: ${AGENT_IDENTITY_KINDS.join(', ')}`);
      }
    }
    const kind = (args.kind as AgentIdentityKind) || 'agent';
    const nhiId = deriveAgentNhiId(args.slug, args.organizationId);
    if (!nhiId) {
      throw new Error(
        `cannot derive an nhi_id from slug '${args.slug}'` +
          (args.organizationId ? ` / org '${args.organizationId}'` : ' (no --organization-id)')
      );
    }
    const params = {
      kind,
      organizationId: args.organizationId,
      slug: args.slug,
      displayName: args.displayName,
      accountableHumanId: args.accountableHuman ?? '',
      affiliation: args.tenantSlug ? { tenant_slug: args.tenantSlug } : undefined,
      providerHint: args.providerHint,
      modelHint: args.modelHint,
      trustRef: args.trustRef,
    };
    if (!args.apply) {
      print(
        JSON.stringify(
          {
            status: 'dry-run',
            would_issue: { nhi_id: nhiId, ...params },
            note: 're-issue with identical params is idempotent; differing params conflict; retired ids are never re-issued',
          },
          null,
          2
        )
      );
      return;
    }
    const record = withExecutionContext('mission_controller', () => issueAgentIdentity(params));
    print(JSON.stringify({ status: 'issued', identity: record }, null, 2));
    return;
  }

  // Lifecycle verbs.
  const nhiId = requireNhiId(args, args.command);
  if (args.command === 'show') {
    const record = getAgentIdentity(nhiId);
    if (!record) throw new Error(`NHI '${nhiId}' is not in the ledger`);
    print(
      args.json ? JSON.stringify(record, null, 2) : `${record.nhi_id}: ${record.lifecycle_status}`
    );
    return;
  }

  const verb = args.command;
  if (verb === 'retire' && !args.reason?.trim()) {
    throw new Error('retire requires --reason <text>');
  }
  if (!args.apply) {
    const current = getAgentIdentity(nhiId);
    print(
      JSON.stringify(
        {
          status: 'dry-run',
          verb,
          nhi_id: nhiId,
          current_lifecycle: current?.lifecycle_status ?? null,
          ...(args.reason ? { reason: args.reason } : {}),
        },
        null,
        2
      )
    );
    return;
  }
  const record = withExecutionContext('mission_controller', () =>
    verb === 'suspend'
      ? suspendAgentIdentity(nhiId, args.reason)
      : verb === 'resume'
        ? activateAgentIdentity(nhiId)
        : retireAgentIdentity(nhiId, args.reason!)
  );
  print(JSON.stringify({ status: 'applied', verb, identity: record }, null, 2));
}

export const runNhi = defineScript({
  name: 'nhi',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (isDirectScript(import.meta.url, 'nhi.ts') || isDirectScript(import.meta.url, 'nhi.js')) {
  void runNhi();
}
