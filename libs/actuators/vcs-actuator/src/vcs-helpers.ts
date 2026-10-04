import { logger } from '@agent/core/core';
import { createAjv } from '@agent/core/foundation';
import * as pathResolver from '@agent/core/path-resolver';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import { safeExec } from '@agent/core/secure-io';
import type { ValidateFunction } from 'ajv';

export type VcsOp = 'status' | 'diff' | 'log' | 'branch' | 'commit' | 'pr_create';

export type VcsParams = {
  cwd?: string;
  short?: boolean;
  ref?: string;
  stat?: boolean;
  limit?: number;
  oneline?: boolean;
  action?: 'list' | 'create' | 'delete';
  name?: string;
  message?: string;
  add?: boolean;
  title?: string;
  body?: string;
  base?: string;
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

function runGit(args: string[], cwd: string): string {
  try {
    return safeExec('git', args, { cwd });
  } catch (error: unknown) {
    throw asActionableError(
      error,
      'git',
      'Install git from https://git-scm.com/downloads and ensure it is on PATH.'
    );
  }
}

function runGh(args: string[], cwd: string): string {
  try {
    return safeExec('gh', args, { cwd });
  } catch (error: unknown) {
    throw asActionableError(
      error,
      'gh',
      'Install the GitHub CLI from https://cli.github.com/ and authenticate with `gh auth login`.'
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
      const args = params.short ? ['status', '--short'] : ['status'];
      return { op: valid.op, cwd, output: runGit(args, cwd) };
    }
    case 'diff': {
      const args = ['diff'];
      if (params.stat) args.push('--stat');
      if (params.ref?.trim()) args.push(params.ref.trim());
      return { op: valid.op, cwd, output: runGit(args, cwd) };
    }
    case 'log': {
      const args = ['log'];
      if (params.oneline) args.push('--oneline');
      if (Number.isInteger(params.limit) && Number(params.limit) > 0) {
        args.push('-n', String(params.limit));
      }
      return { op: valid.op, cwd, output: runGit(args, cwd) };
    }
    case 'branch': {
      const branchAction = params.action as 'list' | 'create' | 'delete';
      if (branchAction === 'list') {
        return { op: valid.op, cwd, output: runGit(['branch', '--list'], cwd) };
      }
      const branchName = params.name?.trim() as string;
      if (branchAction === 'create') {
        return { op: valid.op, cwd, output: runGit(['branch', branchName], cwd) };
      }
      return { op: valid.op, cwd, output: runGit(['branch', '-d', branchName], cwd) };
    }
    case 'commit': {
      if (params.add) {
        runGit(['add', '-A'], cwd);
      }
      const output = runGit(['commit', '-m', (params.message as string).trim()], cwd);
      return { op: valid.op, cwd, output };
    }
    case 'pr_create': {
      const args = ['pr', 'create', '--title', (params.title as string).trim()];
      if (params.body?.trim()) args.push('--body', params.body.trim());
      if (params.base?.trim()) args.push('--base', params.base.trim());
      return { op: valid.op, cwd, output: runGh(args, cwd) };
    }
    default: {
      const _exhaustive: never = valid.op;
      throw new Error(`Unsupported operation: ${String(_exhaustive)}`);
    }
  }
}
