/**
 * HA-01: one answer to "is this process (or request) acting for an agent?".
 *
 * Signals, in precedence order:
 *   1. Kyberion's own agent runtime — `KYBERION_AGENT_ID`, `KYBERION_NHI_ID`,
 *      `KYBERION_RUN_ORIGIN=agent` (the signals `deriveTraceOrigin` treats as
 *      `agent`). Other `KYBERION_AGENT_*` names are operator settings
 *      (runtime backend, inflight limits, …), not markers, and are ignored.
 *   2. Provider CLI harness markers (Claude Code `CLAUDECODE`, Codex
 *      `CODEX_*` / `TERM_PROGRAM=codex`, agy, Gemini, Grok, Cursor, …),
 *      declared per provider in the reasoning-provider registry
 *      (`cli.session_markers` / `cli.session_principal`), read on use.
 *   3. The generic `AI_AGENT` marker some harnesses export.
 *   4. A resolved authn principal of agent kind (agent-token / agent-context
 *      providers), for request-scoped callers that have one.
 *
 * Environment markers are advisory: an agent can clear them, so a negative
 * answer never proves a human is present. A positive answer is reliable
 * enough to refuse a human-only decision.
 */
import { getRegisteredEnvText } from './foundation/env.js';
import { listCliReasoningProviderDescriptors } from './reasoning/reasoning-provider-registry.js';
import type { ResolvedPrincipal } from './authn-principal-resolver.js';

type Env = Record<string, string | undefined>;

export type AgentExecutionSignal =
  | { kind: 'kyberion_runtime'; env: string }
  | { kind: 'provider_harness'; env: string; provider: string }
  | { kind: 'generic_harness'; env: 'AI_AGENT' }
  | { kind: 'agent_principal'; source: ResolvedPrincipal['source']; provider: string };

export interface AgentExecutionContext {
  isAgent: boolean;
  /** `agent:<id>`-style principal of the strongest signal, or null for none. */
  principal: string | null;
  /** Reasoning-provider modes whose harness markers are present (e.g. `codex-cli`). */
  harnesses: string[];
  signals: AgentExecutionSignal[];
}

export interface DetectAgentExecutionContextOptions {
  env?: Env;
  principal?: Pick<ResolvedPrincipal, 'actor' | 'source' | 'provider' | 'principalId'> | null;
}

const RUNTIME_MARKER_ENV = ['KYBERION_AGENT_ID', 'KYBERION_NHI_ID', 'KYBERION_RUN_ORIGIN'];

function harnessMarkers(): Array<{
  env: string;
  equals?: string;
  provider: string;
  principal: string;
}> {
  return listCliReasoningProviderDescriptors().flatMap((descriptor) =>
    (descriptor.cli.session_markers ?? []).map((marker) => ({
      env: marker.env,
      ...(marker.equals !== undefined ? { equals: marker.equals.toLowerCase() } : {}),
      provider: descriptor.mode,
      principal: descriptor.cli.session_principal ?? descriptor.mode,
    }))
  );
}

/** Every environment variable {@link detectAgentExecutionContext} reads (tests blank them). */
export function agentExecutionContextEnvNames(): string[] {
  return [
    ...RUNTIME_MARKER_ENV,
    ...new Set(harnessMarkers().map((marker) => marker.env)),
    'AI_AGENT',
  ];
}

function envText(env: Env, name: string): string {
  return getRegisteredEnvText(name, { env })?.trim() ?? '';
}

export function detectAgentExecutionContext(
  options: DetectAgentExecutionContextOptions = {}
): AgentExecutionContext {
  const env = options.env ?? process.env;
  const signals: AgentExecutionSignal[] = [];
  const principals: string[] = [];
  const harnesses = new Set<string>();

  const agentId = envText(env, 'KYBERION_AGENT_ID');
  if (agentId) {
    signals.push({ kind: 'kyberion_runtime', env: 'KYBERION_AGENT_ID' });
    principals.push(agentId.includes(':') ? agentId : `agent:${agentId}`);
  }
  const nhiId = envText(env, 'KYBERION_NHI_ID');
  if (nhiId) {
    signals.push({ kind: 'kyberion_runtime', env: 'KYBERION_NHI_ID' });
    principals.push(nhiId);
  }
  if (envText(env, 'KYBERION_RUN_ORIGIN').toLowerCase() === 'agent') {
    signals.push({ kind: 'kyberion_runtime', env: 'KYBERION_RUN_ORIGIN' });
    principals.push('agent:kyberion-runtime');
  }
  for (const marker of harnessMarkers()) {
    const value = envText(env, marker.env);
    if (!value) continue;
    if (marker.equals !== undefined && value.toLowerCase() !== marker.equals) continue;
    signals.push({ kind: 'provider_harness', env: marker.env, provider: marker.provider });
    harnesses.add(marker.provider);
    principals.push(`agent:${marker.principal}`);
  }
  const generic = envText(env, 'AI_AGENT');
  if (generic) {
    signals.push({ kind: 'generic_harness', env: 'AI_AGENT' });
    principals.push(`agent:${generic.split(/[_\s]/u)[0] || 'unknown-harness'}`);
  }
  const principal = options.principal;
  if (principal && (principal.actor?.kind === 'agent' || principal.source === 'agent')) {
    signals.push({
      kind: 'agent_principal',
      source: principal.source,
      provider: principal.provider,
    });
    principals.push(principal.actor?.id || principal.principalId);
  }

  return {
    isAgent: signals.length > 0,
    principal: principals[0] ?? null,
    harnesses: [...harnesses],
    signals,
  };
}

const SCRIPT_INTERPRETERS = /^(?:node|nodejs|bun|deno|tsx|ts-node|python(?:\d+(?:\.\d+)?)?)$/u;
/** Interpreter flags whose value is the next argument, not the script. */
const INTERPRETER_VALUE_FLAGS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '-W',
  '-X',
]);

function commandBasename(token: string): string {
  return token.replace(/^-/u, '').split(/[\\/]/u).pop() ?? '';
}

interface CommandLineCandidates {
  /** Basenames the command may run as (matched exactly against `cli.binary`). */
  names: string[];
  /** Raw argv[0] and script tokens (matched by substring against `cli.install_path_markers`). */
  paths: string[];
}

/**
 * What a command line runs: argv[0] and, when argv[0] is a script interpreter
 * (node, bun, python, …), the script or `-m` module it runs. Arguments after
 * the script are never candidates, so `node server.js claude` is not claude.
 * Tokenised on whitespace: a path containing spaces is cut at the first one.
 */
function commandLineCandidates(commandLine: string): CommandLineCandidates {
  const argv = commandLine.trim().split(/\s+/u).filter(Boolean);
  const program = argv[0] ?? '';
  const head = commandBasename(program);
  const candidates: CommandLineCandidates = { names: [head], paths: [program] };
  if (!SCRIPT_INTERPRETERS.test(head)) return candidates;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '-m' && argv[index + 1]) {
      candidates.names.push(argv[index + 1]!.split('.')[0]!);
      break;
    }
    if (INTERPRETER_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    const script = commandBasename(arg);
    candidates.names.push(script, script.replace(/\.(?:[cm]?js|ts|py)$/u, ''));
    candidates.paths.push(arg);
    break;
  }
  return candidates;
}

/**
 * The reasoning-provider mode of the first provider CLI harness among a
 * process's ancestors (`commands` nearest first, full command lines as
 * `ps -o command=` prints them), or null. Matches argv[0] and, for
 * interpreter-wrapped CLIs, the script — by binary name, or by an install-path
 * marker from the registry (`/@anthropic-ai/claude-code/`) for CLIs that run
 * as `node …/cli.js`. Only providers that declare session markers are agent
 * harnesses (`gh` for copilot is not). Advisory like the markers: a renamed
 * or relocated binary, or a reparented process, escapes it.
 */
export function providerHarnessInProcessLineage(commands: readonly string[]): string | null {
  const harnesses = listCliReasoningProviderDescriptors().filter(
    (descriptor) => (descriptor.cli.session_markers ?? []).length > 0
  );
  const binaries = new Map(
    harnesses.map((descriptor) => [descriptor.cli.binary, descriptor.mode] as const)
  );
  const pathMarkers = harnesses.flatMap((descriptor) =>
    (descriptor.cli.install_path_markers ?? []).map((marker) => [marker, descriptor.mode] as const)
  );
  for (const command of commands) {
    const candidates = commandLineCandidates(command);
    for (const name of candidates.names) {
      const mode = binaries.get(name);
      if (mode) return mode;
    }
    for (const token of candidates.paths) {
      const hit = pathMarkers.find(([marker]) => token.includes(marker));
      if (hit) return hit[1];
    }
  }
  return null;
}

/** True when a provider CLI harness of the given reasoning-provider mode is present. */
export function isInsideProviderHarness(mode: string, env: Env = process.env): boolean {
  return detectAgentExecutionContext({ env }).harnesses.includes(mode);
}
