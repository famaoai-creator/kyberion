/**
 * M2 agent worktrees: one git worktree per provider agent, so several CLIs
 * (claude / codex / devin / gemini / …) develop in parallel without sharing
 * one checkout's branch, index and `dist/`.
 *
 * Operator-run only (a human or the mission owner — never a worker CLI):
 * every mutation goes through the mission-owner git guard. The worktree is a
 * WS-05 `git-worktree` workspace under the gitignored `.worktrees/` root, so
 * the workspace ledger owns its deletion and the WS-06 budget bounds it; the
 * agent-facing metadata (name, branch, agent, base) lives in a small registry
 * under `active/shared/runtime/agent-worktrees/`.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { knowledge, rootDir, shared } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeRealpath,
  safeWriteFile,
} from '../secure-io.js';
import { assertMissionOwnerPath } from '../mission/mission-git.js';
import { checkWorkspaceBudget, type WorkspaceBudgetOptions } from './workspace-budget.js';
import {
  deleteRegisteredWorkspace,
  describeUnsavedWorktreeWork,
  listWorkspaces,
  registerWorkspace,
  WORKTREES_ROOT_REPO_PATH,
  type WorkspaceLedgerOptions,
} from './workspace-ledger.js';
import { missionOwnerTerminal } from './workspace-sweep.js';

/** Provider CLIs a worktree can be launched for, with the command that starts each. */
export const AGENT_WORKTREE_LAUNCHERS = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  devin: 'devin',
  agy: 'agy',
  grok: 'grok',
  copilot: 'copilot',
  cursor: 'cursor-agent',
  opencode: 'opencode',
} as const;

export type AgentWorktreeAgent = keyof typeof AGENT_WORKTREE_LAUNCHERS;

export const AGENT_WORKTREE_REGISTRY_SUBPATH = 'runtime/agent-worktrees/registry.json';
/** Directory-name prefix under `.worktrees/`, distinct from WS-03 session worktrees. */
export const AGENT_WORKTREE_DIR_PREFIX = 'agent-';
/** Written by the bootstrap (and the cloud session-start hook): the HEAD dist/ was built from. */
export const DIST_BUILD_STAMP = path.join('dist', '.session-build-head');

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// git check-ref-format essentials (same rule set as the change-request link).
const INVALID_BRANCH = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|^[-/]|\/$|\.lock$|\.$|\/\//;

export interface AgentWorktreeRecord {
  name: string;
  /** Absolute worktree path (also the workspace ledger key). */
  path: string;
  branch: string;
  /** Start point a new branch was created from; null when an existing branch was checked out. */
  base: string | null;
  agent?: AgentWorktreeAgent;
  mission_id?: string;
  /** Workspace ledger id (`ws-…`) that owns the directory. */
  workspace_id: string;
  repo_root: string;
  created_at: string;
}

export type DistFreshness = 'fresh' | 'stale' | 'unstamped' | 'missing';

export interface AgentWorktreeStatus extends AgentWorktreeRecord {
  exists: boolean;
  /** Branch currently checked out in the worktree (may differ from `branch` after a switch). */
  checked_out: string | null;
  head: string | null;
  dist: DistFreshness;
  dist_built_from: string | null;
  deps_installed: boolean;
}

export interface AgentWorktreeOptions {
  /** Test seam: repository the worktrees belong to (defaults to the Kyberion root). */
  repoRoot?: string;
  /** Test seam: directory holding the worktrees (defaults to `<repoRoot>/.worktrees`). */
  worktreesRoot?: string;
  /** Test seam: registry file (defaults to active/shared/runtime/agent-worktrees/registry.json). */
  registryPath?: string;
  ledger?: WorkspaceLedgerOptions;
  budget?: Omit<WorkspaceBudgetOptions, keyof WorkspaceLedgerOptions>;
  now?: () => Date;
}

const REGISTRY_SCHEMA_PATH = knowledge('product/schemas/agent-worktree-registry.schema.json');

function registryCatalog(filePath: string) {
  return defineCatalog<AgentWorktreeRecord[]>({
    id: 'agent-worktree-registry',
    path: filePath,
    schema: REGISTRY_SCHEMA_PATH,
  });
}

function registryPathOf(options: AgentWorktreeOptions): string {
  return assertSafeRepositoryPath(options.registryPath ?? shared(AGENT_WORKTREE_REGISTRY_SUBPATH), {
    allowMissingLeaf: true,
  });
}

function readRegistry(options: AgentWorktreeOptions): AgentWorktreeRecord[] {
  const filePath = registryPathOf(options);
  if (!safeExistsSync(filePath)) return [];
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[AGENT_WORKTREE_REGISTRY] registry must be a regular file: ${filePath}`);
  }
  return registryCatalog(filePath).load();
}

function mutateRegistry<T>(
  options: AgentWorktreeOptions,
  fn: (records: AgentWorktreeRecord[]) => { records: AgentWorktreeRecord[] | null; result: T }
): T {
  const filePath = registryPathOf(options);
  const lockId = `agent-worktrees-${createHash('sha256').update(filePath, 'utf8').digest('hex')}`;
  return withLockSync(lockId, () => {
    const { records, result } = fn(readRegistry(options));
    if (records) {
      const validated = registryCatalog(filePath).validate(records, filePath);
      safeMkdir(path.dirname(filePath), { recursive: true });
      safeWriteFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' });
    }
    return result;
  });
}

function git(cwd: string, args: string[], timeoutMs = 60_000) {
  return safeExecResult('git', args, { cwd, timeoutMs });
}

function gitText(cwd: string, args: string[]): string | null {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function refExists(repoRoot: string, ref: string): boolean {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

export function validateAgentWorktreeName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `[AGENT_WORKTREE] invalid name "${name}": use 1-63 lowercase letters, digits or '-'`
    );
  }
  return name;
}

export function parseAgentWorktreeAgent(agent: string): AgentWorktreeAgent {
  if (!Object.prototype.hasOwnProperty.call(AGENT_WORKTREE_LAUNCHERS, agent)) {
    throw new Error(
      `[AGENT_WORKTREE] unknown agent "${agent}" (one of ${Object.keys(AGENT_WORKTREE_LAUNCHERS).join(', ')})`
    );
  }
  return agent as AgentWorktreeAgent;
}

function validateBranch(branch: string): string {
  const trimmed = branch.trim().replace(/^refs\/heads\//, '');
  if (!trimmed || INVALID_BRANCH.test(trimmed)) {
    throw new Error(`[AGENT_WORKTREE] invalid branch name: ${branch}`);
  }
  return trimmed;
}

/** `cd` + launch command for the worktree (the provider CLI must start at the worktree root). */
export function agentWorktreeLaunchHint(record: Pick<AgentWorktreeRecord, 'path' | 'agent'>): {
  cd: string;
  launch: string | null;
} {
  const quoted = /^[A-Za-z0-9_./-]+$/.test(record.path)
    ? record.path
    : `'${record.path.replace(/'/g, `'\\''`)}'`;
  return {
    cd: `cd ${quoted}`,
    launch: record.agent ? AGENT_WORKTREE_LAUNCHERS[record.agent] : null,
  };
}

export interface CreateAgentWorktreeInput {
  name: string;
  /** Branch to check out; created from `base` when it does not exist locally. Default `worktree/<name>`. */
  branch?: string;
  /** Start point for a new branch. Default `origin/main` when it resolves, else `HEAD`. */
  base?: string;
  agent?: string;
  mission_id?: string;
}

/**
 * Create a worktree for `branch` under `.worktrees/agent-<name>`, owned by the
 * workspace ledger (registered before `git worktree add`, removed on failure)
 * and recorded in the agent-worktree registry. Owner path only.
 */
export function createAgentWorktree(
  input: CreateAgentWorktreeInput,
  options: AgentWorktreeOptions = {}
): AgentWorktreeRecord {
  assertMissionOwnerPath('create an agent worktree');
  const name = validateAgentWorktreeName(input.name);
  const agent = input.agent ? parseAgentWorktreeAgent(input.agent) : undefined;
  const branch = validateBranch(input.branch ?? `worktree/${name}`);
  // The ledger rejects the repository root itself as a path; omitting repoRoot
  // there means "the Kyberion root".
  const repoRoot = options.repoRoot ? assertSafeRepositoryPath(options.repoRoot) : rootDir();
  const worktreesRoot = options.worktreesRoot ?? path.join(repoRoot, WORKTREES_ROOT_REPO_PATH);
  const dir = path.join(worktreesRoot, `${AGENT_WORKTREE_DIR_PREFIX}${name}`);
  const ledger = options.ledger ?? {};

  if (readRegistry(options).some((record) => record.name === name)) {
    throw new Error(`[AGENT_WORKTREE_EXISTS] an agent worktree named "${name}" already exists`);
  }
  if (safeExistsSync(dir)) {
    throw new Error(`[AGENT_WORKTREE_EXISTS] ${dir} already exists (unregistered); not reused`);
  }
  // Never inside tracked content: a worktree inside the checkout must be ignored by it.
  const relative = path.relative(repoRoot, dir);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    if (git(repoRoot, ['check-ignore', '-q', '--no-index', relative]).status !== 0) {
      throw new Error(`[AGENT_WORKTREE_PATH] ${relative} is not gitignored in ${repoRoot}`);
    }
  }

  const branchExists = refExists(repoRoot, `refs/heads/${branch}`);
  let base: string | null = null;
  if (!branchExists) {
    base = input.base ?? (refExists(repoRoot, 'origin/main') ? 'origin/main' : 'HEAD');
    if (!refExists(repoRoot, base)) {
      throw new Error(`[AGENT_WORKTREE] base ${base} does not resolve to a commit`);
    }
  } else if (input.base) {
    throw new Error(
      `[AGENT_WORKTREE] branch ${branch} already exists; --base applies only to a new branch`
    );
  }

  const budget = checkWorkspaceBudget(dir, 0, { ...ledger, ...options.budget });
  if (!budget.allowed) {
    throw new Error(
      `[AGENT_WORKTREE_BUDGET] workspace budget denied a worktree (${budget.reason})`
    );
  }
  const workspace = registerWorkspace(
    {
      path: dir,
      kind: 'git-worktree',
      owner: {
        session_id: `agent-worktree-${name}`,
        ...(input.mission_id ? { mission_id: input.mission_id } : {}),
      },
      ...(repoRoot !== rootDir() ? { repoRoot } : {}),
    },
    ledger
  );
  // `--no-track`: a branch started from origin/main must not push to main.
  const added = git(
    repoRoot,
    branchExists
      ? ['worktree', 'add', workspace.path, branch]
      : ['worktree', 'add', '--no-track', '-b', branch, workspace.path, base as string],
    120_000
  );
  if (added.status !== 0) {
    deleteRegisteredWorkspace(workspace.id, ledger);
    throw new Error(`[AGENT_WORKTREE] git worktree add failed: ${added.stderr.trim()}`);
  }
  const record: AgentWorktreeRecord = {
    name,
    path: workspace.path,
    branch,
    base,
    ...(agent ? { agent } : {}),
    ...(input.mission_id ? { mission_id: input.mission_id } : {}),
    workspace_id: workspace.id,
    repo_root: repoRoot,
    created_at: (options.now ? options.now() : new Date()).toISOString(),
  };
  mutateRegistry(options, (records) => ({ records: [...records, record], result: null }));
  return record;
}

function distFreshness(
  dir: string,
  head: string | null
): Pick<AgentWorktreeStatus, 'dist' | 'dist_built_from'> {
  if (!safeExistsSync(path.join(dir, 'dist'))) return { dist: 'missing', dist_built_from: null };
  const stampPath = path.join(dir, DIST_BUILD_STAMP);
  if (!safeExistsSync(stampPath)) return { dist: 'unstamped', dist_built_from: null };
  const builtFrom = String(safeReadFile(stampPath, { encoding: 'utf8' })).trim() || null;
  return { dist: builtFrom && builtFrom === head ? 'fresh' : 'stale', dist_built_from: builtFrom };
}

/** Registered agent worktrees with their live git and dist state. Read-only. */
export function listAgentWorktrees(options: AgentWorktreeOptions = {}): AgentWorktreeStatus[] {
  return readRegistry(options).map((record) => {
    const exists = safeExistsSync(record.path);
    const head = exists ? gitText(record.path, ['rev-parse', 'HEAD']) : null;
    const branch = exists ? gitText(record.path, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
    return {
      ...record,
      exists,
      checked_out: branch === 'HEAD' ? 'detached' : branch,
      head,
      ...(exists ? distFreshness(record.path, head) : { dist: 'missing', dist_built_from: null }),
      deps_installed: exists && safeExistsSync(path.join(record.path, 'node_modules')),
    };
  });
}

/** A live claim on the WorkItem behind the worktree's branch (resolved by the caller). */
export interface AgentWorktreeClaim {
  item_id: string;
  owner: string;
}

export interface RemoveAgentWorktreeInput {
  name: string;
  force?: boolean;
  /** Live, unfinished claim on the branch's change request, when the caller could resolve one. */
  claim?: AgentWorktreeClaim | null;
}

export interface RemoveAgentWorktreeResult {
  record: AgentWorktreeRecord;
  removedFromDisk: boolean;
  /** Reasons that would have refused the removal; non-empty only with `force`. */
  overridden: string[];
}

/** Why removing this worktree would lose work or pull it from under its owner. */
export function describeAgentWorktreeRemovalBlockers(
  record: AgentWorktreeRecord,
  claim: AgentWorktreeClaim | null | undefined
): string[] {
  const blockers: string[] = [];
  if (safeExistsSync(record.path)) {
    const unsaved = describeUnsavedWorktreeWork(record.path);
    if (unsaved) blockers.push(unsaved);
  }
  if (record.mission_id && !missionOwnerTerminal({ mission_id: record.mission_id })) {
    blockers.push(`mission ${record.mission_id} is not terminal`);
  }
  if (claim) blockers.push(`work item ${claim.item_id} is claimed by ${claim.owner}`);
  return blockers;
}

/**
 * Remove an agent worktree through the workspace ledger (`git worktree remove`
 * on the owner path) and drop its registry entry. Refuses with uncommitted or
 * unreachable work, a non-terminal mission or a live claim unless `force`.
 * The branch itself is kept.
 */
export function removeAgentWorktree(
  input: RemoveAgentWorktreeInput,
  options: AgentWorktreeOptions = {}
): RemoveAgentWorktreeResult {
  assertMissionOwnerPath('remove an agent worktree');
  const name = validateAgentWorktreeName(input.name);
  const record = readRegistry(options).find((candidate) => candidate.name === name);
  if (!record) throw new Error(`[AGENT_WORKTREE_NOT_FOUND] no agent worktree named "${name}"`);
  const blockers = describeAgentWorktreeRemovalBlockers(record, input.claim);
  if (blockers.length > 0 && !input.force) {
    throw new Error(
      `[AGENT_WORKTREE_BUSY] ${record.path} kept: ${blockers.join('; ')} (re-run with --force to remove anyway)`
    );
  }
  const ledger = options.ledger ?? {};
  let removedFromDisk = false;
  if (listWorkspaces(ledger).some((workspace) => workspace.id === record.workspace_id)) {
    removedFromDisk = deleteRegisteredWorkspace(record.workspace_id, ledger, {
      requireCleanWorktree: !input.force,
    }).removedFromDisk;
  } else if (safeExistsSync(record.path)) {
    // Only ledger-registered paths are ever deleted.
    throw new Error(
      `[AGENT_WORKTREE_UNREGISTERED] ${record.path} has no workspace ledger record; not deleted`
    );
  }
  git(record.repo_root, ['worktree', 'prune']);
  mutateRegistry(options, (records) => ({
    records: records.filter((candidate) => candidate.name !== name),
    result: null,
  }));
  return { record, removedFromDisk, overridden: input.force ? blockers : [] };
}

export interface BootstrapStep {
  command: string;
  status: number | null;
  /** Tail of stderr (or stdout) when the step failed. */
  detail?: string;
}

/**
 * `pnpm install --prefer-offline` + `pnpm build` inside the worktree, then
 * stamp `dist/.session-build-head` with the built HEAD so `list` can report
 * freshness. Stops at the first failing step.
 */
export function bootstrapAgentWorktree(record: Pick<AgentWorktreeRecord, 'path'>): BootstrapStep[] {
  assertMissionOwnerPath('bootstrap an agent worktree');
  const steps: BootstrapStep[] = [];
  for (const [args, timeoutMs] of [
    [['install', '--prefer-offline'], 600_000],
    [['run', 'build'], 1_800_000],
  ] as const) {
    const result = safeExecResult('pnpm', [...args], {
      cwd: record.path,
      timeoutMs,
      maxOutputMB: 64,
    });
    const step: BootstrapStep = { command: `pnpm ${args.join(' ')}`, status: result.status };
    if (result.status !== 0) {
      const text = (result.stderr.trim() || result.stdout.trim() || result.error?.message || '')
        .split('\n')
        .slice(-20)
        .join('\n');
      steps.push({ ...step, detail: text });
      return steps;
    }
    steps.push(step);
  }
  const stampResult = stampAgentWorktreeDistHead(record.path);
  steps.push({
    command: `stamp ${DIST_BUILD_STAMP}`,
    status: stampResult.ok ? 0 : 1,
    ...(stampResult.ok ? {} : { detail: stampResult.detail }),
  });
  return steps;
}

/**
 * Stamp `dist/.session-build-head` inside a worktree with the HEAD dist was
 * built from, so `list` can report freshness. The file lands under
 * `.worktrees/`, which no persona tier-guard allow_write pattern covers — the
 * mission-owner git guard is the authorization boundary, so the file goes
 * through the same exec channel the `git worktree` mutations use instead of
 * a policy-gated write. Self-guards like every other mutation verb here.
 */
export function stampAgentWorktreeDistHead(worktreePath: string): {
  ok: boolean;
  detail?: string;
} {
  assertMissionOwnerPath('stamp an agent worktree dist head');
  // A nested path still resolves `rev-parse` against a parent checkout; only
  // stamp when the worktree is its own git toplevel, so the file never
  // records a foreign HEAD as the dist provenance.
  const toplevel = gitText(worktreePath, ['rev-parse', '--show-toplevel']);
  let realWorktreePath: string;
  try {
    realWorktreePath = safeRealpath(worktreePath);
  } catch {
    return { ok: false, detail: 'worktree path does not resolve inside the repository' };
  }
  if (!toplevel || path.normalize(toplevel) !== path.normalize(realWorktreePath)) {
    return { ok: false, detail: 'path is not its own git worktree toplevel' };
  }
  const head = gitText(worktreePath, ['rev-parse', 'HEAD']);
  if (!head) return { ok: false, detail: 'no HEAD rev-parse in worktree' };
  // The exec write follows symlinks; a planted `dist/` link would redirect
  // the mission-owner write outside the worktree, so refuse anything that
  // is not a real directory before touching it.
  const distDir = path.join(realWorktreePath, 'dist');
  if (safeExistsSync(distDir)) {
    const distStat = safeLstat(distDir);
    if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
      return { ok: false, detail: 'worktree dist/ is not a real directory' };
    }
  }
  const stampPath = path.join(realWorktreePath, DIST_BUILD_STAMP);
  const stamp = safeExecResult(
    process.execPath,
    [
      '-e',
      'require("node:fs").mkdirSync(require("node:path").dirname(process.argv[1]),{recursive:true});require("node:fs").writeFileSync(process.argv[1],process.argv[2])',
      stampPath,
      `${head}\n`,
    ],
    { cwd: realWorktreePath, timeoutMs: 15_000 }
  );
  if (stamp.status !== 0) {
    return {
      ok: false,
      detail: (stamp.stderr.trim() || stamp.stdout.trim() || 'stamp write failed')
        .split('\n')
        .slice(-20)
        .join('\n'),
    };
  }
  return { ok: true };
}
