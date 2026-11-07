/**
 * vcs-host seam boundary (VCS host API seam design, stage 5).
 *
 * Forge access goes through the async `vcs-host` verbs
 * (`@agent/core/vcs/vcs-host-verbs`), which govern, bind and sanitize every
 * call and work with or without the `gh` binary. This AST check keeps new code
 * from bypassing the seam:
 *
 * - `gh-exec`: a call whose first argument is the literal `'gh'` (an exec of
 *   the GitHub CLI) outside the files listed in GH_EXEC_ALLOWLIST.
 * - `sync-gh-verb`: any reference to a deprecated sync gh verb from
 *   `libs/core/vcs/github.ts` in production code outside that module.
 *
 * Tests are not scanned: the sync verbs stay as the contract-parity oracle
 * for the async verbs. An allowlist entry that no longer matches anything is
 * reported as stale so the list only shrinks.
 */
import * as path from 'node:path';
import * as ts from 'typescript';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReaddir, safeStat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const SCAN_ROOTS = ['libs', 'scripts', 'satellites', 'presence', 'plugins'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx'];

/** The module that defines the deprecated sync verbs. */
export const SYNC_GH_MODULE = 'libs/core/vcs/github.ts';

/** Deprecated sync verbs; each has an async vcs-host replacement. */
export const DEPRECATED_SYNC_GH_VERBS: Readonly<Record<string, string>> = {
  ghRun: 'vcsHostGithubApiGet or a typed vcs-host verb',
  ghMust: 'a typed vcs-host verb',
  ghPrQueued: 'vcsHostPrQueued',
  ghRepoDefaultBranch: 'vcsHostDefaultBranch',
  ghPrView: 'vcsHostPrViewFields',
  ghPrList: 'vcsHostPrList',
  ghPrChecks: 'vcsHostPrChecks',
  ghPrChecksWait: 'vcsHostPrChecksWait',
  ghPrMerge: 'vcsHostPrMerge',
  ghPrCreate: 'vcsHostPrCreate',
  ghRepositoryVisibility: 'vcsHostRepositoryVisibility',
};

/** Files allowed to exec `gh` directly, with the reason. Keep this list short. */
export const GH_EXEC_ALLOWLIST: Readonly<Record<string, string>> = {
  [SYNC_GH_MODULE]: 'legacy sync verbs and the gh CLI diagnostics (ghVersion/ghAuthStatus)',
  'libs/core/vcs/gh-cli-host-provider.ts': 'the gh-cli vcs-host provider itself',
  'libs/core/provider/provider-discovery.ts': '`gh copilot` reasoning-backend discovery',
  'libs/core/actuator/actuator-capability.ts': '`gh` binary presence probe (no exec)',
};

export interface VcsHostBoundaryFinding {
  rule: 'gh-exec' | 'sync-gh-verb' | 'stale-allowlist';
  file: string;
  line: number;
  message: string;
}

/** Value methods whose first argument may be the text 'gh' without executing anything. */
const NON_EXEC_METHODS = new Set([
  'startsWith',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'split',
  'replace',
  'replaceAll',
  'localeCompare',
  'concat',
  'push',
  'unshift',
  'has',
  'get',
  'set',
  'add',
  'delete',
]);

/** A call shaped like an exec of the GitHub CLI: `<runner>('gh', …)`. */
function isGhExecCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !isGhLiteral(node.arguments[0])) return false;
  const callee = node.expression;
  return !(ts.isPropertyAccessExpression(callee) && NON_EXEC_METHODS.has(callee.name.text));
}

/** Identifier positions that name a member rather than reference a binding. */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  );
}

function isGhLiteral(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    node.text === 'gh'
  );
}

/** Scan one source file. `file` is repository-relative with forward slashes. */
export function scanVcsHostBoundary(file: string, source: string): VcsHostBoundaryFinding[] {
  const findings: VcsHostBoundaryFinding[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const execAllowed = file in GH_EXEC_ALLOWLIST;
  const verbsAllowed = file === SYNC_GH_MODULE;

  const visit = (node: ts.Node): void => {
    if (!execAllowed && isGhExecCall(node)) {
      findings.push({
        rule: 'gh-exec',
        file,
        line: lineOf(node),
        message:
          'executes the gh CLI directly; use a vcs-host verb (@agent/core/vcs/vcs-host-verbs)',
      });
    }
    if (
      !verbsAllowed &&
      ts.isIdentifier(node) &&
      !isMemberName(node) &&
      Object.prototype.hasOwnProperty.call(DEPRECATED_SYNC_GH_VERBS, node.text)
    ) {
      findings.push({
        rule: 'sync-gh-verb',
        file,
        line: lineOf(node),
        message: `references the deprecated sync verb ${node.text}; use ${DEPRECATED_SYNC_GH_VERBS[node.text]}`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function isProductionSource(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.[cm]?tsx?$/u.test(name)) return false;
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of safeReaddir(directory).sort()) {
    if (entry.startsWith('.') || SKIP_DIRECTORIES.has(entry)) continue;
    const absolute = path.join(directory, entry);
    const stat = safeStat(absolute);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'fixtures') continue;
      files.push(...collectSourceFiles(absolute));
    } else if (stat.isFile() && isProductionSource(entry)) {
      files.push(absolute);
    }
  }
  return files;
}

export function checkVcsHostBoundary(
  files: ReadonlyArray<{ file: string; source: string }>
): VcsHostBoundaryFinding[] {
  const findings: VcsHostBoundaryFinding[] = [];
  const execUsers = new Set<string>();
  for (const { file, source } of files) {
    if (file in GH_EXEC_ALLOWLIST) {
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (isGhExecCall(node)) execUsers.add(file);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    findings.push(...scanVcsHostBoundary(file, source));
  }
  const scanned = new Set(files.map((entry) => entry.file));
  for (const file of Object.keys(GH_EXEC_ALLOWLIST)) {
    if (scanned.has(file) && !execUsers.has(file)) {
      findings.push({
        rule: 'stale-allowlist',
        file,
        line: 1,
        message: 'no longer executes gh; remove it from GH_EXEC_ALLOWLIST',
      });
    } else if (!scanned.has(file)) {
      findings.push({
        rule: 'stale-allowlist',
        file,
        line: 1,
        message: 'allowlisted file does not exist; remove it from GH_EXEC_ALLOWLIST',
      });
    }
  }
  return findings;
}

function loadProductionSources(): Array<{ file: string; source: string }> {
  const root = pathResolver.rootDir();
  return SCAN_ROOTS.map((entry) => pathResolver.rootResolve(entry))
    .filter((directory) => {
      try {
        return safeStat(directory).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((directory) => collectSourceFiles(directory))
    .map((absolute) => ({
      file: path.relative(root, absolute).split(path.sep).join('/'),
      source: readTextFile(absolute),
    }));
}

export const runCheckVcsHostBoundary = defineScript({
  name: 'check:vcs-host-boundary',
  flags: [],
  run(context): void {
    const sources = loadProductionSources();
    const findings = checkVcsHostBoundary(sources);
    if (findings.length > 0) {
      throw new ScriptExitError(
        1,
        findings
          .map(
            (finding) => `- ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`
          )
          .join('\n')
      );
    }
    context.print(`[check:vcs-host-boundary] OK (${sources.length} production files)`);
  },
});

if (
  isDirectScript(import.meta.url, 'check_vcs_host_boundary.ts') ||
  isDirectScript(import.meta.url, 'check_vcs_host_boundary.js')
)
  void runCheckVcsHostBoundary();
