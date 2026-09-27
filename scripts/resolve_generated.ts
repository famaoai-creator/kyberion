#!/usr/bin/env node
/**
 * GF-03: `pnpm kyberion resolve generated` — regenerate every tracked
 * generated artifact in dependency order and stage the results.
 *
 * Use it after a merge/rebase (the "kyberion-regenerate" merge driver keeps a
 * conflicted generated file on one side and asks for this), or whenever a
 * freshness gate reports drift. Order:
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
    clearProcessExitCode();
    await step.run(options.check || step.checkOnly ? ['--check', '--quiet'] : ['--quiet']);
    const code = getProcessExitCode();
    clearProcessExitCode();
    if (code !== undefined && code !== 0) {
      failed.push(step.id);
      continue;
    }
    if (!options.check && options.stage) staged.push(...step.tracked);
  }
  return { failed, staged };
}

function stagePaths(paths: readonly string[]): void {
  if (paths.length === 0) return;
  const result = safeExecResult('git', ['add', '--', ...paths], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 60_000,
  });
  if (result.status !== 0) {
    throw new ScriptExitError(1, `git add failed: ${result.stderr || result.stdout}`);
  }
}

export const main = defineScript({
  name: 'resolve:generated',
  flags: ['check', 'json', 'quiet'],
  async run(context) {
    const stage = !context.argv.includes('--no-stage');
    const { failed, staged } = await resolveGeneratedArtifacts({ check: context.check, stage });
    if (failed.length === 0) stagePaths(staged);
    const summary = {
      ok: failed.length === 0,
      mode: context.check ? 'check' : 'write',
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
