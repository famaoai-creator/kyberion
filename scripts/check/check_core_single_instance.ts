#!/usr/bin/env node
/**
 * One @agent/core per process. Production code outside libs/core reaches core
 * only through the package name (`@agent/core`, `@agent/core/<subpath>`), which
 * resolves to libs/core/dist under node and to libs/core source under the
 * TypeScript loader before a build (scripts/ts-loader.mjs latches one of the
 * two per process). A relative import of a libs/core module loads that module
 * from source next to its dist copy, and every module-private registry (opaque
 * store grants, seams, backend registries) then exists twice: a grant issued by
 * one copy is not honoured by the other.
 *
 * This gate fails on any static import/export, side-effect import, dynamic
 * `import()`, `require()` or `import x = require()` whose relative specifier
 * resolves into libs/core, from any production source file outside libs/core.
 * Type-only imports are erased and never load a module. Tests are out of scope:
 * vitest aliases @agent/core to source, so a test process has one instance, and
 * its white-box imports are governed by tests/package-boundary-contract.test.ts.
 * The exact package.json manifest is metadata: importing its export map does
 * not load any core implementation or duplicate a module-private registry.
 *
 * Exceptions are exact files with a reason; an entry that no longer imports
 * libs/core relatively fails the gate so the list cannot go stale.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { pathResolver } from '@agent/core/path-resolver';
import { safeLstat, safeReaddir } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

/**
 * Bootstrap-class files that must import libs/core source. Each runs before
 * libs/core/dist exists or while it is removed and rebuilt, and imports core
 * only by relative source paths, so the process holds the source instance only:
 * the loader then answers their dynamic `@agent/core` imports (the readiness
 * checks of build_repository.ts) from the same source files.
 */
export const CORE_SOURCE_IMPORT_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'scripts/build_repository.ts',
    'compiler bootstrap: builds libs/core/dist itself, so it cannot depend on it',
  ],
  ['scripts/clean.ts', 'runs before build on a fresh checkout and removes libs/core/dist'],
  ['scripts/clean_entrypoint.ts', 'standalone clean entry of the build bootstrap'],
  [
    'scripts/ts-loader-cache.mjs',
    'the TypeScript loader itself (no TypeScript or dist yet); libs/core/private-host-cache.mjs is plain .mjs and loads at the same URL as core #private-host-cache',
  ],
]);

const ROOT = pathResolver.rootDir();
const CORE_DIR = 'libs/core';
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const TEST_FILE = /\.(?:test|spec)\.[^/]+$/u;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'build',
  'active',
  'knowledge',
  'vault',
  'customer',
  'retired',
  'tests',
  'tests_ai',
  '__tests__',
  '__fixtures__',
  'fixtures',
]);
const CANDIDATE = /['"`](?:\.{1,2}\/|\/|file:)[^'"`]*core[^'"`]*['"`]/u;

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Repository-relative target of a relative or absolute specifier, or null for a bare one. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let absolute: string;
  if (specifier.startsWith('file:')) {
    try {
      absolute = fileURLToPath(specifier);
    } catch {
      return null;
    }
  } else if (specifier.startsWith('.') || specifier.startsWith('/')) {
    absolute = specifier.startsWith('/')
      ? specifier
      : path.resolve(path.dirname(path.join(ROOT, fromFile)), specifier);
  } else {
    return null;
  }
  return toPosix(path.relative(ROOT, absolute));
}

function intoCore(target: string | null): boolean {
  return target !== null && (target === CORE_DIR || target.startsWith(CORE_DIR + '/'));
}

/** Runtime module specifiers of one file (type-only imports/exports excluded). */
export function runtimeSpecifiers(relative: string, text: string): string[] {
  const found: string[] = [];
  const literal = (node: ts.Node | undefined) =>
    node && ts.isStringLiteralLike(node) ? node.text : undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const value = literal(node.moduleSpecifier);
      if (value !== undefined) found.push(value);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const value = literal(node.moduleSpecifier);
      if (value !== undefined) found.push(value);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const value = literal(node.moduleReference.expression);
      if (value !== undefined) found.push(value);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const value = literal(node.arguments[0]);
      if (value !== undefined) found.push(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** libs/core specifiers that one non-core file loads by relative path. */
export function coreRelativeImports(relative: string, text: string): string[] {
  if (relative === CORE_DIR || relative.startsWith(CORE_DIR + '/')) return [];
  if (!CANDIDATE.test(text)) return [];
  return runtimeSpecifiers(relative, text).filter((specifier) => {
    const target = resolveSpecifier(relative, specifier);
    return intoCore(target) && target !== `${CORE_DIR}/package.json`;
  });
}

function walk(relativeDir: string, files: string[]): void {
  for (const entry of safeReaddir(path.join(ROOT, relativeDir))) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
    const relative = relativeDir ? `${relativeDir}/${entry}` : entry;
    // Legacy root-level runtime metrics are redirected to each Vitest fixture.
    // They are not production source; retain any nested code directory named work.
    if (relative === 'work') continue;
    if (relative === CORE_DIR) continue;
    const stat = safeLstat(path.join(ROOT, relative));
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(relative, files);
    else if (
      stat.isFile() &&
      CODE_FILE.test(entry) &&
      !TEST_FILE.test(entry) &&
      !entry.endsWith('.d.ts')
    )
      files.push(relative);
  }
}

export function productionSourceFiles(): string[] {
  const files: string[] = [];
  walk('', files);
  return files.sort();
}

export function checkCoreSingleInstance(
  files: readonly string[] = productionSourceFiles(),
  read: (relative: string) => string = (relative) => readTextFile(path.join(ROOT, relative)),
  exceptions: ReadonlyMap<string, string> = CORE_SOURCE_IMPORT_EXCEPTIONS
): string[] {
  const violations: string[] = [];
  const offenders = new Set<string>();
  for (const relative of files) {
    const imports = coreRelativeImports(relative, read(relative));
    if (imports.length === 0) continue;
    offenders.add(relative);
    if (exceptions.has(relative)) continue;
    violations.push(
      `${relative}: import @agent/core by package name, not by relative path into libs/core (${imports.join(', ')})`
    );
  }
  for (const relative of exceptions.keys())
    if (!offenders.has(relative))
      violations.push(
        `${relative}: listed in CORE_SOURCE_IMPORT_EXCEPTIONS but imports no libs/core module by relative path; remove the entry`
      );
  return violations.sort();
}

export const runCheckCoreSingleInstance = defineScript({
  name: 'check:core-single-instance',
  run(context) {
    const violations = checkCoreSingleInstance();
    if (violations.length > 0) {
      context.print('[check:core-single-instance] FAILED');
      throw new ScriptExitError(1, violations.map((violation) => `- ${violation}`).join('\n'));
    }
    context.print('[check:core-single-instance] OK');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_core_single_instance.ts') ||
  isDirectScript(import.meta.url, 'check_core_single_instance.js')
)
  void runCheckCoreSingleInstance();
