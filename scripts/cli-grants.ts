/**
 * `pnpm kyberion grants list|check|status|upcoming|grant|revoke` — standing grants (PG-03/04)
 * and readiness (PG-06).
 *
 *   list   [--tenant <slug>] [--capability <c>] [--json]
 *   check  --capability <c> [--tenant <slug>] [--mission <id>]
 *          [--meeting-url <url>] [--meeting-series <id>] [--json]
 *   status [--profile <p>] [--tenant <slug>] [--mission <id>]
 *          [--meeting-url <url>] [--meeting-series <id>] [--json]
 *   upcoming [--stage next_day|soon] [--from-min N --to-min N] [--profile <p>]
 *          [--tenant <slug>] [--calendar <name>]... [--json]
 *   grant  --capability <c> --tenant <slug> [--meeting-url <url>]... [--meeting-series <id>]...
 *          --purpose <text> [--days N] (--request-approval | --approval-request-id <id>)
 *   revoke <grant_id> --reason <text> [--tenant <slug>]
 *
 * external_io capabilities (e.g. meeting.recording) follow the scope-approve
 * flow: `grant --request-approval` files a hash-bound approval request, a
 * human decides with `pnpm kyberion approvals --approve <id>`, then
 * `grant --approval-request-id <id>` with the same arguments creates the grant.
 * Markdown on stdout by default; `--json` for structure.
 */
import { getGrantCapabilityPolicy } from '@agent/core/governance/grant-capability-policy';
import {
  findGrantById,
  grantStanding,
  grantStandingDirect,
  grantStatusAt,
  listGrants,
  requestGrantApproval,
  revokeGrant,
  type GrantActor,
  type GrantDraft,
  type GrantRecord,
} from '@agent/core/governance/grant-store';
import { resolveGrant, type GrantResolution } from '@agent/core/governance/grant-resolver';
import {
  evaluateGrantReadiness,
  type GrantReadinessReport,
} from '@agent/core/governance/grant-readiness';
import { listGrantReadinessProfiles } from '@agent/core/governance/grant-capability-policy';
import {
  CLI_OPERATOR_PROVISION_COMMAND,
  detectCliAgentPrincipal,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { cliApprovalRequester } from './lib/cli-approval-requester.js';
import { ScriptExitError } from './lib/harness.js';

export const GRANTS_USAGE = `Usage: pnpm kyberion grants <list|check|status|upcoming|grant|revoke> [options]

  list   [--tenant <slug>] [--capability <c>] [--json]
                                  Show standing grants (active, expired and revoked)
  check  --capability <c> [--tenant <slug>] [--mission <id>]
         [--meeting-url <url>] [--meeting-series <id>] [--json]
                                  Resolve whether a capability is allowed, and how to fix it
  status [--profile <p>] [--tenant <slug>] [--mission <id>]
         [--meeting-url <url>] [--meeting-series <id>] [--json]
                                  List what a kind of work still needs (all profiles, or one;
                                  exits 1 when the named profile is not ready)
  upcoming [--stage next_day|soon] [--from-min N --to-min N] [--profile <p>]
         [--tenant <slug>] [--calendar <name>]... [--json]
                                  Check the calendar's upcoming meetings (default: tomorrow)
                                  and list the grants each one still needs
  grant  --capability <c> --tenant <slug> [--meeting-url <url>]... [--meeting-series <id>]...
         --purpose <text> [--days N] (--request-approval | --approval-request-id <id>)
                                  Create a standing grant. Series ids take the provider form
                                  (google-workspace:<id> | m365:<id>) shown by \`grants upcoming\`. Capabilities that exchange data with
                                  an external service need a human approval first:
                                  --request-approval, then \`pnpm kyberion approvals --approve <id>\`,
                                  then the same command with --approval-request-id <id>.
  revoke <grant_id> --reason <text> [--tenant <slug>]
                                  Revoke a grant (the record is kept)`;

export interface GrantsDeps {
  list: typeof listGrants;
  resolve: typeof resolveGrant;
  readiness: typeof evaluateGrantReadiness;
  profiles: typeof listGrantReadinessProfiles;
  upcoming: (argv: string[]) => Promise<{ report: unknown; text: string }>;
  requestApproval: typeof requestGrantApproval;
  grantWithApproval: typeof grantStanding;
  grantDirect: typeof grantStandingDirect;
  revoke: typeof revokeGrant;
  find: typeof findGrantById;
  /** Who revokes: the agent session if this CLI runs in one, else the terminal's operator. */
  revoker: () => GrantActor;
  now: () => Date;
}

/**
 * The revoking principal, attributed truthfully: inside an agent session the
 * agent revokes (revocation only narrows, so it is allowed) even when a local
 * owner member exists; a plain terminal revokes as the owner member.
 */
export function resolveRevoker(env: Record<string, string | undefined> = process.env): GrantActor {
  const agent = detectCliAgentPrincipal(env);
  if (agent) return { kind: 'agent', id: agent };
  const identity = resolveCliOperatorIdentity({ env });
  if (identity.principalId) return { kind: 'human', id: identity.principalId };
  throw new ScriptExitError(
    1,
    `No operator identity for this terminal; run \`${CLI_OPERATOR_PROVISION_COMMAND}\` first.`
  );
}

const defaultDeps: GrantsDeps = {
  list: listGrants,
  resolve: resolveGrant,
  readiness: evaluateGrantReadiness,
  profiles: listGrantReadinessProfiles,
  upcoming: async (argv) => {
    const { parseMeetingReadinessArgs, renderMeetingReadiness, runMeetingReadinessCheck } =
      await import('./meeting_readiness_check.js');
    const report = await runMeetingReadinessCheck(parseMeetingReadinessArgs(argv));
    return { report, text: renderMeetingReadiness(report) };
  },
  requestApproval: requestGrantApproval,
  grantWithApproval: grantStanding,
  grantDirect: grantStandingDirect,
  revoke: revokeGrant,
  find: findGrantById,
  revoker: () => resolveRevoker(),
  now: () => new Date(),
};

const VALUE_FLAGS = new Set([
  '--tenant',
  '--capability',
  '--profile',
  '--mission',
  '--meeting-url',
  '--meeting-series',
  '--purpose',
  '--days',
  '--approval-request-id',
  '--reason',
  '--stage',
  '--from-min',
  '--to-min',
  '--calendar',
]);
const REPEATABLE_FLAGS = new Set(['--meeting-url', '--meeting-series', '--calendar']);
const BOOLEAN_FLAGS = new Set(['--json', '--request-approval', '--verbose']);

const ALLOWED_FLAGS: Record<string, Set<string>> = {
  list: new Set(['--tenant', '--capability', '--json']),
  check: new Set([
    '--capability',
    '--tenant',
    '--mission',
    '--meeting-url',
    '--meeting-series',
    '--json',
  ]),
  status: new Set([
    '--profile',
    '--tenant',
    '--mission',
    '--meeting-url',
    '--meeting-series',
    '--json',
  ]),
  upcoming: new Set([
    '--stage',
    '--from-min',
    '--to-min',
    '--profile',
    '--tenant',
    '--calendar',
    '--json',
  ]),
  grant: new Set([
    '--capability',
    '--tenant',
    '--meeting-url',
    '--meeting-series',
    '--purpose',
    '--days',
    '--request-approval',
    '--approval-request-id',
    '--json',
  ]),
  revoke: new Set(['--reason', '--tenant', '--json']),
};

export interface ParsedGrantsArgs {
  sub: string;
  positionals: string[];
  values: Record<string, string>;
  lists: Record<string, string[]>;
  flags: Set<string>;
}

export function parseGrantsArgs(argv: string[]): ParsedGrantsArgs {
  const [sub, ...rest] = argv;
  const allowed = ALLOWED_FLAGS[sub ?? ''];
  if (!allowed) {
    throw new ScriptExitError(1, `Unknown grants command: ${sub ?? ''}\n\n${GRANTS_USAGE}`);
  }
  const parsed: ParsedGrantsArgs = {
    sub,
    positionals: [],
    values: {},
    lists: {},
    flags: new Set(),
  };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--verbose') continue;
    if (!token.startsWith('--')) {
      parsed.positionals.push(token);
      continue;
    }
    if (!allowed.has(token)) {
      throw new ScriptExitError(1, `Unknown option for grants ${sub}: ${token}\n\n${GRANTS_USAGE}`);
    }
    if (BOOLEAN_FLAGS.has(token)) {
      parsed.flags.add(token);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ScriptExitError(1, `${token} requires a value`);
      }
      index += 1;
      if (REPEATABLE_FLAGS.has(token)) (parsed.lists[token] ||= []).push(value);
      else if (token in parsed.values) throw new ScriptExitError(1, `${token} given twice`);
      else parsed.values[token] = value;
    }
  }
  return parsed;
}

function table(rows: string[][]): string {
  return rows
    .map((row) => `| ${row.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`)
    .join('\n');
}

function meetingsOf(record: GrantRecord): string {
  const parts = [
    ...(record.scope.meeting_series_ids ?? []).map((id) => `series:${id}`),
    ...(record.scope.meeting_urls ?? []),
  ];
  return parts.join(', ') || '-';
}

export function renderGrantList(records: GrantRecord[], now: Date, json: boolean): string {
  if (json) {
    return JSON.stringify(
      records.map((record) => ({ ...record, status: grantStatusAt(record, now) })),
      null,
      2
    );
  }
  if (records.length === 0) return '# Grants\n\n> [grants] no standing grants';
  return [
    '# Grants',
    '',
    table([
      ['grant', 'capability', 'tenant', 'meetings', 'status', 'expires', 'granted by'],
      ['---', '---', '---', '---', '---', '---', '---'],
      ...records.map((record) => [
        record.grant_id,
        record.capability,
        record.scope.tenant_slug ?? '-',
        meetingsOf(record),
        grantStatusAt(record, now),
        record.expires_at,
        record.granted_by.actor_id,
      ]),
    ]),
  ].join('\n');
}

export function renderGrantCheck(
  capability: string,
  result: GrantResolution,
  json: boolean
): string {
  if (json) return JSON.stringify({ capability, ...result }, null, 2);
  const lines = [
    `# Grant check: ${capability}`,
    '',
    `- allowed: ${result.allowed ? 'yes' : 'no'}`,
    ...(result.source ? [`- source: ${result.source}`] : []),
    ...(result.grant_id ? [`- grant: ${result.grant_id}`] : []),
  ];
  if (result.reason) lines.push('', `> [grants] ${result.reason}`);
  if (result.remedy) lines.push('', `> [grants] to allow it: ${result.remedy}`);
  return lines.join('\n');
}

export function renderGrantReadiness(reports: GrantReadinessReport[], json: boolean): string {
  if (json) return JSON.stringify(reports, null, 2);
  const lines = ['# Grant readiness'];
  for (const report of reports) {
    lines.push(
      '',
      `## ${report.profile}: ${report.ready ? 'ready' : `missing ${report.missing.join(', ')}`}`,
      '',
      report.description,
      '',
      table([
        ['capability', 'needed', 'allowed', 'source', 'to allow it'],
        ['---', '---', '---', '---', '---'],
        ...report.items.map((item) => [
          item.capability,
          item.required ? 'required' : `optional${item.note ? ` (${item.note})` : ''}`,
          item.allowed ? 'yes' : 'no',
          item.source ? `${item.source}${item.grant_id ? ` ${item.grant_id}` : ''}` : '-',
          item.allowed ? '-' : (item.remedy ?? '-'),
        ]),
      ])
    );
    for (const item of report.items) {
      if (!item.allowed && item.reason)
        lines.push('', `> [grants] ${item.capability}: ${item.reason}`);
    }
  }
  return lines.join('\n');
}

function renderGrantRecord(title: string, record: GrantRecord, json: boolean): string {
  if (json) return JSON.stringify(record, null, 2);
  return [
    `# ${title}`,
    '',
    `- grant: ${record.grant_id}`,
    `- capability: ${record.capability}`,
    `- tenant: ${record.scope.tenant_slug ?? '-'}`,
    `- meetings: ${meetingsOf(record)}`,
    `- expires: ${record.expires_at}`,
    `- granted by: ${record.granted_by.actor_id} (${record.granted_by.role}, ${record.granted_by.assurance})`,
    ...(record.basis ? [`- approval: ${record.basis.approval_request_id}`] : []),
    ...(record.revoked ? [`- revoked: ${record.revoked.at} by ${record.revoked.by}`] : []),
  ].join('\n');
}

function renderApprovalRequest(request: ApprovalRequestRecord, json: boolean): string {
  if (json) {
    return JSON.stringify(
      { approval_request_id: request.id, status: request.status, expires_at: request.expiresAt },
      null,
      2
    );
  }
  return [
    '# Grant approval requested',
    '',
    `- approval request: ${request.id} (${request.status})`,
    ...(request.expiresAt ? [`- approval expires: ${request.expiresAt}`] : []),
    '',
    '```',
    request.details ?? '',
    '```',
    '',
    `> [grants] a human decides with \`pnpm kyberion approvals --approve ${request.id}\`; then re-run this command with \`--approval-request-id ${request.id}\` instead of --request-approval`,
  ].join('\n');
}

function required(parsed: ParsedGrantsArgs, flag: string): string {
  const value = parsed.values[flag]?.trim();
  if (!value)
    throw new ScriptExitError(1, `grants ${parsed.sub} requires ${flag}\n\n${GRANTS_USAGE}`);
  return value;
}

function parseDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new ScriptExitError(1, `--days must be a positive integer`);
  return Number(value);
}

// Calendar events carry provider-namespaced series ids (calendar-workflow).
const SERIES_ID_PATTERN = /^(google-workspace|m365):\S+$/u;

export function grantDraftFromArgs(parsed: ParsedGrantsArgs): GrantDraft {
  const days = parseDays(parsed.values['--days']);
  for (const seriesId of parsed.lists['--meeting-series'] ?? []) {
    if (!SERIES_ID_PATTERN.test(seriesId)) {
      throw new ScriptExitError(
        1,
        `--meeting-series ${seriesId} is not a calendar series id: use the provider form (google-workspace:<id> or m365:<id>) shown by \`pnpm kyberion grants upcoming\``
      );
    }
  }
  return {
    capability: required(parsed, '--capability'),
    tenant_slug: required(parsed, '--tenant'),
    meeting_urls: parsed.lists['--meeting-url'] ?? [],
    meeting_series_ids: parsed.lists['--meeting-series'] ?? [],
    purpose: required(parsed, '--purpose'),
    ...(days !== undefined ? { ttl_days: days } : {}),
  };
}

function resolveContextFromArgs(
  parsed: ParsedGrantsArgs,
  deps: Pick<GrantsDeps, 'now'>
): Parameters<typeof resolveGrant>[0]['context'] {
  const url = parsed.lists['--meeting-url']?.[0];
  const seriesId = parsed.lists['--meeting-series']?.[0];
  return {
    ...(parsed.values['--tenant'] ? { tenant_slug: parsed.values['--tenant'] } : {}),
    ...(parsed.values['--mission'] ? { mission_id: parsed.values['--mission'] } : {}),
    ...(url || seriesId
      ? { meeting: { ...(url ? { url } : {}), ...(seriesId ? { series_id: seriesId } : {}) } }
      : {}),
    now: deps.now(),
  };
}

function asExitError(err: unknown): never {
  if (err instanceof ScriptExitError) throw err;
  throw new ScriptExitError(1, err instanceof Error ? err.message : String(err));
}

export async function runGrantsCommand(
  argv: string[],
  print: (text: string) => void,
  deps: GrantsDeps = defaultDeps
): Promise<void> {
  const [sub] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    print(GRANTS_USAGE);
    return;
  }
  const parsed = parseGrantsArgs(argv);
  const json = parsed.flags.has('--json');
  try {
    if (parsed.sub === 'list') {
      const records = deps.list({
        ...(parsed.values['--tenant'] ? { tenant_slug: parsed.values['--tenant'] } : {}),
        ...(parsed.values['--capability'] ? { capability: parsed.values['--capability'] } : {}),
      });
      print(renderGrantList(records, deps.now(), json));
      return;
    }
    if (parsed.sub === 'check') {
      const capability = required(parsed, '--capability');
      const result = deps.resolve({ capability, context: resolveContextFromArgs(parsed, deps) });
      print(renderGrantCheck(capability, result, json));
      return;
    }
    if (parsed.sub === 'status') {
      const profile = parsed.values['--profile']?.trim();
      const context = resolveContextFromArgs(parsed, deps);
      const reports = (profile ? [profile] : deps.profiles()).map((name) =>
        deps.readiness({ profile: name, context })
      );
      print(renderGrantReadiness(reports, json));
      if (profile && !reports[0]?.ready) throw new ScriptExitError(1, '', true);
      return;
    }
    if (parsed.sub === 'upcoming') {
      // Validated above; the readiness check parses the same flags itself.
      const { report, text } = await deps.upcoming(argv.slice(1));
      print(json ? JSON.stringify(report, null, 2) : text);
      return;
    }
    if (parsed.sub === 'grant') {
      const draft = grantDraftFromArgs(parsed);
      const requestApproval = parsed.flags.has('--request-approval');
      const approvalId = parsed.values['--approval-request-id'];
      if (requestApproval && approvalId) {
        throw new ScriptExitError(
          1,
          'use either --request-approval or --approval-request-id, not both'
        );
      }
      const policy = getGrantCapabilityPolicy(draft.capability);
      const externalIo = policy?.kind === 'standing_grant' && policy.external_io;
      if (requestApproval) {
        const request = deps.requestApproval(draft, {
          requester: cliApprovalRequester(undefined, 'grants-cli'),
        });
        print(renderApprovalRequest(request, json));
        return;
      }
      if (approvalId) {
        print(
          renderGrantRecord(
            'Grant created',
            deps.grantWithApproval(draft, { approvalRequestId: approvalId }),
            json
          )
        );
        return;
      }
      if (externalIo) {
        throw new ScriptExitError(
          1,
          `${draft.capability} exchanges data with an external service and needs a human approval: re-run with --request-approval`
        );
      }
      print(renderGrantRecord('Grant created', deps.grantDirect(draft), json));
      return;
    }
    // revoke
    const grantId = parsed.positionals[0];
    if (!grantId || parsed.positionals.length > 1) {
      throw new ScriptExitError(1, `grants revoke takes exactly one <grant_id>\n\n${GRANTS_USAGE}`);
    }
    const reason = required(parsed, '--reason');
    const tenant = parsed.values['--tenant'];
    if (!deps.find(grantId, tenant)) throw new ScriptExitError(1, `grant ${grantId} not found`);
    const revoked = deps.revoke(grantId, {
      by: deps.revoker(),
      reason,
      ...(tenant ? { tenant_slug: tenant } : {}),
    });
    print(renderGrantRecord('Grant revoked', revoked, json));
  } catch (err: unknown) {
    asExitError(err);
  }
}
