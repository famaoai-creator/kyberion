#!/usr/bin/env node
/**
 * `pnpm kyberion pr preflight` — the `pr create` readiness gates without
 * creating a pull request (dev-cycle plan M1).
 *
 * An implementer (or a dedicated preflight agent) runs this before `git push`
 * so the branch reaches CI with the same evidence `pr create` would demand:
 * the PR title policy, `pnpm check -- --changed` (every pr gate plus the
 * full-only gates whose `paths` match the changed files), and — when a body
 * file is given — the KL-03 Knowledge-in-PR check. Nothing here talks to gh.
 */

import {
  parsePublishArgs,
  PRE_PR_READINESS_CHECKLIST,
  resolvePublishTitle,
  runKnowledgeReadinessGate,
  runPrePrReadiness,
} from './publish_pull_request.js';
import { defineScript, isDirectScript } from './lib/harness.js';
import { guardCliArgsNormalized, type CliGuardSpec } from './lib/cli-guard.js';

type Print = (value: unknown) => void;

export const PREFLIGHT_PR_CLI: CliGuardSpec = {
  command: 'pnpm kyberion pr preflight',
  manifestId: 'script.pr.preflight',
  options: [
    { flag: '--title', value: '<conventional title>' },
    { flag: '--body-file', value: '<path>' },
    { flag: '--base', value: '<branch>' },
    { flag: '--mission-root', value: '<path>' },
    { flag: '--check-jobs', value: '<1..6>' },
  ],
};

export async function main(argv: string[], print: Print = () => undefined): Promise<void> {
  const guarded = guardCliArgsNormalized(argv, PREFLIGHT_PR_CLI, print);
  if (guarded.handled) return;
  const options = parsePublishArgs(guarded.argv);

  const title = resolvePublishTitle(options.title);
  print(`[pr:preflight] PR title OK: ${title}`);

  runPrePrReadiness(print, options.checkJobs, options.base);

  if (options.bodyFile) {
    runKnowledgeReadinessGate(options);
    print('[pr:preflight] Knowledge readiness check passed (KL-03).');
  } else {
    print(
      '[pr:preflight] Knowledge readiness (KL-03) not checked: pass --body-file <filled PR template> to include it.'
    );
  }
  print(
    `[pr:preflight] Ready to push. Remaining manual rows: ${PRE_PR_READINESS_CHECKLIST} (exception table).`
  );
}

const script = defineScript({
  name: 'pr:preflight',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'pr_preflight.ts') ||
  isDirectScript(import.meta.url, 'pr_preflight.js')
) {
  void script();
}
