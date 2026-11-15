import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { readSafeJsonFile } from '../lib/json-input.js';

const ROOT = pathResolver.rootDir();
const ALLOWED_CJS_FILES = new Set([
  'presence/displays/concierge/postcss.config.cjs',
  'presence/displays/concierge/tailwind.config.cjs',
  'scripts/hyperframes-localhost-preload.cjs',
  'scripts/refactor/standardize-yargs.js',
  'templates/skill-template-cjs/scripts/main.cjs',
]);
const ALLOWED_NON_MODULE_PACKAGES = new Set(['templates/skill-template-cjs/package.json']);
const ALLOWED_CORE_LEGACY_JS = new Set<string>([]);
const LEGACY_JS_GUARDED_PREFIXES = [
  'libs/core/',

  'libs/shared-media/',
  'libs/shared-mobile/',
  'libs/shared-network/',
  'libs/shared-nerve/',
  // shared-ui guards only its TS sources; vanilla/ ships a hand-written ES module.
  'libs/shared-ui/src/',
  'libs/shared-vision/',
  'libs/shared-video/',
  'libs/shared-interaction/',
  'libs/shared-perception/',
  'libs/shared-voice/',
  'libs/actuators/',
];
const PACKAGE_SCAN_ROOTS = ['libs', 'presence', 'satellites', 'templates', 'package.json'];
const NODE_SOURCE_SCAN_ROOTS = [
  'libs',
  'presence/bridge',
  'presence/sensors',
  'satellites',
  'scripts',
  'templates',
];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next']);
const IMPORT_EXTENSIONLESS_RE =
  /\b(?:import|export)\b[\s\S]{0,200}from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
// libs/core source imports are owned by scripts/check/check_core_single_instance.ts
// (gate core-single-instance), which resolves every runtime import form.
const FORBIDDEN_WORKSPACE_SOURCE_IMPORT_RE =
  /\b(?:import|export)\b[\s\S]{0,200}from\s+['"]([^'"]*libs\/shared-[^/]+\/src\/[^'"]+)['"]/g;
const CJS_RE =
  /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\.main\s*===\s*module\b|\b__dirname\b|\b__filename\b/;

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function walk(dirPath: string, files: string[] = []): string[] {
  for (const entry of safeReaddir(dirPath)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = path.join(dirPath, entry);
    const stat = safeLstat(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (stat.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function checkPackageJson(filePath: string, violations: string[]) {
  const relativePath = toPosix(path.relative(ROOT, filePath));
  if (ALLOWED_NON_MODULE_PACKAGES.has(relativePath)) return;

  const pkg = readSafeJsonFile<{
    type?: string;
  }>(filePath, `ESM package manifest ${filePath}`);
  if (pkg.type !== 'module') {
    violations.push(`${relativePath}: package.json must declare "type": "module"`);
  }
}

function checkSourceFile(filePath: string, violations: string[]) {
  const relativePath = toPosix(path.relative(ROOT, filePath));
  const content = readTextFile(filePath);

  const isCjsFile = filePath.endsWith('.cjs');
  if (isCjsFile && !ALLOWED_CJS_FILES.has(relativePath)) {
    violations.push(`${relativePath}: unexpected .cjs file outside approved allowlist`);
  }

  const isNodeSource =
    filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.mjs');
  const usesCjsPattern = CJS_RE.test(content);
  if (usesCjsPattern && !ALLOWED_CJS_FILES.has(relativePath) && !isCjsFile && isNodeSource) {
    violations.push(`${relativePath}: CommonJS-only pattern detected`);
  }

  const isTypedSource =
    filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.d.ts');
  if (!isTypedSource) return;

  for (const match of content.matchAll(IMPORT_EXTENSIONLESS_RE)) {
    const specifier = match[1];
    if (
      specifier.endsWith('.js') ||
      specifier.endsWith('.mjs') ||
      specifier.endsWith('.cjs') ||
      specifier.endsWith('.json')
    ) {
      continue;
    }
    violations.push(
      `${relativePath}: relative import/export must include extension (${specifier})`
    );
  }

  for (const match of content.matchAll(FORBIDDEN_WORKSPACE_SOURCE_IMPORT_RE)) {
    const specifier = match[1];
    violations.push(
      `${relativePath}: import exported workspace packages via package name, not source path (${specifier})`
    );
  }
}

function checkLegacyJsShadow(filePath: string, violations: string[]) {
  const relativePath = toPosix(path.relative(ROOT, filePath));
  if (ALLOWED_CORE_LEGACY_JS.has(relativePath)) {
    return;
  }

  if (!filePath.endsWith('.js')) {
    return;
  }

  const guardedPrefix = LEGACY_JS_GUARDED_PREFIXES.find((prefix) =>
    relativePath.startsWith(prefix)
  );
  if (!guardedPrefix) {
    return;
  }

  const tsSibling = filePath.slice(0, -3) + '.ts';
  const dtsSibling = filePath.slice(0, -3) + '.d.ts';
  if (!safeExistsSync(tsSibling) && !safeExistsSync(dtsSibling)) {
    violations.push(
      `${relativePath}: legacy JavaScript shadow in source tree must be migrated or explicitly allowlisted`
    );
  }
}

export function checkEsmIntegrity(): string[] {
  const files: string[] = [];
  for (const entry of NODE_SOURCE_SCAN_ROOTS) {
    const fullPath = path.join(ROOT, entry);
    if (!safeExistsSync(fullPath)) continue;
    const stat = safeLstat(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (stat.isFile()) {
      files.push(fullPath);
    }
  }
  const violations: string[] = [];

  for (const entry of PACKAGE_SCAN_ROOTS) {
    const fullPath = path.join(ROOT, entry);
    if (!safeExistsSync(fullPath)) continue;
    const stat = safeLstat(fullPath);
    if (stat.isFile() && path.basename(fullPath) === 'package.json') {
      checkPackageJson(fullPath, violations);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const filePath of walk(fullPath)) {
      if (path.basename(filePath) === 'package.json') {
        checkPackageJson(filePath, violations);
      }
    }
  }

  for (const filePath of files) {
    const basename = path.basename(filePath);
    if (!/\.(?:[cm]?js|[cm]?ts|d\.ts)$/.test(filePath) || basename === 'package.json') {
      continue;
    }

    checkLegacyJsShadow(filePath, violations);
    checkSourceFile(filePath, violations);
  }

  return violations.sort();
}

export const runCheckEsmIntegrity = defineScript({
  name: 'check:esm',
  flags: [],
  run(context) {
    const violations = checkEsmIntegrity();
    if (violations.length > 0) {
      context.print('[check:esm] violations detected:');
      for (const violation of violations) context.print(`- ${violation}`);
      throw new ScriptExitError(1);
    }
    context.print('[check:esm] OK');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_esm_integrity.ts') ||
  isDirectScript(import.meta.url, 'check_esm_integrity.js')
)
  void runCheckEsmIntegrity();
