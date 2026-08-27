#!/usr/bin/env node
/**
 * Check that the current HEAD commit subject follows Conventional Commits.
 *
 * This is the CI-side counterpart to `check_pr_title.ts` and is used on push
 * to `main` so merge commit subjects remain conventional too.
 */

import { safeExec, pathResolver } from '@agent/core';
import { checkTitle } from './check_pr_title.js';
import { defineScript, isDirectScript } from './lib/harness.js';

const MERGE_PULL_REQUEST_SUBJECT_RE = /^Merge pull request #\d+ from [^\s]+\/[^\s]+$/;

function readHeadSubject(): string {
  return safeExec('git', ['log', '-1', '--format=%s'], { cwd: pathResolver.rootDir() }).trim();
}

function isMergePullRequestSubject(subject: string): boolean {
  return MERGE_PULL_REQUEST_SUBJECT_RE.test(subject.trim());
}

export function checkCommitSubject(subject: string): ReturnType<typeof checkTitle> {
  if (isMergePullRequestSubject(subject)) {
    return { ok: true, source: 'HEAD commit subject', value: subject.trim() };
  }
  return checkTitle(subject, 'HEAD commit subject');
}

export const runCheckCommitSubject = defineScript({
  name: 'check:commit-subject',
  run(context) {
    const result = checkCommitSubject(readHeadSubject());
    if (!result.ok) throw new Error(`${result.source}: ${result.value} (${result.reason})`);
    context.print(context.json ? result : `✅ ${result.source}: ${result.value}`);
  },
});

if (
  isDirectScript(import.meta.url, 'check_commit_subject.ts') ||
  isDirectScript(import.meta.url, 'check_commit_subject.js')
)
  void runCheckCommitSubject();
