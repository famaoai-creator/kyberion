#!/usr/bin/env node
/**
 * Check that a PR title or commit subject follows Conventional Commits.
 *
 * - In GitHub Actions, defaults to GITHUB_EVENT_PATH and reads the PR title.
 * - Locally, falls back to the current HEAD commit subject.
 * - Can be overridden with --title.
 */

import * as path from 'node:path';
import { safeExec, safeReadFile, pathResolver } from '@agent/core';

interface CheckResult {
  ok: boolean;
  source: string;
  value: string;
  reason?: string;
}

const CONVENTIONAL_RE = /^(?<type>feat|fix|docs|refactor|test|build|ci|chore|perf|revert)(\((?<scope>[^)]+)\))?(?<breaking>!)?:\s+.+$/;

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isConventionalCommitTitle(value: string): boolean {
  return CONVENTIONAL_RE.test(normalizeTitle(value));
}

function readJson(filePath: string): any {
  return JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }) || '{}'));
}

function readEventTitle(eventPath: string): string | null {
  try {
    const event = readJson(eventPath);
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
    if (fromEvent) return checkTitle(fromEvent, `event file ${path.relative(pathResolver.rootDir(), input.eventPath)}`);
  }
  return checkTitle(readCurrentCommitSubject(), 'HEAD commit subject');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let title: string | undefined;
  let eventPath: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--title') title = args[++i];
    else if (arg === '--event-path') eventPath = args[++i];
    else if (arg === '--json') json = true;
  }

  if (!eventPath && process.env.GITHUB_EVENT_PATH) {
    eventPath = process.env.GITHUB_EVENT_PATH;
  }

  const result = checkPullRequestTitle({ title, eventPath });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    console.log(`✅ ${result.source}: ${result.value}`);
  } else {
    console.error(`❌ ${result.source}: ${result.value}`);
    console.error(`   ${result.reason}`);
  }

  process.exit(result.ok ? 0 : 1);
}

const isDirect = process.argv[1] && /check_pr_title\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
