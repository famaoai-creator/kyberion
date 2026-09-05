#!/usr/bin/env node
/**
 * Check that a PR title or commit subject follows Conventional Commits.
 *
 * - In GitHub Actions, defaults to GITHUB_EVENT_PATH and reads the PR title.
 * - Locally, falls back to the current HEAD commit subject.
 * - Can be overridden with --title.
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExec } from '@agent/core/secure-io';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

interface CheckResult {
  ok: boolean;
  source: string;
  value: string;
  reason?: string;
}

interface GitHubEventPayload {
  pull_request?: {
    title?: unknown;
    head?: { commit?: { message?: unknown } };
  };
}

const CONVENTIONAL_RE =
  /^(?<type>feat|fix|docs|refactor|test|build|ci|chore|perf|revert)(\((?<scope>[^)]+)\))?(?<breaking>!)?:\s+.+$/;

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isConventionalCommitTitle(value: string): boolean {
  return CONVENTIONAL_RE.test(normalizeTitle(value));
}

function readEventTitle(eventPath: string): string | null {
  try {
    const event = readSafeJsonFile<GitHubEventPayload>(eventPath, 'GitHub event payload');
    if (typeof event?.pull_request?.title === 'string') return event.pull_request.title;
    if (typeof event?.pull_request?.head?.commit?.message === 'string') {
      return event.pull_request.head.commit.message.split('\n', 1)[0];
    }
  } catch (_) {
    // Ignore malformed event payloads and fall back to git.
  }
  return null;
}

function readCurrentCommitSubject(): string {
  return safeExec('git', ['log', '-1', '--format=%s'], { cwd: pathResolver.rootDir() }).trim();
}

export function checkTitle(title: string, source = 'provided title'): CheckResult {
  const normalized = normalizeTitle(title);
  if (!normalized) {
    return { ok: false, source, value: normalized, reason: 'title is empty' };
  }
  if (!isConventionalCommitTitle(normalized)) {
    return {
      ok: false,
      source,
      value: normalized,
      reason: 'title must start with a Conventional Commit header, e.g. feat(scope): subject',
    };
  }
  return { ok: true, source, value: normalized };
}

export function checkPullRequestTitle(input: { title?: string; eventPath?: string }): CheckResult {
  if (typeof input.title === 'string' && input.title.trim()) {
    return checkTitle(input.title, '--title');
  }
  if (input.eventPath && input.eventPath.trim()) {
    const fromEvent = readEventTitle(input.eventPath);
    if (fromEvent)
      return checkTitle(
        fromEvent,
        `event file ${path.relative(pathResolver.rootDir(), input.eventPath)}`
      );
  }
  return checkTitle(readCurrentCommitSubject(), 'HEAD commit subject');
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export const runCheckPullRequestTitle = defineScript({
  name: 'check:pr-title',
  run(context) {
    if (
      context.positional.includes('--help') ||
      context.positional.includes('-h') ||
      context.positional.includes('help')
    ) {
      context.print('Usage: pnpm check:pr-title [--title <title>] [--event-path <path>] [--json]');
      return;
    }
    const result = checkPullRequestTitle({
      title: optionValue(context.argv, '--title'),
      eventPath:
        optionValue(context.argv, '--event-path') || getRegisteredEnvText('GITHUB_EVENT_PATH'),
    });
    if (!result.ok) {
      throw new ScriptExitError(1, `${result.source}: ${result.value} (${result.reason})`);
    }
    context.print(context.json ? result : `✅ ${result.source}: ${result.value}`);
  },
});

if (
  isDirectScript(import.meta.url, 'check_pr_title.ts') ||
  isDirectScript(import.meta.url, 'check_pr_title.js')
)
  void runCheckPullRequestTitle();
