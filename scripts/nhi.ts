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
 *   pnpm nhi issue --slug <agent-slug> --tenant-slug <t> [--organization-id <org>] \
 *     --accountable-human human:<owner> [--kind agent|service] \
 *     [--display-name <name>] [--provider-hint <p>] [--model-hint <m>] \
 *     [--trust-ref <ref>] --apply
 *   pnpm nhi list [--organization-id <org>] [--status <s>] [--kind <k>] [--json]
 *   pnpm nhi show <nhi-id>
 *   pnpm nhi suspend <nhi-id> [--reason <r>] --apply
 *   pnpm nhi resume <nhi-id> --apply
 *   pnpm nhi retire <nhi-id> --reason <r> --apply
 *   pnpm nhi migrate-ids [--apply] [--json]
 *
 * Ids are `kyberion://agent/<tenant>/<org|_>/<slug>` (concept model v2 D3).
 * `migrate-ids` moves every ledger record still keyed by the legacy
 * `kyberion://agent/<org>/<slug>` id to its canonical id (dry run unless
 * --apply; re-running is a no-op). Legacy ids keep resolving as aliases for
 * one release.
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
  buildTenantlessNhiId,
  NHI_SLUG_PATTERN,
  planAgentIdentityIdMigration,
  applyAgentIdentityIdMigration,
  AGENT_IDENTITY_KINDS,
  type AgentIdentityKind,
  type AgentIdentityLifecycleStatus,
} from '@agent/core/agent/agent-identity';
import { withExecutionContext } from '@agent/core/authority';
import * as path from 'node:path';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { readJson } from '@agent/core/foundation/json';
import {
  loadPersonalAgentIdentityAtPath,
  personalAgentIdentityRevision,
} from '@agent/core/personal-identity-state';
import {
  validatePersonaIdentityBindings,
  writePersonaIdentityBindingsAtPath,
} from '@agent/core/persona-identity';
import { defineScript, isDirectScript } from './lib/harness.js';
import { parseCliFlags } from './lib/cli-flag-parser.js';

type Args = {
  command:
    | 'issue'
    | 'list'
    | 'show'
    | 'suspend'
    | 'resume'
    | 'retire'
    | 'persona-bind'
    | 'persona-show'
    | 'migrate-ids'
    | 'help';
  bindingsFile?: string;
  expectedRevision?: string;
  nhiId?: string;
  slug?: string;
  organizationId?: string;
  tenantSlug?: string;
  personScope?: boolean;
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
    command: ([
      'issue',
      'list',
      'show',
      'suspend',
      'resume',
      'retire',
      'persona-bind',
      'persona-show',
      'migrate-ids',
    ].includes(command)
      ? command
      : 'help') as Args['command'],
    apply: false,
    json: false,
  };
  const setTo =
    <K extends keyof Args>(key: K) =>
    (o: Args, v: string | undefined) => {
      (o as Record<string, unknown>)[key] = v;
    };
  const setTrue =
    <K extends keyof Args>(key: K) =>
    (o: Args) => {
      (o as Record<string, unknown>)[key] = true;
    };
  parseCliFlags(
    rest,
    result,
    [
      { flags: ['--apply'], apply: setTrue('apply') },
      { flags: ['--bindings'], takesValue: 'next', apply: setTo('bindingsFile') },
      { flags: ['--expected-revision'], takesValue: 'next', apply: setTo('expectedRevision') },
      { flags: ['--json'], apply: setTrue('json') },
      {
        flags: ['--organization-id', '--org'],
        takesValue: 'next',
        apply: setTo('organizationId'),
      },
      { flags: ['--tenant-slug', '--tenant'], takesValue: 'next', apply: setTo('tenantSlug') },
      { flags: ['--person-scope'], apply: setTrue('personScope') },
      {
        flags: ['--accountable-human', '--owner-id'],
        takesValue: 'next',
        apply: setTo('accountableHuman'),
      },
      { flags: ['--slug'], takesValue: 'next', apply: setTo('slug') },
      { flags: ['--kind'], takesValue: 'next', apply: setTo('kind') },
      { flags: ['--status'], takesValue: 'next', apply: setTo('status') },
      { flags: ['--display-name'], takesValue: 'next', apply: setTo('displayName') },
      { flags: ['--provider-hint'], takesValue: 'next', apply: setTo('providerHint') },
      { flags: ['--model-hint'], takesValue: 'next', apply: setTo('modelHint') },
      { flags: ['--trust-ref'], takesValue: 'next', apply: setTo('trustRef') },
      { flags: ['--reason'], takesValue: 'next', apply: setTo('reason') },
    ],
    {
      onBare: (o, arg) => {
        if (!o.nhiId && !o.slug) {
          if (arg.startsWith('kyberion://')) o.nhiId = arg;
          else o.slug = arg;
        }
      },
    }
  );
  return result;
}

function usage(): string {
  return [
    'Usage: pnpm nhi <issue|list|show|suspend|resume|retire|migrate-ids> [args] [--apply] [--json]',
    '  issue   --slug <agent-slug> --tenant-slug <t> [--organization-id <org>] --accountable-human <id>',
    '          [--kind agent|service] [--display-name <n>]',
    '          (or --person-scope instead of --tenant-slug: a personal agent, kyberion://agent/_/_/<slug>)',
    '          [--provider-hint <p>] [--model-hint <m>] [--trust-ref <ref>]',
    '  list    [--organization-id <org>] [--status provisioned|active|suspended|retired]',
    '          [--kind agent|service]',
    '  show    <nhi-id>',
    '  persona-show   (current profile bindings; descriptive only)',
    '  persona-bind --bindings <json-file> [--apply --expected-revision <preview-revision>] (replace map; no grants)',
    '  suspend <nhi-id> [--reason <r>] --apply',
    '  resume  <nhi-id> --apply',
    '  retire  <nhi-id> --reason <r> --apply   (terminal — the slug can never be re-issued)',
    '  migrate-ids [--apply]   (legacy kyberion://agent/<org>/<slug> -> kyberion://agent/<tenant>/<org|_>/<slug>)',
    '',
    'Mutations write only with --apply; without it they print the dry-run.',
    'After issue, verify activation readiness with:',
    '  pnpm tenant:activation probe --customer-slug <c> --tenant-slug <t> \\',
    '    --organization-id <org> --nhi-id kyberion://agent/<tenant>/<org>/<slug>',
  ].join('\n');
}

function requireNhiId(args: Args, command: string): string {
  const id =
    args.nhiId ||
    (args.slug ? deriveAgentNhiId(args.slug, args.organizationId, args.tenantSlug) : null);
  if (!id || !id.startsWith('kyberion://')) {
    throw new Error(
      `${command} requires an nhi_id (kyberion://agent/<tenant>/<org|_>/<slug>) or a valid --slug --tenant-slug <t> [--organization-id <org>]`
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

  if (args.command === 'persona-show' || args.command === 'persona-bind') {
    const result = withExecutionContext('sovereign_concierge', () => {
      const file = path.join(resolveActiveProfileRoot(), 'agent-identity.json');
      const profile = loadPersonalAgentIdentityAtPath(file);
      if (!profile)
        throw new Error('Existing persona profile required; complete reviewed onboarding first.');
      if (args.command === 'persona-show')
        return {
          persona_id: profile.agent_id,
          bindings: profile.persona_identity_bindings ?? null,
          legacy_nhi_id: profile.nhi_id ?? null,
          note: 'Descriptive links only; lifecycle, affiliation, admission and authority are checked separately.',
        };
      if (!args.bindingsFile) throw new Error('persona-bind requires --bindings <json-file>.');
      const input = readJson<unknown>(args.bindingsFile);
      const bindings = validatePersonaIdentityBindings(profile, input);
      if (args.apply) {
        if (!args.expectedRevision)
          throw new Error('--apply requires --expected-revision from a reviewed preview.');
        writePersonaIdentityBindingsAtPath(file, bindings, args.expectedRevision);
      }
      return {
        status: args.apply ? 'bound' : 'dry-run',
        bindings,
        expected_revision: personalAgentIdentityRevision(profile),
        note: 'Complete map replacement. No identity, membership, session admission, approval or grant was created.',
      };
    });
    print(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === 'migrate-ids') {
    const plan = args.apply
      ? withExecutionContext('mission_controller', () => applyAgentIdentityIdMigration())
      : planAgentIdentityIdMigration();
    const migrate = plan.filter((entry) => entry.status === 'migrate');
    const skipped = plan.filter((entry) => entry.status === 'skipped');
    const result = {
      status: args.apply ? 'applied' : 'dry-run',
      migrated: args.apply ? migrate.length : 0,
      would_migrate: args.apply ? 0 : migrate.length,
      skipped: skipped.length,
      entries: plan,
      note:
        plan.length === 0
          ? 'every ledger record already uses kyberion://agent/<tenant>/<org|_>/<slug>'
          : 'legacy ids keep resolving as aliases for one release; skipped entries need an operator decision',
    };
    if (args.json) print(JSON.stringify(result, null, 2));
    else {
      print(
        `${result.status}: ${args.apply ? `${migrate.length} migrated` : `${migrate.length} to migrate`}, ${skipped.length} skipped`
      );
      for (const entry of plan) {
        print(
          `  ${entry.legacy_nhi_id} -> ${entry.nhi_id ?? '(none)'}${entry.reason ? ` [skipped: ${entry.reason}]` : ''}`
        );
      }
      if (!args.apply && migrate.length > 0) print('re-run with --apply to write');
    }
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
    if (args.personScope && (args.tenantSlug || args.organizationId)) {
      throw new Error(
        '--person-scope names no tenant or organization (kyberion://agent/_/_/<slug>)'
      );
    }
    if (!args.personScope && !args.tenantSlug?.trim()) {
      throw new Error(
        'issue requires --tenant-slug <t>: an NHI belongs to a tenant (kyberion://agent/<tenant>/<org|_>/<slug>); pass --person-scope for a personal agent'
      );
    }
    const nhiId = args.personScope
      ? NHI_SLUG_PATTERN.test(args.slug)
        ? buildTenantlessNhiId(args.slug)
        : null
      : deriveAgentNhiId(args.slug, args.organizationId, args.tenantSlug);
    if (!nhiId) {
      throw new Error(
        `cannot derive an nhi_id from slug '${args.slug}' / tenant '${args.tenantSlug}'` +
          (args.organizationId ? ` / org '${args.organizationId}'` : '')
      );
    }
    const params = {
      kind,
      ...(args.personScope ? { personScope: true } : { tenantSlug: args.tenantSlug }),
      organizationId: args.organizationId,
      slug: args.slug,
      displayName: args.displayName,
      accountableHumanId: args.accountableHuman ?? '',
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
