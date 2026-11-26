/**
 * `pnpm pipeline fix <file> [--write] [--move-profile]`
 * (pipeline-run-manifest-model.md §5).
 *
 * The owner runs it from their own terminal: the rewrite lands in a tenant
 * file, so the normal tier / tenant write rules of the caller apply and a
 * refused write is reported, never worked around. The default is a dry run:
 * the plan, the coverage before and after, a unified diff and the next
 * commands. `--write` keeps a backup on the artifact floor of the file's own
 * partition first and refuses when the file changed since it was read.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from '@agent/core/secure-io';
import type { RunScope } from '@agent/core/pipeline/run-manifest';
import { writeScopedArtifact } from '@agent/core/workforce/artifact-store';
import { createStandardYargs } from '@agent/core/cli-utils';
import { ScriptExitError } from '../lib/harness.js';

/** `--input <file> --fix [--write] [--move-profile] [--json]` (from `pipeline fix <file>`). */
export async function runPipelineFixArgs(
  args: readonly string[],
  print: (value: unknown) => void
): Promise<void> {
  const argv = await createStandardYargs(['node', 'pipeline-fix', ...args])
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('fix', { type: 'boolean', default: true })
    .option('write', {
      type: 'boolean',
      default: false,
      describe: 'Write the fixed file (backup first; refuses if the file changed)',
    })
    .option('move-profile', {
      type: 'boolean',
      default: false,
      describe: 'Also move the user_data_dir profile into the profile partition',
    })
    .option('json', { type: 'boolean', default: false })
    .strict()
    .parseSync();
  await runPipelineFix({
    inputPath: String(argv.input),
    write: argv.write,
    moveProfile: argv['move-profile'],
    json: argv.json,
    print,
  });
}

export interface RunPipelineFixInput {
  inputPath: string;
  /** Write the fixed file (default: dry run). */
  write: boolean;
  /** Also move the existing `user_data_dir` profile into the profile partition. */
  moveProfile: boolean;
  json: boolean;
  print: (value: unknown) => void;
  deps?: {
    deriveScope?: (inputPath: string) => RunScope;
    now?: () => Date;
    /** Test seam: runs after the plan is made, before the file is re-read for the write. */
    beforeWrite?: () => void;
    /** Test seam: keeps the backup elsewhere; returns its path. */
    writeBackup?: (scope: RunScope, sourceText: string, now: Date) => string;
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function readText(absolute: string): string {
  return String(safeReadFile(absolute, { encoding: 'utf8' }));
}

function fixError(code: string, what: string, why: string, next: string): Error {
  return new Error(`[${code}] ${what} — ${why} | next: ${next}`);
}

/** Why the profile directory cannot be moved now, or undefined when it can. */
function profileMoveBlocker(from: string, to: string): string | undefined {
  const source = pathResolver.rootResolve(from);
  if (!safeExistsSync(source)) return `${from} does not exist`;
  // A symlinked folder (or ancestor) would carry a pointer elsewhere into the partition.
  try {
    assertSafeRepositoryPath(source);
    assertSafeRepositoryPath(pathResolver.rootResolve(to), { allowMissingLeaf: true });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!safeStat(source).isDirectory()) return `${from} is not a directory`;
  // Only a browser profile moves — never a job folder that happens to share a floor.
  const entries = safeReaddir(source);
  if (!entries.includes('Local State') && !entries.includes('Default'))
    return `${from} does not look like a browser profile (no "Local State" or "Default")`;
  if (safeExistsSync(pathResolver.rootResolve(to))) return `${to} already exists`;
  // Chromium holds this link while the profile is open.
  if (entries.includes('SingletonLock'))
    return `${from} is in use by a running browser (SingletonLock) — close it first`;
  return undefined;
}

/**
 * Where the backup goes: the artifact floor of the file's own partition
 * (`active/shared/artifacts/<tier>/<tenant>/export/pipeline-fix-backup/`) —
 * never next to the file (a `.bak` in knowledge/ would be read as knowledge)
 * and never the 24h scratch floor (the backup must outlive the review).
 */
export function pipelineFixBackupTarget(
  scope: Pick<RunScope, 'input_path' | 'tier' | 'tenant_slug'>,
  now: Date
): Pick<Parameters<typeof writeScopedArtifact>[0], 'scope' | 'tier' | 'artifact_class' | 'name'> {
  const stem = path.posix.basename(scope.input_path).replace(/\.json$/iu, '');
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  return {
    scope: scope.tenant_slug
      ? { tenant: scope.tenant_slug }
      : scope.tier === 'public'
        ? { system: true }
        : { tenant: 'shared' },
    tier: scope.tier,
    artifact_class: 'export',
    name: `pipeline-fix-backup/${stem}.${stamp}.json`,
  };
}

/** Keep the exact original bytes; returns the repo-relative backup path. */
function writeBackup(scope: RunScope, sourceText: string, now: Date): string {
  return writeScopedArtifact({
    ...pipelineFixBackupTarget(scope, now),
    content: sourceText,
    format: 'text',
    create_only: true,
  }).repo_relative_path;
}

export async function runPipelineFix(input: RunPipelineFixInput): Promise<void> {
  if (/\.(ts|js|mjs|cjs)$/u.test(input.inputPath))
    throw fixError(
      'PIPELINE_FIX_UNSUPPORTED',
      `${input.inputPath} is a workflow module`,
      'only a JSON pipeline has steps the command can rewrite',
      `pnpm pipeline check ${input.inputPath}`
    );
  const { deriveRunScope, planPipelineFix, formatPipelineFixPlan } =
    await import('@agent/core/pipeline/run-manifest');
  const scope = (input.deps?.deriveScope ?? deriveRunScope)(input.inputPath);
  const file = scope.input_path;
  const absolute = pathResolver.rootResolve(input.inputPath);
  const sourceText = readText(absolute);
  const readHash = sha256(sourceText);
  const plan = planPipelineFix({ sourceText, scope });

  const move = input.moveProfile ? plan.profile_move : undefined;
  const moveBlocker = !input.moveProfile
    ? undefined
    : !move
      ? 'no options.user_data_dir is rewritten, so there is no profile to move'
      : (move.refused ?? profileMoveBlocker(move.from, move.to));
  const lines = formatPipelineFixPlan(plan);
  if (input.moveProfile)
    lines.push(
      moveBlocker
        ? ` profile   not moved: ${moveBlocker}`
        : ` profile   ${input.write ? 'moving' : 'would move'} ${move!.from} → ${move!.to}`
    );
  const changes = plan.edits.length > 0;
  const report = {
    ...plan,
    edits: undefined,
    mode: input.write ? 'write' : 'dry_run',
    ...(input.moveProfile ? { profile_move_blocked: moveBlocker ?? null } : {}),
  };

  if (!input.write) {
    if (input.json) input.print(report);
    else {
      for (const line of [...lines, ...plan.diff]) input.print(line);
      if (!changes) input.print(' next: nothing to rewrite — pnpm pipeline check ' + file);
      else if (!plan.refusal) {
        const withMove =
          plan.profile_move && !plan.profile_move.refused && !input.moveProfile
            ? ` (add --move-profile to move ${plan.profile_move.from} too)`
            : input.moveProfile && !moveBlocker
              ? ' --move-profile'
              : '';
        input.print(` next: pnpm pipeline fix ${file} --write${withMove}`);
        input.print(
          ` next: then pnpm kyberion project-trust request ${file} — a rewritten file needs a new approval`
        );
      }
    }
    if (plan.refusal) throw new ScriptExitError(1, '', true, report);
    return;
  }

  if (plan.refusal)
    throw fixError(
      'PIPELINE_FIX_REFUSED',
      `${file} was not written`,
      plan.refusal,
      `pnpm pipeline check ${file}, then fix the steps by hand`
    );
  if (input.moveProfile && moveBlocker)
    throw fixError(
      'PIPELINE_FIX_PROFILE',
      `the profile was not moved and ${file} was not written`,
      moveBlocker,
      `pnpm pipeline fix ${file} --write (without --move-profile)`
    );
  if (!changes) {
    if (input.json) input.print(report);
    else input.print(`[pipeline-fix] ${file}: nothing to rewrite`);
    return;
  }
  input.deps?.beforeWrite?.();
  const assertUnchanged = () => {
    if (sha256(readText(absolute)) !== readHash)
      throw fixError(
        'PIPELINE_FIX_CHANGED',
        `${file} changed after it was read`,
        'writing now would discard that change',
        `pnpm pipeline fix ${file} (re-plan against the current file)`
      );
  };
  assertUnchanged();
  const backup = (input.deps?.writeBackup ?? writeBackup)(
    scope,
    sourceText,
    input.deps?.now?.() ?? new Date()
  );
  let moved = false;
  if (move && input.moveProfile) {
    safeMkdir(path.dirname(pathResolver.rootResolve(move.to)), { recursive: true });
    safeMoveSync(pathResolver.rootResolve(move.from), pathResolver.rootResolve(move.to));
    moved = true;
  }
  try {
    assertUnchanged();
    safeWriteFile(absolute, plan.fixed_text);
  } catch (error) {
    // Leave the profile where the unchanged file expects it.
    if (moved)
      safeMoveSync(pathResolver.rootResolve(move!.to), pathResolver.rootResolve(move!.from));
    throw error;
  }
  if (input.json) {
    input.print({ ...report, backup_path: backup, profile_moved: moved });
    return;
  }
  for (const line of lines) input.print(line);
  input.print(` wrote     ${file}`);
  input.print(` backup    ${backup}`);
  input.print(` next: pnpm pipeline check ${file}`);
  input.print(
    ` next: pnpm kyberion project-trust request ${file}, then pnpm kyberion approvals --approve <request-id> — a rewritten file needs a new approval`
  );
}
