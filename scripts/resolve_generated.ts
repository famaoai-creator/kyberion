#!/usr/bin/env node
/**
 * GF-03: `pnpm kyberion resolve generated` — regenerate every tracked
 * generated artifact in dependency order and stage the results.
 *
 * Use it after a merge/rebase, or whenever a freshness gate reports drift. It
 * works with or without the optional "kyberion-regenerate" merge driver: an
 * unmerged generated file is first rebuilt from its index conflict stages with
 * the driver's own strategy (`git_merge_regenerate.mjs --from-index`), so
 * env-registry.json gets the entry-by-name merge either way. Order:
 *   1. env registry   → env-registry.json, docs/developer/env.example, CONFIGURATION.md
 *   2. knowledge index → knowledge/_index.md (+ the gitignored size manifest)
 *   3. role-assumption reachability report
 *   4. changelog fragments are validated only — assembling them into
 *      CHANGELOG.md is a release step (scripts/assemble_changelog.ts)
 *
 * Flags: --check (no writes; exit 1 on drift), --no-stage (write, do not `git add`).
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';
import {
  clearProcessExitCode,
  defineScript,
  getProcessExitCode,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';
import { main as runEnvRegistry } from './generate_env_registry.js';
import { runGenerateKnowledgeIndex } from './generate_knowledge_index.js';
import { main as runRoleAssumptions } from './analyze_role_assumptions.js';
import { main as runChangelogFragments } from './assemble_changelog.js';

export interface GeneratedArtifactStep {
  id: string;
  /** Tracked outputs to stage after a successful write. */
  tracked: string[];
  run(argv: string[]): Promise<unknown>;
  /** Validation-only steps always run with `--check`. */
  checkOnly?: boolean;
  /** Write passes needed to reach a fixed point (default 1). */
  passes?: number;
}

export const GENERATED_ARTIFACT_STEPS: readonly GeneratedArtifactStep[] = [
  {
    id: 'env-registry',
    tracked: [
      'knowledge/product/governance/env-registry.json',
      'docs/developer/env.example',
      'docs/developer/CONFIGURATION.md',
    ],
    run: (argv) => runEnvRegistry(argv),
    // A newly referenced name is added undocumented on the first pass and
    // promoted with a generated description on the next (mergeRegistry), so
    // one pass leaves the env-registry gate red.
    passes: 2,
  },
  {
    id: 'knowledge-index',
    tracked: ['knowledge/_index.md'],
    run: (argv) => runGenerateKnowledgeIndex(argv),
  },
  {
    id: 'role-assumption-reachability',
    tracked: ['docs/developer/role-assumption-reachability.json'],
    run: (argv) => runRoleAssumptions(argv),
  },
  {
    id: 'changelog-fragments',
    tracked: [],
    checkOnly: true,
    run: (argv) => runChangelogFragments(argv),
  },
];

export async function resolveGeneratedArtifacts(
  options: { check: boolean; stage: boolean },
  steps: readonly GeneratedArtifactStep[] = GENERATED_ARTIFACT_STEPS
): Promise<{ failed: string[]; staged: string[] }> {
  const failed: string[] = [];
  const staged: string[] = [];
  for (const step of steps) {
    const checking = options.check || step.checkOnly === true;
    const passes = checking ? 1 : (step.passes ?? 1);
    let code: number | undefined;
    for (let pass = 0; pass < passes && !code; pass += 1) {
      clearProcessExitCode();
      await step.run(checking ? ['--check', '--quiet'] : ['--quiet']);
      code = getProcessExitCode();
      clearProcessExitCode();
    }
    if (code !== undefined && code !== 0) {
      failed.push(step.id);
      continue;
    }
    if (!options.check && options.stage) staged.push(...step.tracked);
  }
  return { failed, staged };
}

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return safeExecResult('git', args, { cwd: pathResolver.rootDir(), timeoutMs: 60_000 });
}

/** Generated paths git still lists as unmerged (a merge without the driver). */
export function unmergedGeneratedPaths(
  unmergedOutput: string,
  steps: readonly GeneratedArtifactStep[] = GENERATED_ARTIFACT_STEPS
): string[] {
  const tracked = new Set(steps.flatMap((step) => step.tracked));
  return unmergedOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => tracked.has(line));
}

/**
 * Replace conflict markers in unmerged generated files with the merge
 * driver's strategy, computed from the index stages (:1: base, :2: ours,
 * :3: theirs) — so the optional driver is never required. Returns the paths
 * that still need a human (curated env-registry conflicts).
 */
function resolveUnmergedFromIndex(paths: readonly string[]): string[] {
  const unresolved: string[] = [];
  for (const filePath of paths) {
    const result = safeExecResult(
      process.execPath,
      [pathResolver.rootResolve('scripts/git_merge_regenerate.mjs'), '--from-index', filePath],
      { cwd: pathResolver.rootDir(), timeoutMs: 60_000 }
    );
    if (result.status !== 0) unresolved.push(filePath);
  }
  return unresolved;
}

export const DRIVER_HINT =
  'hint: optional merge driver not installed — the repository owner can run `pnpm kyberion resolve install-driver` once so merges keep generated files free of conflict markers.';

function driverInstalled(): boolean | undefined {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0) return undefined;
  return git(['config', '--get', 'merge.kyberion-regenerate.driver']).stdout.trim() !== '';
}

function stagePaths(paths: readonly string[]): void {
  if (paths.length === 0) return;
  const result = git(['add', '--', ...paths]);
  if (result.status !== 0) {
    throw new ScriptExitError(1, `git add failed: ${result.stderr || result.stdout}`);
  }
}

export const main = defineScript({
  name: 'resolve:generated',
  flags: ['check', 'json', 'quiet'],
  async run(context) {
    const stage = !context.argv.includes('--no-stage');
    const installed = driverInstalled();
    if (installed === false && !context.json) context.print(DRIVER_HINT);
    const unmerged = unmergedGeneratedPaths(git(['diff', '--name-only', '--diff-filter=U']).stdout);
    const needsHuman = context.check ? unmerged : resolveUnmergedFromIndex(unmerged);
    if (needsHuman.length > 0) {
      throw new ScriptExitError(
        1,
        context.check
          ? `generated files are still unmerged: ${needsHuman.join(', ')} (run pnpm kyberion resolve generated)`
          : `unmerged generated files need a manual resolution first: ${needsHuman.join(', ')} ` +
              '(env-registry.json: keep both sides of each conflicting entry, then rerun)'
      );
    }
    const { failed, staged } = await resolveGeneratedArtifacts({ check: context.check, stage });
    if (failed.length === 0) stagePaths(staged);
    const summary = {
      ok: failed.length === 0,
      mode: context.check ? 'check' : 'write',
      driver_installed: installed ?? null,
      resolved_from_index: context.check ? [] : unmerged,
      steps: GENERATED_ARTIFACT_STEPS.map((step) => step.id),
      failed,
      staged: failed.length === 0 ? staged : [],
    };
    context.print(summary);
    if (failed.length > 0) {
      throw new ScriptExitError(
        1,
        context.check
          ? `generated artifacts out of date: ${failed.join(', ')} (run pnpm kyberion resolve generated)`
          : `generation failed: ${failed.join(', ')} (rerun the generator directly for details)`
      );
    }
    return summary;
  },
});

if (
  isDirectScript(import.meta.url, 'resolve_generated.ts') ||
  isDirectScript(import.meta.url, 'resolve_generated.js')
)
  void main();
