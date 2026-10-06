import { logger } from '@agent/core/core';
import { createAjv } from '@agent/core/foundation';
import * as pathResolver from '@agent/core/path-resolver';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import { safeExecResult } from '@agent/core/secure-io';
import {
  ghAuthStatus,
  gitAddAll,
  gitBranch,
  gitCommit,
  gitDiff,
  gitLog,
  gitStatus,
  ghPrChecks,
  ghPrChecksWait,
  ghPrCreate,
  ghPrList,
  ghPrMerge,
  ghPrView,
  ghRepoDefaultBranch,
  ghVersion,
  gitCheckout,
  gitFetch,
  gitPull,
  gitPush,
  gitWorktree,
} from '@agent/core/vcs';
import type { ValidateFunction } from 'ajv';

export type VcsOp =
  | 'status'
  | 'diff'
  | 'log'
  | 'branch'
  | 'commit'
  | 'pr_create'
  | 'push'
  | 'fetch'
  | 'pull'
  | 'checkout'
  | 'worktree'
  | 'pr_view'
  | 'pr_list'
  | 'pr_checks'
  | 'pr_merge'
  | 'repo_view'
  | 'gh_status';

export type VcsParams = {
  cwd?: string;
  short?: boolean;
  ref?: string;
  stat?: boolean;
  limit?: number;
  oneline?: boolean;
  action?: 'list' | 'create' | 'delete' | 'add' | 'remove' | 'prune';
  name?: string;
  message?: string;
  add?: boolean;
  title?: string;
  body?: string;
  base?: string;
  remote?: string;
  set_upstream?: boolean;
  create_branch?: boolean;
  path?: string;
  state?: 'open' | 'closed' | 'merged' | 'all';
  fields?: string;
  method?: 'merge' | 'squash' | 'rebase';
  delete_branch?: boolean;
  watch?: boolean;
  interval_ms?: number;
  timeout_ms?: number;
  ignore_checks?: string[];
  draft?: boolean;
  head?: string;
};

export type VcsAction = {
  op: VcsOp;
  params?: VcsParams;
};

const VCS_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/vcs-action.schema.json'
);

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = createAjv();
  cachedValidator = compileSchemaFromPath(ajv, VCS_SCHEMA_PATH);
  return cachedValidator;
}

function missingRequiredFields(action: VcsAction): string[] {
  const params = action.params || {};
  switch (action.op) {
    case 'commit': {
      if (!params.message?.trim()) return ['params.message (e.g. "Checkpoint mission progress")'];
      return [];
    }
    case 'pr_create': {
      if (!params.title?.trim()) return ['params.title (e.g. "Add vcs-actuator")'];
      return [];
    }
    case 'branch': {
      const missing: string[] = [];
      if (!params.action) {
        missing.push('params.action ("list" | "create" | "delete")');
      } else if (
        (params.action === 'create' || params.action === 'delete') &&
        !params.name?.trim()
      ) {
        missing.push('params.name (required for branch create/delete)');
      }
      return missing;
    }
    default:
      return [];
  }
}

function validateAction(input: unknown): VcsAction {
  const validate = getValidator();
  if (!validate(input)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
      .join('; ');
    throw new Error(`vcs-actuator: invalid input: ${errors}`);
  }
  const action = input as VcsAction;
  const missing = missingRequiredFields(action);
  if (missing.length) {
    throw new Error(`vcs-actuator: missing required fields: ${missing.join(', ')}`);
  }
  return action;
}

function resolveCwd(params: VcsParams): string {
  return params.cwd || pathResolver.rootResolve('.');
}

const runGhResult = safeExecResult;

function assertOk(
  result: { status: number | null; stderr?: string; error?: Error },
  label: string
): void {
  if (result.error || result.status !== 0) {
    throw asActionableError(
      new Error(result.stderr || result.error?.message || `exit ${result.status}`),
      label.startsWith('gh') ? 'gh' : 'git',
      'Install git and the GitHub CLI, and authenticate with `gh auth login`.'
    );
  }
}

function asActionableError(error: unknown, bin: string, installStep: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found|not recognized|command not found|spawn .* failed/i.test(message)) {
    return new Error(`vcs-actuator: required binary '${bin}' not found. ${installStep}`);
  }
  return error instanceof Error ? error : new Error(message);
}

export async function handleAction(action: VcsAction): Promise<unknown> {
  const valid = validateAction(action);
  const params = valid.params || {};
  const cwd = resolveCwd(params);
  logger.info(`[vcs-actuator] ${valid.op} (cwd: ${cwd})`);

  switch (valid.op) {
    case 'status': {
      const result = gitStatus(cwd, { short: params.short });
      assertOk(result, 'git status');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'diff': {
      const result = gitDiff(cwd, { stat: params.stat, ref: params.ref });
      assertOk(result, 'git diff');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'log': {
      const result = gitLog(cwd, { limit: params.limit, oneline: params.oneline });
      assertOk(result, 'git log');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'branch': {
      // `action` is shared with the worktree op — branch only accepts
      // list/create/delete; 'add'/'remove'/'prune' must NOT fall through to
      // `git branch -d` (destructive on an "add" intent).
      const branchAction = params.action;
      if (!['list', 'create', 'delete'].includes(branchAction as string)) {
        throw new Error('vcs-actuator: branch requires params.action (list|create|delete)');
      }
      const result = gitBranch(cwd, branchAction as 'list' | 'create' | 'delete', params.name);
      assertOk(result, 'git branch');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'commit': {
      if (params.add) {
        assertOk(gitAddAll(cwd), 'git add -A');
      }
      const result = gitCommit(cwd, (params.message as string).trim());
      assertOk(result, 'git commit');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'pr_create': {
      const result = ghPrCreate(
        {
          title: (params.title as string).trim(),
          body: params.body,
          base: params.base,
          head: params.head,
          draft: params.draft,
          cwd,
        },
        runGhResult
      );
      if (result.error || result.status !== 0) {
        throw asActionableError(
          new Error(result.stderr || `exit ${result.status}`),
          'gh',
          'Install the GitHub CLI from https://cli.github.com/ and authenticate with `gh auth login`.'
        );
      }
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'push': {
      const result = gitPush(cwd, {
        remote: params.remote,
        ref: params.ref,
        setUpstream: params.set_upstream,
      });
      assertOk(result, 'git push');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'fetch': {
      const result = gitFetch(cwd, { remote: params.remote, ref: params.ref });
      assertOk(result, 'git fetch');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'pull': {
      const result = gitPull(cwd, { remote: params.remote, ref: params.ref });
      assertOk(result, 'git pull');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'checkout': {
      if (!params.ref?.trim()) {
        throw new Error('vcs-actuator: missing required fields: params.ref (checkout target)');
      }
      const result = gitCheckout(cwd, params.ref, { createBranch: params.create_branch === true });
      assertOk(result, 'git checkout');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'worktree': {
      const action = params.action as 'list' | 'add' | 'remove' | 'prune';
      if (!['list', 'add', 'remove', 'prune'].includes(action)) {
        throw new Error('vcs-actuator: worktree requires params.action (list|add|remove|prune)');
      }
      const result = gitWorktree(cwd, action, { path: params.path, ref: params.ref });
      assertOk(result, 'git worktree');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'pr_view': {
      if (!params.ref?.trim()) throw new Error('vcs-actuator: pr_view requires params.ref');
      return {
        op: valid.op,
        cwd,
        result: ghPrView(
          { ref: params.ref, fields: params.fields || 'number,title,state,url', cwd },
          runGhResult
        ),
      };
    }
    case 'pr_list': {
      return {
        op: valid.op,
        cwd,
        result: ghPrList({ state: params.state, limit: params.limit, cwd }, runGhResult),
      };
    }
    case 'pr_checks': {
      if (!params.ref?.trim()) throw new Error('vcs-actuator: pr_checks requires params.ref');
      const shared = { ref: params.ref, cwd, ignore: params.ignore_checks };
      const result = params.watch
        ? await ghPrChecksWait(
            { ...shared, intervalMs: params.interval_ms, timeoutMs: params.timeout_ms },
            runGhResult
          )
        : ghPrChecks(shared, runGhResult);
      return { op: valid.op, cwd, result };
    }
    case 'pr_merge': {
      if (!params.ref?.trim()) throw new Error('vcs-actuator: pr_merge requires params.ref');
      const result = ghPrMerge(
        { ref: params.ref, method: params.method, deleteBranch: params.delete_branch, cwd },
        runGhResult
      );
      assertOk(result, 'gh pr merge');
      return { op: valid.op, cwd, output: result.stdout };
    }
    case 'repo_view': {
      return {
        op: valid.op,
        cwd,
        result: { default_branch: ghRepoDefaultBranch({ cwd }, runGhResult) },
      };
    }
    case 'gh_status': {
      const version = ghVersion({ cwd }, runGhResult);
      const auth = ghAuthStatus({ cwd }, runGhResult);
      return {
        op: valid.op,
        cwd,
        result: {
          version: version.stdout.trim().split('\n')[0] || '',
          auth_ok: auth.status === 0 && !auth.error,
          auth_output: (auth.stdout || auth.stderr || '').trim(),
        },
      };
    }
    default: {
      const _exhaustive: never = valid.op;
      throw new Error(`Unsupported operation: ${String(_exhaustive)}`);
    }
  }
}
