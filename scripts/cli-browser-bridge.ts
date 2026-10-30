/**
 * `pnpm kyberion browser-bridge request|status|wait` — Kyberion → Chrome
 * extension pull mailbox (libs/core/browser/browser-bridge-mailbox.ts).
 *
 *   request observe --purpose <text> [--origins <o1,o2>] [--mode text|structure]
 *   request infer   --task <task> (--input <text> | --input-file <path>) [--options-json <json>]
 *   request notify  --title <t> --body <b> [--level info|progress|approval_pending]
 *                   [--approval <id>] [--progress <done>/<total>]
 *     common: [--tier personal|confidential|public] [--tenant <slug>] [--mission <id>]
 *             [--ttl-min N] [--wait] [--timeout-sec N] [--json]
 *   status <request_id> [--json]
 *   wait   <request_id> [--timeout-sec N] [--json]
 *
 * The extension polls the native host, asks the user per request, and
 * answers; this CLI only enqueues and reads. Nothing here can decide an
 * approval — `notify --level approval_pending` points the user at
 * `pnpm kyberion approvals --approve <id>`.
 */
import * as path from 'node:path';
import {
  BrowserBridgeMailboxError,
  awaitBrowserBridgeResponse,
  enqueueBrowserBridgeRequest,
  loadBrowserBridgeRequest,
  type BrowserBridgeLocalTask,
  type BrowserBridgeRequest,
  type EnqueueBrowserBridgeRequestInput,
} from '@agent/core/browser/browser-bridge-mailbox';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { parseGuardedCliArgs, type CliOptionSpec } from '@agent/core/cli-guard';
import {
  detectCliAgentPrincipal,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import { pathResolver } from '@agent/core/path-resolver';
import { classifyPromotionSourceScope, isUnknownTierSource } from '@agent/core/scratch-promotion';
import { safeReadFile, safeRealpath } from '@agent/core/secure-io';
import {
  partitionedRuntimeStateKnowledgePath,
  type StorageDataTier,
} from '@agent/core/storage-layout';
import { ScriptExitError } from './lib/harness.js';

export const BROWSER_BRIDGE_USAGE = `Usage: pnpm kyberion browser-bridge <request|status|wait> [options]

  request observe --purpose <text> [--origins <https://a,https://b>] [--mode text|structure]
                                  Ask the user (per request, in the side panel) to share the
                                  active tab's text with Kyberion
  request infer --task <summarize|classify|extract|translate|detect_language|proofread|rewrite|write>
                (--input <text> | --input-file <path>) [--options-json <json>]
                                  Run an on-device Chrome model; the result is never executable
  request notify --title <t> --body <b> [--level info|progress|approval_pending]
                 [--approval <id>] [--progress <done>/<total>]
                                  Show a display-only notification (approvals are decided only
                                  with pnpm kyberion approvals --approve <id>)
    common: [--tier personal|confidential|public] [--tenant <slug>] [--mission <id>]
            [--ttl-min N (default 10, max 60)] [--wait] [--timeout-sec N] [--json]
  status <request_id> [--json]    Show a request and its response
  wait <request_id> [--timeout-sec N] [--json]
                                  Wait until the extension answers or the request expires`;

const LOCAL_TASKS: readonly BrowserBridgeLocalTask[] = [
  'summarize',
  'classify',
  'extract',
  'translate',
  'detect_language',
  'proofread',
  'rewrite',
  'write',
];
const TIERS: readonly StorageDataTier[] = ['personal', 'confidential', 'public'];

const COMMON_OPTIONS: CliOptionSpec[] = [
  { flag: '--tier', value: '<tier>' },
  { flag: '--tenant', value: '<slug>' },
  { flag: '--mission', value: '<id>' },
  { flag: '--ttl-min', value: '<minutes>' },
  { flag: '--wait' },
  { flag: '--timeout-sec', value: '<seconds>' },
  { flag: '--json' },
  { flag: '--verbose' },
];

const REQUEST_OPTIONS: Record<string, CliOptionSpec[]> = {
  observe: [
    { flag: '--purpose', value: '<text>', required: true },
    { flag: '--origins', value: '<origins>' },
    { flag: '--mode', value: 'text|structure' },
  ],
  infer: [
    { flag: '--task', value: '<task>', required: true },
    { flag: '--input', value: '<text>' },
    { flag: '--input-file', value: '<path>' },
    { flag: '--options-json', value: '<json>' },
  ],
  notify: [
    { flag: '--title', value: '<text>', required: true },
    { flag: '--body', value: '<text>', required: true },
    { flag: '--level', value: 'info|progress|approval_pending' },
    { flag: '--approval', value: '<id>' },
    { flag: '--progress', value: '<done>/<total>' },
  ],
};

export interface BrowserBridgeCliDeps {
  enqueue: typeof enqueueBrowserBridgeRequest;
  load: typeof loadBrowserBridgeRequest;
  await: typeof awaitBrowserBridgeResponse;
  actor: () => string;
  readFile: (filePath: string) => string;
}

/** The requesting principal: the agent session if any, else the terminal's operator. */
export function resolveBrowserBridgeActor(
  env: Record<string, string | undefined> = process.env
): string {
  const agent = detectCliAgentPrincipal(env);
  if (agent) return agent;
  return resolveCliOperatorIdentity({ env }).principalId ?? 'operator-cli';
}

// The mailbox lives in tier partitions (personal by default); the concierge
// role is the governed operator-side writer, as for other personal-tier CLI state.
const defaultDeps: BrowserBridgeCliDeps = {
  enqueue: (input, options) =>
    withExecutionContext(
      'sovereign_concierge',
      () => enqueueBrowserBridgeRequest(input, options),
      'sovereign'
    ),
  load: (requestId, options) =>
    withExecutionContext(
      'sovereign_concierge',
      () => loadBrowserBridgeRequest(requestId, options),
      'sovereign'
    ),
  await: (requestId, options) =>
    withExecutionContextAsync(
      'sovereign_concierge',
      () => awaitBrowserBridgeResponse(requestId, options),
      'sovereign'
    ),
  actor: () => resolveBrowserBridgeActor(),
  readFile: (filePath) => {
    const absolute = path.isAbsolute(filePath) ? filePath : pathResolver.rootResolve(filePath);
    return String(safeReadFile(absolute, { encoding: 'utf8' }));
  },
};

function fail(message: string): never {
  throw new ScriptExitError(1, `${message}\n\n${BROWSER_BRIDGE_USAGE}`);
}

const TIER_RANK: Record<StorageDataTier, number> = { public: 0, confidential: 1, personal: 2 };

function toRepoRelative(absolute: string, root: string): string | undefined {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
    return undefined;
  return relative;
}

/** Fails when one repo-relative location carries a stricter scope than requested. */
function assertLocationWithinScope(
  relative: string,
  filePath: string,
  scope: { tier: StorageDataTier; tenant_slug?: string }
): void {
  const source = classifyPromotionSourceScope(
    partitionedRuntimeStateKnowledgePath(relative) ?? relative
  );
  if (!source) {
    if (scope.tier === 'public' && isUnknownTierSource(relative)) {
      fail(
        `--input-file ${filePath} is in an unpartitioned storage location (tier unknown); ` +
          'it cannot be sent with --tier public. Use the tier/tenant partition that owns it.'
      );
    }
    return;
  }
  const requestedTenant = scope.tenant_slug?.trim().toLowerCase() || undefined;
  const requested = `${scope.tier}${requestedTenant ? `/${requestedTenant}` : ''}`;
  const carried = `${source.tier}${source.tenant ? `/${source.tenant}` : ''}`;
  if (TIER_RANK[source.tier] > TIER_RANK[scope.tier]) {
    fail(
      `--input-file ${filePath} holds ${carried} data (${source.location}); ` +
        `it cannot be sent in the lower ${requested} scope. Pass --tier ${source.tier}` +
        `${source.tenant ? ` --tenant ${source.tenant}` : ''}.`
    );
  }
  if (source.tenant && source.tenant !== requestedTenant) {
    fail(
      `--input-file ${filePath} belongs to tenant '${source.tenant}' (${source.location}); ` +
        `it cannot be sent in the ${requested} scope. Pass --tenant ${source.tenant}.`
    );
  }
}

/**
 * Refuse an `--input-file` whose location carries a higher tier than the
 * requested scope, or another tenant's data, and return the canonical path to
 * read. Classification reuses the governed helpers: tiered trees
 * (`knowledge/`, `active/{missions,projects,organizations}/`), the storage
 * floors, and the partitioned runtime state roots (mapped onto their
 * `knowledge/<tier>/<tenant>/` rules). An unpartitioned (legacy) floor path
 * has an unknown tier, so it may not be sent as public. Anything else keeps
 * the requested scope.
 *
 * Both the written path and its canonical path (`safeRealpath`, every symlink
 * — leaf or parent — resolved) are classified and the stricter wins, so a
 * link in `active/shared/tmp/` cannot launder `knowledge/confidential/<a>/`.
 * The written form still counts because `rootResolve` may relocate runtime
 * roots (e.g. per test pool), where only the logical path classifies. A path
 * that does not resolve inside the repository is refused.
 */
export function assertInputFileScope(
  filePath: string,
  scope: { tier: StorageDataTier; tenant_slug?: string }
): string {
  const root = pathResolver.rootResolve('.');
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : pathResolver.rootResolve(filePath);
  let canonical: string;
  let canonicalRoot: string;
  try {
    canonical = safeRealpath(absolute);
    canonicalRoot = safeRealpath(root);
  } catch {
    fail(`--input-file ${filePath} does not resolve to a readable path inside the repository`);
  }
  const written = path.isAbsolute(filePath)
    ? toRepoRelative(absolute, root)
    : path.normalize(filePath).split(path.sep).join('/');
  const real = toRepoRelative(canonical, canonicalRoot);
  if (written === undefined || written.startsWith('../') || written === '..' || !real) {
    fail(`--input-file ${filePath} does not resolve to a readable path inside the repository`);
  }
  assertLocationWithinScope(written, filePath, scope);
  if (real !== written) assertLocationWithinScope(real, filePath, scope);
  return canonical;
}

function text(options: Record<string, string | boolean>, flag: string): string | undefined {
  const value = options[flag];
  return typeof value === 'string' ? value : undefined;
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value) || Number(value) <= 0) fail(`${flag} must be a positive integer`);
  return Number(value);
}

function buildRequest(
  kind: string,
  options: Record<string, string | boolean>,
  deps: BrowserBridgeCliDeps
): EnqueueBrowserBridgeRequestInput {
  const tier = (text(options, '--tier') ?? 'personal') as StorageDataTier;
  if (!TIERS.includes(tier)) fail('--tier must be personal|confidential|public');
  const tenant = text(options, '--tenant');
  const mission = text(options, '--mission');
  const ttlMin = positiveInt(text(options, '--ttl-min'), '--ttl-min');
  const common = {
    requested_by: { actor_id: deps.actor(), ...(mission ? { mission_id: mission } : {}) },
    scope: { tier, ...(tenant ? { tenant_slug: tenant } : {}) },
    ...(ttlMin ? { ttl_ms: ttlMin * 60_000 } : {}),
  };
  if (kind === 'observe') {
    const mode = text(options, '--mode') ?? 'text';
    if (mode !== 'text' && mode !== 'structure') fail('--mode must be text|structure');
    const origins = (text(options, '--origins') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    return {
      request_kind: 'observe_tab',
      payload: {
        purpose: text(options, '--purpose') as string,
        mode,
        ...(origins.length > 0 ? { allowed_origins: origins } : {}),
      },
      ...common,
    };
  }
  if (kind === 'infer') {
    const task = text(options, '--task') as BrowserBridgeLocalTask;
    if (!LOCAL_TASKS.includes(task)) fail(`--task must be one of ${LOCAL_TASKS.join(', ')}`);
    const inline = text(options, '--input');
    const file = text(options, '--input-file');
    if (Boolean(inline) === Boolean(file)) fail('give exactly one of --input or --input-file');
    // Read the canonical path that was classified, not the link that named it.
    const canonicalFile = file ? assertInputFileScope(file, common.scope) : undefined;
    let taskOptions: Record<string, unknown> | undefined;
    const rawOptions = text(options, '--options-json');
    if (rawOptions) {
      try {
        const parsed = JSON.parse(rawOptions) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('');
        taskOptions = parsed as Record<string, unknown>;
      } catch {
        fail('--options-json must be a JSON object');
      }
    }
    let input = inline;
    if (input === undefined) {
      input = deps.readFile(canonicalFile as string);
      // A path swapped for a symlink between the check and the read resolves
      // elsewhere afterwards; re-check so that content is never enqueued.
      if (assertInputFileScope(file as string, common.scope) !== canonicalFile) {
        fail('--input-file changed while it was being read; retry');
      }
    }
    return {
      request_kind: 'local_infer',
      payload: {
        task,
        input,
        ...(taskOptions ? { options: taskOptions } : {}),
      },
      ...common,
    };
  }
  const level = text(options, '--level') ?? 'info';
  if (!['info', 'progress', 'approval_pending'].includes(level)) {
    fail('--level must be info|progress|approval_pending');
  }
  const progressRaw = text(options, '--progress');
  let progress: { done: number; total: number } | undefined;
  if (progressRaw) {
    const match = /^(\d+)\/(\d+)$/u.exec(progressRaw);
    if (!match) fail('--progress must look like <done>/<total>');
    progress = { done: Number(match[1]), total: Number(match[2]) };
  }
  const approval = text(options, '--approval');
  return {
    request_kind: 'notify',
    payload: {
      level: level as 'info' | 'progress' | 'approval_pending',
      title: text(options, '--title') as string,
      body: text(options, '--body') as string,
      ...(approval ? { approval_request_id: approval } : {}),
      ...(mission ? { mission_id: mission } : {}),
      ...(progress ? { progress } : {}),
    },
    ...common,
  };
}

export function renderBrowserBridgeRequest(record: BrowserBridgeRequest, json: boolean): string {
  if (json) return JSON.stringify(record, null, 2);
  const lines = [
    `## Browser bridge request ${record.request_id}`,
    '',
    `- kind: ${record.request_kind}`,
    `- status: ${record.status}`,
    `- scope: ${record.scope.tier}${record.scope.tenant_slug ? `/${record.scope.tenant_slug}` : ''}`,
    `- requested_by: ${record.requested_by.actor_id}${record.requested_by.mission_id ? ` (${record.requested_by.mission_id})` : ''}`,
    `- created_at: ${record.created_at}`,
    `- expires_at: ${record.expires_at}`,
  ];
  if (record.response) {
    lines.push(`- responded_at: ${record.response.responded_at}`);
    if (record.response.origin) lines.push(`- origin: ${record.response.origin}`);
    if (record.response.error) lines.push(`- error: ${record.response.error}`);
    if (record.response.result) {
      lines.push('', '```json', JSON.stringify(record.response.result, null, 2), '```');
    }
  } else if (record.status === 'pending' || record.status === 'delivered') {
    lines.push(
      '',
      'Waiting for the user to answer in the Chrome side panel (受信 tab). ' +
        `Run \`pnpm kyberion browser-bridge wait ${record.request_id}\` to wait for it.`
    );
  }
  return lines.join('\n');
}

export async function runBrowserBridgeCommand(
  argv: string[],
  print: (text: string) => void,
  deps: BrowserBridgeCliDeps = defaultDeps
): Promise<void> {
  try {
    await runBrowserBridgeCommandImpl(argv, print, deps);
  } catch (err) {
    // Mailbox errors are written for operators; surface them without a stack.
    if (err instanceof BrowserBridgeMailboxError) throw new ScriptExitError(1, err.message);
    throw err;
  }
}

async function runBrowserBridgeCommandImpl(
  argv: string[],
  print: (text: string) => void,
  deps: BrowserBridgeCliDeps
): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    print(BROWSER_BRIDGE_USAGE);
    return;
  }
  if (sub === 'request') {
    const [kind, ...flags] = rest;
    const kindOptions = REQUEST_OPTIONS[kind ?? ''];
    if (!kindOptions) fail(`Unknown request kind: ${kind ?? ''} (observe|infer|notify)`);
    const parsed = parseGuardedCliArgs(
      flags,
      {
        command: `pnpm kyberion browser-bridge request ${kind}`,
        manifestId: 'operator-cli.browser-bridge.request',
        options: [...kindOptions, ...COMMON_OPTIONS],
      },
      print
    );
    if (parsed.handled) return;
    const json = parsed.options['--json'] === true;
    let record = deps.enqueue(buildRequest(kind as string, parsed.options, deps));
    if (parsed.options['--wait'] === true) {
      const timeoutSec = positiveInt(text(parsed.options, '--timeout-sec'), '--timeout-sec');
      record = await deps.await(record.request_id, {
        ...(timeoutSec ? { timeoutMs: timeoutSec * 1000 } : {}),
      });
    }
    print(renderBrowserBridgeRequest(record, json));
    return;
  }
  if (sub === 'status' || sub === 'wait') {
    const parsed = parseGuardedCliArgs(
      rest,
      {
        command: `pnpm kyberion browser-bridge ${sub}`,
        manifestId: `operator-cli.browser-bridge.${sub}`,
        positional: '<request_id>',
        options: [
          { flag: '--json' },
          { flag: '--verbose' },
          ...(sub === 'wait' ? [{ flag: '--timeout-sec', value: '<seconds>' }] : []),
        ],
      },
      print
    );
    if (parsed.handled) return;
    const [requestId] = parsed.positionals;
    if (!requestId || parsed.positionals.length > 1) fail(`${sub} takes one <request_id>`);
    const json = parsed.options['--json'] === true;
    if (sub === 'status') {
      const record = deps.load(requestId);
      if (!record) throw new ScriptExitError(1, `No browser bridge request ${requestId}`);
      print(renderBrowserBridgeRequest(record, json));
      return;
    }
    const timeoutSec = positiveInt(text(parsed.options, '--timeout-sec'), '--timeout-sec');
    const record = await deps.await(requestId, {
      ...(timeoutSec ? { timeoutMs: timeoutSec * 1000 } : {}),
    });
    print(renderBrowserBridgeRequest(record, json));
    return;
  }
  fail(`Unknown browser-bridge command: ${sub}`);
}
