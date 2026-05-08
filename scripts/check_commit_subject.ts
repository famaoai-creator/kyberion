#!/usr/bin/env node
/**
 * Check that the current HEAD commit subject follows Conventional Commits.
 *
 * This is the CI-side counterpart to `check_pr_title.ts` and is used on push
 * to `main` so merge commit subjects remain conventional too.
 */

import { safeExec, pathResolver } from '@agent/core';
import { checkTitle } from './check_pr_title.js';

function readHeadSubject(): string {
  return safeExec('git', ['log', '-1', '--format=%s'], { cwd: pathResolver.rootDir() }).trim();
}

export function checkCommitSubject(subject: string): ReturnType<typeof checkTitle> {
  return checkTitle(subject, 'HEAD commit subject');
}

async function main(): Promise<void> {
  const result = checkCommitSubject(readHeadSubject());
  if (result.ok) {
    console.log(`✅ ${result.source}: ${result.value}`);
  } else {
    console.error(`❌ ${result.source}: ${result.value}`);
    console.error(`   ${result.reason}`);
  }
  process.exit(result.ok ? 0 : 1);
}

const isDirect = process.argv[1] && /check_commit_subject\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
