#!/usr/bin/env node
/**
 * M2 agent worktree CLI — one git worktree per provider agent.
 *
 *   kyberion worktree create <name> [--branch <b>] [--base <ref>] [--agent <provider>]
 *                                   [--mission <id>] [--bootstrap] [--json]
 *   kyberion worktree list [--json]
 *   kyberion worktree remove <name> [--force] [--json]
 *
 * Operator-run (a human or the mission owner). `.git` is mission-owner only,
 * so a delegated worker (`KYBERION_DELEGATION_DEPTH > 0`) or a process whose
 * explicit `SYSTEM_ROLE` / `MISSION_ROLE` is not an owner role is refused.
 */
import { withExecutionContext } from '@agent/core/authority';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { MISSION_OWNER_GIT_ROLES } from '@agent/core/mission/mission-git';
import {
  agentWorktreeLaunchHint,
  bootstrapAgentWorktree,
  createAgentWorktree,
  listAgentWorktrees,
  removeAgentWorktree,
  type AgentWorktreeClaim,
  type AgentWorktreeOptions,
  type AgentWorktreeRecord,
  type AgentWorktreeStatus,
  type BootstrapStep,
  type RemoveAgentWorktreeResult,
} from '@agent/core/workforce/agent-worktree';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const USAGE =
  'Usage: kyberion worktree <create|list|remove> …\n' +
  '  create <name> [--branch <b>] [--base <ref>] [--agent <provider>] [--mission <id>] [--bootstrap]\n' +
  '                 new worktree at .worktrees/agent-<name>; --branch defaults to worktree/<name>,\n' +
  '                 a new branch starts from --base (default origin/main, else HEAD)\n' +
  '  list           worktrees with branch, agent, dist freshness and change-request owner\n' +
  '  remove <name> [--force]\n' +
  '                 refuses with uncommitted work, a non-terminal mission or a live claim\n' +
  '                 unless --force; the branch is kept';

const VALUE_FLAGS = new Set(['--branch', '--base', '--agent', '--mission']);
const BOOLEAN_FLAGS = new Set(['--bootstrap', '--force']);

/** Resolve the live owner of the WorkItem linked to a branch; null when none (or unavailable). */
export type ClaimResolver = (branch: string) => AgentWorktreeClaim | null;

export interface AgentWorktreeCliOptions extends AgentWorktreeOptions {
  /** Test seam: replaces the change-request owner lookup (`undefined` = auto-detect). */
  resolveClaim?: ClaimResolver | null;
  /** Test seam: replaces the install + build bootstrap. */
  bootstrap?: (record: AgentWorktreeRecord) => BootstrapStep[];
}

interface ParsedArgs {
  verb: string | undefined;
  name: string | undefined;
  values: Map<string, string>;
  booleans: Set<string>;
}

function parseArgs(positional: string[]): ParsedArgs {
  const [verb, ...rest] = positional;
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const names: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') continue;
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? rest[(i += 1)];
      if (!value || value.startsWith('--'))
        throw new ScriptExitError(2, `${flag} needs a value\n${USAGE}`);
      values.set(flag, value);
    } else if (BOOLEAN_FLAGS.has(flag) && inline === undefined) {
      booleans.add(flag);
    } else if (arg.startsWith('-')) {
      throw new ScriptExitError(2, `unknown option ${arg}\n${USAGE}`);
    } else {
      names.push(arg);
    }
  }
  if (names.length > 1) throw new ScriptExitError(2, `unexpected arguments: ${names.join(' ')}`);
  return { verb, name: names[0], values, booleans };
}

function assertOnly(parsed: ParsedArgs, allowed: string[]): void {
  const used = [...parsed.values.keys(), ...parsed.booleans];
  const extra = used.filter((flag) => !allowed.includes(flag));
  if (extra.length > 0)
    throw new ScriptExitError(2, `${extra.join(', ')} not valid for ${parsed.verb}\n${USAGE}`);
}

/**
 * `.git` writes are mission-owner only: refuse a delegated worker or a process
 * running under an explicit non-owner role. A plain operator shell passes and
 * the governed operation then runs in the mission_controller context.
 */
export function assertAgentWorktreeOperator(): void {
  const depth = Number(getRegisteredEnvText('KYBERION_DELEGATION_DEPTH'));
  if (Number.isFinite(depth) && depth > 0) {
    throw new ScriptExitError(
      1,
      '[AGENT_WORKTREE_OWNER_ONLY] delegated worker processes may not manage worktrees; ask the operator or mission owner'
    );
  }
  const explicit = getRegisteredEnvText('SYSTEM_ROLE') || getRegisteredEnvText('MISSION_ROLE');
  const role = explicit?.trim().toLowerCase().replace(/-/g, '_');
  if (role && !MISSION_OWNER_GIT_ROLES.has(role)) {
    throw new ScriptExitError(
      1,
      `[AGENT_WORKTREE_OWNER_ONLY] role ${role} may not manage worktrees (mission owner or operator only)`
    );
  }
}

function asOwner<T>(fn: () => T): T {
  assertAgentWorktreeOperator();
  return withExecutionContext('mission_controller', fn);
}

// Built at runtime on purpose: the change-request ↔ WorkItem link
// (work-item-change-request.ts) is not published in every build yet, so it is
// an optional dynamic import rather than a static dependency. Replace with a
// static import once that subpath is exported from @agent/core.
const CHANGE_REQUEST_MODULE = ['@agent/core', 'workforce', 'work-item-change-request'].join('/');

/**
 * The change-request ↔ WorkItem link is optional: when the module is not
 * installed in this build, the owner column is reported as unavailable.
 */
async function loadClaimResolver(): Promise<ClaimResolver | null> {
  try {
    const specifier = CHANGE_REQUEST_MODULE;
    const mod = (await import(specifier)) as {
      resolveChangeRequestOwner?: (input: { branch: string }) => {
        item: { item_id: string };
        owner: { peer_id: string } | null;
      } | null;
    };
    const resolve = mod.resolveChangeRequestOwner;
    if (typeof resolve !== 'function') return null;
    return (branch) => {
      try {
        const resolution = resolve({ branch });
        return resolution?.owner
          ? { item_id: resolution.item.item_id, owner: resolution.owner.peer_id }
          : null;
      } catch {
        return null;
      }
    };
  } catch {
    return null;
  }
}

async function claimResolverOf(options: AgentWorktreeCliOptions): Promise<ClaimResolver | null> {
  return options.resolveClaim === undefined ? loadClaimResolver() : options.resolveClaim;
}

export interface CreateCliResult {
  worktree: AgentWorktreeRecord;
  bootstrap: BootstrapStep[] | null;
  hint: { cd: string; launch: string | null };
}

export interface ListCliEntry extends AgentWorktreeStatus {
  /** Live owner of the branch's change request; null = unowned; undefined = lookup unavailable. */
  claim?: AgentWorktreeClaim | null;
}

export interface ListCliResult {
  worktrees: ListCliEntry[];
  claimLookup: boolean;
}

function renderCreate(result: CreateCliResult): string {
  const { worktree, bootstrap, hint } = result;
  const lines = [
    `created ${worktree.name}: ${worktree.path}`,
    `  branch ${worktree.branch}${worktree.base ? ` (new, from ${worktree.base})` : ' (existing)'}`,
  ];
  for (const step of bootstrap ?? []) {
    lines.push(`  ${step.status === 0 ? 'ok    ' : 'FAILED'} ${step.command}`);
    if (step.detail) lines.push(...step.detail.split('\n').map((line) => `    ${line}`));
  }
  if (!bootstrap) {
    lines.push(
      '  next: pnpm install --prefer-offline && pnpm build inside it (or re-create with --bootstrap);',
      '        until then Node resolves packages from the parent checkout'
    );
  }
  lines.push(`  ${hint.cd}${hint.launch ? ` && ${hint.launch}` : ''}`);
  return lines.join('\n');
}

function renderList(result: ListCliResult): string {
  if (result.worktrees.length === 0) return '(no agent worktrees)';
  const rows = result.worktrees.map((entry) => {
    const owner =
      entry.claim === undefined
        ? 'n/a'
        : entry.claim
          ? `${entry.claim.owner} (${entry.claim.item_id})`
          : '-';
    const branch =
      entry.checked_out && entry.checked_out !== entry.branch
        ? `${entry.branch} [now ${entry.checked_out}]`
        : entry.branch;
    return [
      entry.name,
      branch,
      entry.agent ?? '-',
      entry.created_at,
      entry.exists ? `dist:${entry.dist}` : 'missing',
      `owner:${owner}`,
      entry.path,
    ].join('  ');
  });
  return rows.join('\n');
}

export async function runAgentWorktreeCli(
  args: { positional: string[]; json: boolean },
  print: (value: unknown) => void,
  options: AgentWorktreeCliOptions = {}
): Promise<CreateCliResult | ListCliResult | RemoveAgentWorktreeResult> {
  const parsed = parseArgs(args.positional);
  if (parsed.verb === 'list') {
    assertOnly(parsed, []);
    if (parsed.name) throw new ScriptExitError(2, `unexpected argument ${parsed.name}\n${USAGE}`);
    const resolveClaim = await claimResolverOf(options);
    const worktrees = listAgentWorktrees(options).map((entry) => ({
      ...entry,
      ...(resolveClaim ? { claim: resolveClaim(entry.branch) } : {}),
    }));
    const result: ListCliResult = { worktrees, claimLookup: resolveClaim !== null };
    print(args.json ? result : renderList(result));
    return result;
  }
  if (parsed.verb === 'create') {
    assertOnly(parsed, ['--branch', '--base', '--agent', '--mission', '--bootstrap']);
    if (!parsed.name) throw new ScriptExitError(2, `create needs a <name>\n${USAGE}`);
    const name = parsed.name;
    const result = asOwner((): CreateCliResult => {
      const worktree = createAgentWorktree(
        {
          name,
          branch: parsed.values.get('--branch'),
          base: parsed.values.get('--base'),
          agent: parsed.values.get('--agent'),
          mission_id: parsed.values.get('--mission'),
        },
        options
      );
      const bootstrap = parsed.booleans.has('--bootstrap')
        ? (options.bootstrap ?? bootstrapAgentWorktree)(worktree)
        : null;
      return { worktree, bootstrap, hint: agentWorktreeLaunchHint(worktree) };
    });
    print(args.json ? result : renderCreate(result));
    if (result.bootstrap?.some((step) => step.status !== 0)) {
      throw new ScriptExitError(1, '', true, result);
    }
    return result;
  }
  if (parsed.verb === 'remove') {
    assertOnly(parsed, ['--force']);
    if (!parsed.name) throw new ScriptExitError(2, `remove needs a <name>\n${USAGE}`);
    const name = parsed.name;
    const force = parsed.booleans.has('--force');
    const resolveClaim = await claimResolverOf(options);
    const result = asOwner(() => {
      const record = listAgentWorktrees(options).find((entry) => entry.name === name);
      const claim = record && resolveClaim ? resolveClaim(record.branch) : null;
      return removeAgentWorktree({ name, force, claim }, options);
    });
    print(
      args.json
        ? result
        : [
            `removed ${result.record.name}: ${result.record.path} (branch ${result.record.branch} kept)`,
            ...result.overridden.map((reason) => `  forced past: ${reason}`),
          ].join('\n')
    );
    return result;
  }
  throw new ScriptExitError(2, USAGE);
}

export const runAgentWorktree = defineScript({
  name: 'worktree',
  flags: ['json', 'quiet'],
  run: ({ positional, json, print }) => runAgentWorktreeCli({ positional, json }, print),
});

if (
  isDirectScript(import.meta.url, 'agent_worktree.ts') ||
  isDirectScript(import.meta.url, 'agent_worktree.js')
) {
  void runAgentWorktree();
}
