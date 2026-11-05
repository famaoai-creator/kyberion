import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * R5 delegation execution-start contract gate.
 *
 * A keyed `delegateTask` failure whose start state is unknown counts as
 * started: no retry, no failover, a terminal replay. Every ReasoningBackend
 * implementation must therefore wrap its `delegateTask` body in
 * `runStartReportingDelegation` (libs/core/delegation-execution-tracker.ts)
 * and mark the start at each dispatch point — or be a documented exception
 * in `tests/fixtures/delegation-start-reporting-allowlist.json` (decorators
 * that forward to a reporting backend, side-effect-free doubles).
 *
 * Scanned: non-test sources under libs/, scripts/, presence/, satellites/ and
 * plugins/ that declare `class X ... implements ReasoningBackend` or
 * `const x: ReasoningBackend = {`.
 */
const rootDir = process.cwd();
const SCAN_ROOTS = ['libs', 'scripts', 'presence', 'satellites', 'plugins'];
const allowlistPath = path.join(
  rootDir,
  'tests',
  'fixtures',
  'delegation-start-reporting-allowlist.json'
);

interface AllowlistEntry {
  file: string;
  backend: string;
  reason: string;
}

interface BackendDeclaration {
  file: string;
  backend: string;
  /** The delegateTask member's source, or undefined when it has none. */
  delegateTask?: string;
  /** An object literal that spreads another backend (and may inherit delegateTask). */
  spreads: boolean;
}

function read(filePath: string): string {
  return safeReadFile(filePath, { encoding: 'utf8' }) as string;
}

/** Index just past the bracket group opened at `open` (strings/comments skipped). */
function matchGroup(source: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return source.length;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i += 1; i < source.length && source[i] !== ch; i += 1) {
        if (source[i] === '\\') i += 1;
      }
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return source.length;
}

/** The `delegateTask` member (method or property) defined directly in `body`. */
function delegateTaskMember(body: string): string | undefined {
  const member = /(?:^|[\s;,{])(?:async\s+)?delegateTask\s*(\(|:)/gu;
  for (const match of body.matchAll(member)) {
    const start = match.index! + match[0].indexOf('delegateTask');
    if (body[start - 1] === '.') continue;
    const marker = start + match[0].slice(match[0].indexOf('delegateTask')).length - 1;
    if (match[1] === '(') {
      const paramsEnd = matchGroup(body, marker);
      const bodyOpen = body.indexOf('{', paramsEnd);
      return body.slice(start, matchGroup(body, bodyOpen));
    }
    // Property form: the expression up to the next top-level comma/brace.
    let end = marker + 1;
    while (end < body.length && body[end] !== ',' && body[end] !== '}') {
      end = '({['.includes(body[end]!) ? matchGroup(body, end) : end + 1;
    }
    return body.slice(start, end);
  }
  return undefined;
}

function scanBackends(): BackendDeclaration[] {
  const declarations: BackendDeclaration[] = [];
  const files = SCAN_ROOTS.flatMap((root) => getAllFiles(path.join(rootDir, root)))
    .map((filePath) => path.relative(rootDir, filePath).split(path.sep).join('/'))
    .filter((relPath) => /\.(ts|tsx|mts)$/u.test(relPath))
    .filter((relPath) => !/\.(test|spec)\.tsx?$/u.test(relPath) && !relPath.endsWith('.d.ts'))
    .filter((relPath) => !/(^|\/)(node_modules|dist|\.next)\//u.test(relPath));
  // Declarations start a line (so prose such as "this class only maps…" in a
  // doc comment never matches).
  const declaration =
    /^[ \t]*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)[^{]*?\bimplements\b[^{]*?\bReasoningBackend\b[^{]*\{|^[ \t]*(?:export\s+)?(?:const|let)\s+(\w+)\s*:\s*ReasoningBackend\s*=\s*\{/gmu;
  for (const file of files) {
    const source = read(path.join(rootDir, file));
    if (!source.includes('ReasoningBackend')) continue;
    for (const match of source.matchAll(declaration)) {
      const open = match.index! + match[0].length - 1;
      const body = source.slice(open, matchGroup(source, open));
      declarations.push({
        file,
        backend: (match[1] ?? match[2])!,
        delegateTask: delegateTaskMember(body.slice(1)),
        spreads: match[2] !== undefined && /\.\.\.\s*\w/u.test(body),
      });
    }
  }
  return declarations.sort((a, b) =>
    `${a.file}#${a.backend}`.localeCompare(`${b.file}#${b.backend}`)
  );
}

const reports = (declaration: BackendDeclaration): boolean =>
  Boolean(
    declaration.delegateTask && /\brunStartReportingDelegation\s*\(/u.test(declaration.delegateTask)
  );

describe('R5 delegation execution-start reporting contract', () => {
  const allowlist = JSON.parse(read(allowlistPath)) as { exceptions: AllowlistEntry[] };
  const key = (entry: { file: string; backend: string }) => `${entry.file}#${entry.backend}`;
  const backends = scanBackends();

  it('finds the registered reasoning backends (scanner sanity)', () => {
    const names = backends.map((entry) => entry.backend);
    for (const expected of [
      'AnthropicReasoningBackend',
      'ClaudeAgentReasoningBackend',
      'CopilotAcpReasoningBackend',
      'AgyCliBackend',
      'CodexCliReasoningBackend',
      'OpenAiCompatibleBackend',
      'FailoverReasoningBackend',
      'stubReasoningBackend',
    ]) {
      expect(names, `scanner no longer sees ${expected}`).toContain(expected);
    }
    for (const entry of backends) {
      // An object literal may inherit delegateTask through a spread (`...stub`).
      expect(
        entry.delegateTask !== undefined || entry.spreads,
        `${key(entry)} has no delegateTask member`
      ).toBe(true);
    }
  });

  it('requires every backend delegateTask to report its start or be a documented exception', () => {
    const allowed = new Set(allowlist.exceptions.map(key));
    const unreported = backends.filter((entry) => !reports(entry) && !allowed.has(key(entry)));
    expect(
      unreported.map(key),
      [
        'delegate-start-reporting — these ReasoningBackend.delegateTask bodies are not wrapped in runStartReportingDelegation,',
        'so a keyed delegation that fails before dispatch is treated as started (no retry, no failover, terminal replay)',
        '| next: wrap the body in runStartReportingDelegation and call markDelegationExecutionStarted() at every dispatch point',
        '(spawnWithDelegationEnv marks a spawned child itself); only a forwarding decorator or a side-effect-free double may',
        'instead be listed with a reason in tests/fixtures/delegation-start-reporting-allowlist.json',
      ].join(' ')
    ).toEqual([]);
  });

  it('keeps the exception list honest: every entry has a reason, exists and still needs the exception', () => {
    const byKey = new Map(backends.map((entry) => [key(entry), entry]));
    const stale = allowlist.exceptions.filter((entry) => {
      const backend = byKey.get(key(entry));
      return !entry.reason?.trim() || !backend || reports(backend);
    });
    expect(
      stale.map(key),
      'delegate-start-reporting allowlist — entries without a reason, for a backend that no longer exists, or for a backend that now reports its start | next: remove or fix the entry in tests/fixtures/delegation-start-reporting-allowlist.json'
    ).toEqual([]);
  });
});
