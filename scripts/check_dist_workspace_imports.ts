#!/usr/bin/env node
/**
 * Guards against the ERR_MODULE_NOT_FOUND class of bug where a dist entry
 * point imports a bare workspace-package specifier (e.g. `@actuator/service`)
 * that resolves fine at typecheck time via tsconfig `paths`, but is never
 * declared as a real dependency anywhere pnpm links it into the node_modules
 * tree the compiled dist file actually resolves from at runtime.
 *
 * tsconfig `paths` only steer the compiler; they are not rewritten into the
 * emitted JavaScript. A bare specifier survives into dist verbatim, so the
 * only way to know it will actually resolve at runtime is to ask Node's own
 * ESM resolver, from the dist file's real location, the same way `node
 * dist/presence/bridge/nexus-daemon.js` would.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { readSafeJsonFile } from './lib/json-input.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const ROOT = pathResolver.rootDir();

const DEFAULT_PACKAGE_SCAN_ROOTS = ['libs', 'presence', 'satellites'];
const DEFAULT_SCAN_ROOTS = ['dist/presence', 'dist/satellites', 'dist/scripts'];

const STATIC_FROM_IMPORT_RE =
  /(?:^|\n)[^\n]*?\b(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function toRepoRelative(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:') &&
    !path.isAbsolute(specifier)
  );
}

/**
 * Collects the package name of every `package.json` found under the given
 * roots (default: the directories that hold this repo's workspace packages),
 * so callers can tell a genuine workspace-package import apart from a
 * third-party npm dependency or a stray template-literal look-alike.
 */
export function collectWorkspacePackageNames(
  packageScanRoots: string[] = DEFAULT_PACKAGE_SCAN_ROOTS
): Set<string> {
  const names = new Set<string>();
  for (const root of packageScanRoots) {
    const absoluteRoot = pathResolver.rootResolve(root);
    if (!safeExistsSync(absoluteRoot)) continue;
    for (const filePath of getAllFiles(absoluteRoot)) {
      if (path.basename(filePath) !== 'package.json') continue;
      const pkg = readSafeJsonFile<{ name?: string }>(
        filePath,
        `workspace package manifest ${filePath}`
      );
      if (pkg.name) names.add(pkg.name);
    }
  }
  return names;
}

/**
 * Extracts every bare (non-relative, non-`node:`) import specifier referenced
 * from static `import`/`export ... from`, side-effect `import '...'`, and
 * dynamic `import('...')` forms in the given compiled JavaScript source.
 */
export function extractBareImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const re of [STATIC_FROM_IMPORT_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      const specifier = match[1]!;
      if (isBareSpecifier(specifier)) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function isWorkspaceScoped(specifier: string, packageNames: Set<string>): boolean {
  for (const name of packageNames) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return true;
  }
  return false;
}

export interface DistWorkspaceImportsOptions {
  scanRoots?: string[];
  packageScanRoots?: string[];
}

export function checkDistWorkspaceImports(options: DistWorkspaceImportsOptions = {}): string[] {
  const packageNames = collectWorkspacePackageNames(options.packageScanRoots);
  const scanRoots = options.scanRoots ?? DEFAULT_SCAN_ROOTS;
  const violations: string[] = [];

  for (const root of scanRoots) {
    const absoluteRoot = pathResolver.rootResolve(root);
    if (!safeExistsSync(absoluteRoot)) continue;

    for (const filePath of getAllFiles(absoluteRoot)) {
      if (!filePath.endsWith('.js') || filePath.endsWith('.test.js')) continue;

      const source = readTextFile(filePath);
      const parentUrl = pathToFileURL(filePath).href;

      for (const specifier of extractBareImportSpecifiers(source)) {
        if (!isWorkspaceScoped(specifier, packageNames)) continue;
        try {
          // Ask Node's own ESM resolver, from this exact dist file, the same
          // question `node <this-file>` would ask at process startup.
          import.meta.resolve(specifier, parentUrl);
        } catch (error) {
          const reason =
            error instanceof Error
              ? (error as NodeJS.ErrnoException).code || error.message
              : String(error);
          violations.push(
            `${toRepoRelative(filePath)}: cannot resolve workspace import '${specifier}' (${reason})`
          );
        }
      }
    }
  }

  return violations.sort();
}

export const runCheckDistWorkspaceImports = defineScript({
  name: 'check:dist-workspace-imports',
  run(context) {
    const violations = checkDistWorkspaceImports();
    if (violations.length > 0) {
      throw new ScriptExitError(1, violations.map((violation) => `- ${violation}`).join('\n'));
    }
    context.print('[check:dist-workspace-imports] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_dist_workspace_imports.ts') ||
  isDirectScript(import.meta.url, 'check_dist_workspace_imports.js')
)
  void runCheckDistWorkspaceImports();
