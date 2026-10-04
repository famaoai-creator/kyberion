/**
 * Kyberion public ingress CLI — expose one opted-in loopback surface at a
 * public HTTPS URL through a provider from public-ingress-providers.json.
 *
 * Usage:
 *   pnpm kyberion ingress probe  [--json]
 *   pnpm kyberion ingress status [--surface <id>] [--json]
 *   pnpm kyberion ingress up     --surface <id> [--provider <id>] [--json]
 *   pnpm kyberion ingress down   --surface <id> [--json]
 *
 * `up` requires the surface manifest to opt in (`ingress.allowed`), the
 * surface to be healthy, and an approved `ingress:expose` request: the first
 * run opens the request, approve it with `pnpm kyberion approvals --approve
 * <id>`, then re-run. The provider is chosen by --provider, else
 * KYBERION_INGRESS_PROVIDER, else the first ready live provider.
 */
import { loadEventIntakePolicy } from '@agent/core/dot/dot-event-intake';
import {
  exposeSurface,
  listSurfaceIngressStatus,
  probePublicIngressProviders,
  withdrawSurface,
} from '@agent/core/ingress/public-ingress-service';
import { IngressError } from '@agent/core/ingress/public-ingress-contract';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export interface IngressCliArgs {
  command: 'probe' | 'status' | 'up' | 'down';
  surface?: string;
  provider?: string;
  json: boolean;
}

const COMMANDS = new Set(['probe', 'status', 'up', 'down']);
const USAGE =
  'Usage: pnpm kyberion ingress <probe|status|up|down> [--surface <id>] [--provider <id>] [--json]';

export function parseIngressArgs(argv: string[]): IngressCliArgs {
  const args = argv.filter((arg) => arg !== '--');
  let command: string | undefined;
  let surface: string | undefined;
  let provider: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/su) : [arg, undefined];
    if (flag === '--json') json = true;
    else if (flag === '--surface' || flag === '--provider') {
      const value = inline ?? args[(index += 1)];
      if (!value || value.startsWith('--')) throw new ScriptExitError(2, `${flag} needs a value`);
      if (flag === '--surface') surface = value;
      else provider = value;
    } else if (!arg.startsWith('-') && !command) command = arg;
    else throw new ScriptExitError(2, `unknown argument ${arg}\n${USAGE}`);
  }
  if (!command || !COMMANDS.has(command)) throw new ScriptExitError(2, USAGE);
  if ((command === 'up' || command === 'down') && !surface) {
    throw new ScriptExitError(2, `${command} needs --surface <id>\n${USAGE}`);
  }
  return {
    command: command as IngressCliArgs['command'],
    ...(surface ? { surface } : {}),
    ...(provider ? { provider } : {}),
    json,
  };
}

export interface IngressEndpointHint {
  name: string;
  url: string;
  enabled: boolean;
}

/**
 * Per-surface public endpoints worth printing after `up` (keyed by surface,
 * never by provider): event-intake lists one webhook URL per declared source.
 */
const SURFACE_ENDPOINT_HINTS: Record<string, (publicUrl: string) => IngressEndpointHint[]> = {
  'event-intake-surface': (publicUrl) =>
    Object.entries(loadEventIntakePolicy().sources)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([source, policy]) => ({
        name: source,
        url: `${publicUrl}/${encodeURIComponent(source)}`,
        enabled: policy.enabled === true,
      })),
};

export function surfaceEndpointHints(surfaceId: string, publicUrl: string): IngressEndpointHint[] {
  return SURFACE_ENDPOINT_HINTS[surfaceId]?.(publicUrl) ?? [];
}

type ApprovalRequired = Extract<
  Awaited<ReturnType<typeof exposeSurface>>,
  { status: 'approval_required' }
>;

/** Operator guidance per approval state; "Approve" only for an open request. */
export function approvalLines(args: IngressCliArgs, result: ApprovalRequired): string[] {
  const rerun = `pnpm kyberion ingress up --surface ${args.surface}${args.provider ? ` --provider ${args.provider}` : ''}`;
  const lines = [
    `Approval required to expose ${args.surface} via ${result.provider_id} (${result.selection.route}: ${result.selection.reason}).`,
    `  ${result.message}`,
  ];
  switch (result.approval_state) {
    case 'created':
    case 'pending':
      if (result.approval_request_id) {
        lines.push(`  Approve: pnpm kyberion approvals --approve ${result.approval_request_id}`);
      }
      lines.push(`  Then re-run: ${rerun}`);
      break;
    case 'rejected':
      lines.push(
        '  The request was rejected. A new request is opened automatically once it lapses (24h after it was opened); changing the port, path prefix or provider opens a new one immediately.'
      );
      break;
    case 'expired':
    case 'effect_mismatch':
      lines.push(
        `  The earlier request no longer covers this exposure (${result.approval_state}); re-run once it lapses to open a new request: ${rerun}`
      );
      break;
    case 'human_required':
      lines.push(
        '  No request was opened: this run is non-interactive. Re-run from an operator shell.'
      );
      break;
    default:
      lines.push(`  Re-run after resolving the approval: ${rerun}`);
  }
  return lines;
}

export async function runIngressCli(
  args: IngressCliArgs,
  print: (value: unknown) => void
): Promise<unknown> {
  if (args.command === 'probe') {
    const candidates = await probePublicIngressProviders();
    if (args.json) {
      print({ providers: candidates });
      return candidates;
    }
    for (const candidate of candidates) {
      print(
        `${candidate.provider_id} [${candidate.status}] ${candidate.readiness.status} — ${candidate.readiness.reason} (network: ${candidate.network_class}, stable_url: ${candidate.stable_url})`
      );
      for (const step of candidate.readiness.setup_steps ?? []) print(`    - ${step}`);
    }
    return candidates;
  }

  if (args.command === 'status') {
    const statuses = await listSurfaceIngressStatus({
      ...(args.surface ? { surfaceId: args.surface } : {}),
      ...(args.provider ? { providerId: args.provider } : {}),
    });
    if (args.json) {
      print({ exposures: statuses });
      return statuses;
    }
    if (statuses.length === 0) print('No surface opts in to public ingress.');
    for (const status of statuses) {
      const url = status.live?.public_url ?? status.recorded?.public_url ?? '-';
      print(
        `${status.surface_id}: ${status.live_check} ${url}${status.provider_id ? ` via ${status.provider_id}` : ''}${status.detail ? ` (${status.detail})` : ''}`
      );
    }
    return statuses;
  }

  if (args.command === 'down') {
    const result = await withdrawSurface({
      surfaceId: args.surface!,
      ...(args.provider ? { providerId: args.provider } : {}),
    });
    if (args.json) {
      print(result);
      return result;
    }
    print(
      result.status === 'withdrawn'
        ? `Withdrawn ${args.surface}${result.exposure ? ` (${result.exposure.public_url})` : ''}${result.unrecorded ? ' — the mapping had no local record' : ''}.`
        : `${args.surface} is not exposed (checked: ${result.checked_providers.join(', ') || 'no live provider'}).`
    );
    return result;
  }

  const result = await exposeSurface({
    surfaceId: args.surface!,
    ...(args.provider ? { providerId: args.provider } : {}),
    agentId: 'kyberion:ingress-cli',
  });
  if (result.status === 'approval_required') {
    if (args.json) print(result);
    else for (const line of approvalLines(args, result)) print(line);
    throw new ScriptExitError(3, '', true, result);
  }
  const endpoints = surfaceEndpointHints(result.exposure.surface_id, result.exposure.public_url);
  if (args.json) {
    print({ ...result, endpoints });
    return result;
  }
  print(
    `Exposed ${result.exposure.surface_id} at ${result.exposure.public_url} via ${result.exposure.provider_id} (${result.selection.route}: ${result.selection.reason}).`
  );
  if (!result.exposure.stable_url) {
    print('  Note: this provider issues a new URL on every start; re-point webhook senders.');
  }
  const enabled = endpoints.filter((endpoint) => endpoint.enabled);
  for (const endpoint of enabled) print(`  ${endpoint.name}: ${endpoint.url}`);
  if (endpoints.length > 0 && enabled.length === 0) {
    print(
      `  No source is enabled yet. Declared sources: ${endpoints.map((endpoint) => `${endpoint.name} → ${endpoint.url}`).join(', ')}`
    );
  }
  return result;
}

export const ingressCli = defineScript({
  name: 'ingress',
  flags: ['json', 'quiet'],
  async run(context) {
    try {
      return await runIngressCli(parseIngressArgs(context.argv), context.print);
    } catch (error) {
      // Normalized ingress failures carry an operator-facing reason; no stack.
      if (error instanceof IngressError) throw new ScriptExitError(1, error.message);
      throw error;
    }
  },
});

if (
  isDirectScript(import.meta.url, 'ingress.ts') ||
  isDirectScript(import.meta.url, 'ingress.js')
) {
  void ingressCli();
}
