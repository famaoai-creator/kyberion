#!/usr/bin/env node
/**
 * Guards against the ERR_MODULE_NOT_FOUND class of bug where a dist entry
 * point imports a bare specifier (workspace-scoped, e.g. `@actuator/service`,
 * or third-party, e.g. `discord.js`) that resolves fine at typecheck time via
 * tsconfig `paths` / the declaring package's own local `node_modules`, but is
 * never linked into the node_modules tree the compiled dist file actually
 * resolves from at runtime — because dist/{presence,satellites,scripts} is a
 * flat, shared output tree with no per-package `node_modules` of its own.
 *
 * tsconfig `paths` only steer the compiler; they are not rewritten into the
 * emitted JavaScript. A bare specifier survives into dist verbatim, so the
 * only way to know it will actually resolve at runtime is to ask Node's own
 * ESM resolver, from the dist file's real location, the same way `node
 * dist/presence/bridge/nexus-daemon.js` would.
 *
 * Two independent sub-checks share this scan:
 *  - workspace-scoped specifiers (e.g. `@actuator/service`) are checked
 *    against every specifier that names a real workspace package.
 *  - third-party specifiers (e.g. `discord.js`) are checked only when some
 *    package.json in the repo (root or a workspace package) declares them as
 *    a real `dependencies`/`optionalDependencies` entry — i.e. some manifest
 *    promises the install will provide it. `devDependencies`-only packages
 *    (e.g. `typescript`, `prettier`, used by this repo's own generator/check
 *    scripts) are deliberately out of scope: they are dev/CI tooling, not
 *    part of the runtime-install contract this gate enforces, and a normal
 *    `pnpm install` here always installs them anyway. A bare specifier that
 *    no manifest declares at all is also skipped — this gate has no basis to
 *    judge undeclared specifiers (and regex-based extraction over compiled
 *    JS occasionally matches template-literal look-alikes inside strings or
 *    comments, e.g. `import('x')` inside a doc comment, which are never real
 *    imports and never appear in any manifest either).
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { readSafeJsonFile } from './lib/json-input.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const ROOT = pathResolver.rootDir();

const DEFAULT_PACKAGE_SCAN_ROOTS = ['libs', 'presence', 'satellites'];
// `dist/libs` is covered too: actuator code compiled by `build:actuators` lands
// there and is imported by pipeline ADF ops at runtime — a stale build from a
// different branch (e.g. one importing a since-removed @agent/core subpath)
// fails pipelines with ERR_PACKAGE_PATH_NOT_EXPORTED far from the cause.
const DEFAULT_SCAN_ROOTS = ['dist/presence', 'dist/satellites', 'dist/scripts', 'dist/libs'];

const STATIC_FROM_IMPORT_RE =
  /(?:^|\n)[^\n]*?\b(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const NODE_BUILTIN_MODULES = new Set(builtinModules);

/**
 * Bare third-party specifiers that are intentionally exempted from the
 * resolution check below: genuinely optional integrations that are
 * dynamically imported and guarded by a `try`/`catch` in source, so a
 * missing package degrades a feature instead of crashing the process.
 *
 * Keep this list tiny, and only add an entry alongside the guarding
 * `try`/`catch` it documents — a bare top-level `import` that a manifest
 * declares should always resolve and never needs an entry here. As of this
 * writing a full scan of the real dist tree found no case that needs one.
 */
const OPTIONAL_THIRD_PARTY_IMPORT_ALLOWLIST: ReadonlySet<string> = new Set([]);

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

function isNodeBuiltinSpecifier(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return NODE_BUILTIN_MODULES.has(bare);
}

function resolutionFailureReason(error: unknown): string {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException).code || error.message
    : String(error);
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

interface DependencyManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function isWorkspaceProtocolSpecifier(specifier: string): boolean {
  return specifier.trim().startsWith('workspace:');
}

function addDeclaredDependencyNames(pkg: DependencyManifest, names: Set<string>): void {
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, specifier] of Object.entries(deps)) {
      if (!isWorkspaceProtocolSpecifier(String(specifier))) names.add(name);
    }
  }
}

/**
 * Collects the name of every third-party (non-`workspace:*`) runtime
 * dependency declared across the root manifest and every workspace package
 * manifest found under the given roots. `devDependencies` are deliberately
 * excluded — see the module doc comment.
 */
export function collectDeclaredThirdPartyDependencyNames(
  packageScanRoots: string[] = DEFAULT_PACKAGE_SCAN_ROOTS
): Set<string> {
  const names = new Set<string>();

  const rootManifestPath = pathResolver.rootResolve('package.json');
  if (safeExistsSync(rootManifestPath)) {
    addDeclaredDependencyNames(
      readSafeJsonFile<DependencyManifest>(rootManifestPath, 'root package manifest'),
      names
    );
  }

  for (const root of packageScanRoots) {
    const absoluteRoot = pathResolver.rootResolve(root);
    if (!safeExistsSync(absoluteRoot)) continue;
    for (const filePath of getAllFiles(absoluteRoot)) {
      if (path.basename(filePath) !== 'package.json') continue;
      addDeclaredDependencyNames(
        readSafeJsonFile<DependencyManifest>(filePath, `workspace package manifest ${filePath}`),
        names
      );
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

/**
 * The leading package name of a bare specifier: the scope+name pair for a
 * scoped package (`@slack/bolt/foo` -> `@slack/bolt`), otherwise the first
 * path segment (`discord.js` -> `discord.js`, `lodash/get` -> `lodash`).
 */
function thirdPartyPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : (scope ?? specifier);
  }
  return specifier.split('/')[0] ?? specifier;
}

export interface DistWorkspaceImportsOptions {
  scanRoots?: string[];
  packageScanRoots?: string[];
  /** Overrides `OPTIONAL_THIRD_PARTY_IMPORT_ALLOWLIST`; test-only escape hatch. */
  thirdPartyAllowlist?: ReadonlySet<string>;
  /**
   * Scan roots where only workspace-scoped imports are checked (third-party
   * specifiers skipped). Use for trees like `dist/libs` whose files are
   * loaded both directly (ADF steps) and through their package's own
   * node_modules — where a third-party dependency declared on the actuator
   * package is legitimately resolvable only via the latter path.
   */
  workspaceOnlyScanRoots?: string[];
}

export function checkDistWorkspaceImports(options: DistWorkspaceImportsOptions = {}): string[] {
  const packageNames = collectWorkspacePackageNames(options.packageScanRoots);
  const declaredThirdPartyNames = collectDeclaredThirdPartyDependencyNames(
    options.packageScanRoots
  );
  const allowlist = options.thirdPartyAllowlist ?? OPTIONAL_THIRD_PARTY_IMPORT_ALLOWLIST;
  const scanRoots = options.scanRoots ?? DEFAULT_SCAN_ROOTS;
  const workspaceOnlyRoots = new Set(options.workspaceOnlyScanRoots ?? ['dist/libs']);
  const violations: string[] = [];

  for (const root of scanRoots) {
    const workspaceOnly = workspaceOnlyRoots.has(root);
    const absoluteRoot = pathResolver.rootResolve(root);
    if (!safeExistsSync(absoluteRoot)) continue;

    for (const filePath of getAllFiles(absoluteRoot)) {
      if (!filePath.endsWith('.js') || filePath.endsWith('.test.js')) continue;

      const source = readTextFile(filePath);
      const parentUrl = pathToFileURL(filePath).href;

      for (const specifier of extractBareImportSpecifiers(source)) {
        if (isWorkspaceScoped(specifier, packageNames)) {
          try {
            // Ask Node's own ESM resolver, from this exact dist file, the
            // same question `node <this-file>` would ask at process startup.
            import.meta.resolve(specifier, parentUrl);
          } catch (error) {
            violations.push(
              `${toRepoRelative(filePath)}: cannot resolve workspace import '${specifier}' (${resolutionFailureReason(error)})`
            );
          }
          continue;
        }

        if (workspaceOnly) continue;

        if (isNodeBuiltinSpecifier(specifier)) continue;

        const packageName = thirdPartyPackageName(specifier);
        if (!declaredThirdPartyNames.has(packageName)) continue;
        if (allowlist.has(specifier) || allowlist.has(packageName)) continue;

        try {
          import.meta.resolve(specifier, parentUrl);
        } catch (error) {
          violations.push(
            `${toRepoRelative(filePath)}: cannot resolve third-party import '${specifier}' (${resolutionFailureReason(error)})`
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
      context.print('[check:dist-workspace-imports] FAILED');
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
