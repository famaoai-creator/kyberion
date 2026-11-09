/**
 * delegate.ts — governed delegation CLI.
 *
 *   pnpm delegate "<instruction>" [--context <text>|--context-file <path>]
 *             [--task <text>|--task-file <path>] [--profile <tier>]
 *             [--mission <id>] [--inactivity-timeout-ms <n>] [--json]
 *   pnpm kyberion delegate ...      (script_commands entry 'delegate default')
 *
 * Dispatches one bounded delegation through the governed reasoning plane:
 * the backend's dispatcher (in-session / process-spawn / harness-subagent)
 * applies the KD-05 capability tier from --profile, the global concurrency
 * and wall-clock budget, and the delegation audit chain. The CLI itself adds
 * nothing to the sub-agent's authority — it only names the tier and carries
 * mission attribution onto the delegation trace.
 *
 * Pre-authorization for what the delegated work may publish does NOT come
 * from this command: standing grants (`pnpm kyberion grants grant`) and dot
 * charters (delegable ops such as `vcs:pr_create`) decide whether an
 * external effect needs a fresh human decision. See
 * knowledge/product/orchestration/delegation-cli-playbook.md.
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeReadFile } from '@agent/core/secure-io';
import {
  getSubagentCapabilityProfile,
  listSubagentCapabilityProfileNames,
} from '@agent/core/subagent-capability-profiles';
import { createDelegationHandle } from '@agent/core/delegated-task-observability';
import { installReasoningBackends } from '@agent/core/reasoning/reasoning-bootstrap';
import { getReasoningBackend } from '@agent/core/reasoning/reasoning-backend';
import { cliOptionValue, cliPositionals, hasHelpFlag } from '@agent/core/cli-guard';
import type {
  ReasoningBackend,
  ReasoningCallOptions,
} from '@agent/core/reasoning/reasoning-backend';
import { defineScript, isDirectScript } from './lib/harness.js';

const VALUE_FLAGS = [
  '--task',
  '--task-file',
  '--context',
  '--context-file',
  '--profile',
  '--mission',
  '--inactivity-timeout-ms',
] as const;

export interface DelegateArgs {
  instruction?: string;
  taskFile?: string;
  context?: string;
  contextFile?: string;
  profile: string;
  missionId?: string;
  inactivityTimeoutMs?: number;
  help: boolean;
}

export interface DelegateDeps {
  /** Injectable for hermetic tests — production default is getReasoningBackend. */
  getBackend?: () => ReasoningBackend;
  /** Injectable for tests — production default installs registered backends once. */
  installBackends?: () => void;
}

export function delegateUsage(): string {
  return [
    'Usage: pnpm delegate "<instruction>" [options]',
    '',
    '  <instruction>                 Task to hand to a governed sub-agent',
    '  --task <text>                 Instruction when positional is inconvenient',
    '  --task-file <path>            Read the instruction from a repo-local file',
    '  --context <text>              Delegation context passed through to the sub-agent',
    '  --context-file <path>         Read context from a repo-local file',
    `  --profile <tier>              KD-05 capability tier: ${listSubagentCapabilityProfileNames().join(', ')} (default: implementer)`,
    '  --mission <id>                Attribute the delegation trace to a mission',
    '  --inactivity-timeout-ms <n>   Semantic inactivity timeout for the delegation',
    '  --json                        Print {status, delegation_id, profile, result} as JSON',
    '',
    'External effects (e.g. opening a PR) still need their own authority:',
    'standing grants / dot charters pre-authorize scopes — see',
    'knowledge/product/orchestration/delegation-cli-playbook.md.',
  ].join('\n');
}

export function parseDelegateArgs(argv: string[]): DelegateArgs {
  const positionals = cliPositionals(argv, [...VALUE_FLAGS]);
  const task = cliOptionValue(argv, '--task');
  const taskFile = cliOptionValue(argv, '--task-file');
  const sources = [positionals[0], task, taskFile].filter((v) => v !== undefined);
  if (sources.length > 1) {
    throw new Error(
      'conflicting instruction sources — pass the task positionally, via --task, or via --task-file, not more than one'
    );
  }
  const inactivityRaw = cliOptionValue(argv, '--inactivity-timeout-ms');
  if (inactivityRaw !== undefined) {
    const value = Number(inactivityRaw);
    if (!/^\d+$/u.test(inactivityRaw) || value < 1 || value > 2147483647) {
      throw new Error('--inactivity-timeout-ms must be an integer between 1 and 2147483647');
    }
  }
  return {
    instruction: task ?? positionals[0],
    taskFile,
    context: cliOptionValue(argv, '--context'),
    contextFile: cliOptionValue(argv, '--context-file'),
    profile: cliOptionValue(argv, '--profile') ?? 'implementer',
    missionId: cliOptionValue(argv, '--mission'),
    inactivityTimeoutMs: inactivityRaw !== undefined ? Number(inactivityRaw) : undefined,
    help: hasHelpFlag(argv),
  };
}

/** Repo-relative file read for --task-file / --context-file (secure-io enforced). */
function readRepoFile(inputPath: string, flag: string): string {
  const resolved = assertSafeRepositoryPath(path.resolve(pathResolver.rootDir(), inputPath), {
    allowMissingLeaf: false,
  });
  const content = safeReadFile(resolved, { encoding: 'utf8' });
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`${flag} is empty or unreadable: ${inputPath}`);
  }
  return content.trim();
}

function resolveInstruction(args: DelegateArgs): string {
  if (args.taskFile) return readRepoFile(args.taskFile, '--task-file');
  const instruction = args.instruction?.trim();
  if (!instruction) {
    throw new Error('missing instruction — pass it positionally, via --task, or via --task-file');
  }
  return instruction;
}

function resolveContext(args: DelegateArgs): string | undefined {
  const parts: string[] = [];
  if (args.missionId) parts.push(`Mission: ${args.missionId}`);
  if (args.contextFile) parts.push(readRepoFile(args.contextFile, '--context-file'));
  if (args.context) parts.push(args.context);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined,
  json = false,
  deps: DelegateDeps = {}
): Promise<void> {
  const args = parseDelegateArgs(argv);
  if (args.help) {
    print(delegateUsage());
    return;
  }
  const profile = getSubagentCapabilityProfile(args.profile);
  const instruction = resolveInstruction(args);
  const context = resolveContext(args);

  (deps.installBackends ?? installReasoningBackends)();
  const backend = (deps.getBackend ?? getReasoningBackend)();

  const options: ReasoningCallOptions = { profile: profile.name };
  if (args.inactivityTimeoutMs !== undefined) {
    options.delegation_inactivity = { timeoutMs: args.inactivityTimeoutMs };
  }

  const handle = createDelegationHandle({
    owner: 'delegate-cli',
    instruction,
    ...(context ? { context } : {}),
    backendName: backend.name,
    ...(args.missionId ? { missionId: args.missionId } : {}),
    execute: (signal) =>
      backend.delegateTask(instruction, context, {
        ...options,
        ...(signal ? { signal } : {}),
      }),
  });

  const result = await handle.join();
  if (json) {
    print({
      status: 'ok',
      delegation_id: handle.delegation_id,
      profile: profile.name,
      ...(args.missionId ? { mission: args.missionId } : {}),
      result,
    });
    return;
  }
  print(result);
}

const script = defineScript({
  name: 'delegate',
  flags: ['json'],
  run: ({ argv, print, json }) => main(argv, print, json),
});
if (
  isDirectScript(import.meta.url, 'delegate.ts') ||
  isDirectScript(import.meta.url, 'delegate.js')
) {
  void script();
}
