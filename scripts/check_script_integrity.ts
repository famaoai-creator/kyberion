#!/usr/bin/env node
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeLstat, safeStat } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { readSafeJsonFile, readSafeJsonValueFile } from './lib/json-input.js';

const ROOT = pathResolver.rootDir();

export function readScriptIntegrityTextFile(filePath: string, label = filePath): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return readTextFile(filePath);
}

export interface ScriptIntegrityOptions {
  packageJsonPath?: string;
  pipelineRoots?: string[];
  pathExists?: (repoRelativePath: string) => boolean;
}

const SCRIPT_HARNESS_BOOTSTRAP_ALLOWLIST = new Set(['scripts/clean_entrypoint.ts']);

const DEFAULT_PIPELINE_ROOTS = [
  'pipelines',
  'pipelines/fragments',
  'knowledge/product/pipeline-templates',
];

function toRepoRelative(targetPath: string): string {
  return path.relative(ROOT, path.resolve(targetPath)).split(path.sep).join('/');
}

function existingRepoPath(
  repoRelativePath: string,
  pathExists: (repoRelativePath: string) => boolean
): boolean {
  return pathExists(repoRelativePath);
}

function sourceForDistScript(repoRelativePath: string): string | null {
  const match = repoRelativePath.match(/^dist\/scripts\/(.+)\.js$/);
  if (!match) return null;
  return `scripts/${match[1]}.ts`;
}

function distForSourceScript(repoRelativePath: string): string | null {
  const match = repoRelativePath.match(/^scripts\/(.+)\.ts$/);
  if (!match) return null;
  return `dist/scripts/${match[1]}.js`;
}

function validateRepoPath(
  reference: string,
  owner: string,
  violations: string[],
  pathExists: (repoRelativePath: string) => boolean
): void {
  const normalized = reference.replace(/^\.\//, '');
  const sourcePath = sourceForDistScript(normalized);
  if (sourcePath) {
    if (!existingRepoPath(sourcePath, pathExists)) {
      violations.push(`${owner}: ${normalized} has no source ${sourcePath}`);
    }
    return;
  }
  if (!existingRepoPath(normalized, pathExists)) {
    violations.push(`${owner}: referenced path not found (${normalized})`);
  }
}

function validateScriptBuildTarget(
  reference: string,
  owner: string,
  violations: string[],
  pathExists: (repoRelativePath: string) => boolean
): void {
  const normalized = reference.replace(/^\.\//, '');
  const distPath = distForSourceScript(normalized);
  if (!distPath) return;
  if (!existingRepoPath(normalized, pathExists)) return;
  if (!existingRepoPath(distPath, pathExists)) {
    violations.push(`${owner}: ${normalized} has no build output ${distPath}`);
  }
}

function collectCommandReferences(value: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /\bdist\/scripts\/[A-Za-z0-9_./-]+\.js\b/g,
    /\bscripts\/[A-Za-z0-9_./-]+\.(?:ts|mjs)\b/g,
    /\bpipelines\/[A-Za-z0-9_./-]+\.json\b/g,
    /\bknowledge\/product\/pipeline-templates\/[A-Za-z0-9_./-]+\.json\b/g,
    /\blibs\/[A-Za-z0-9_./-]+\.mjs\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      refs.add(match[0]);
    }
  }
  return [...refs];
}

function collectPackageScriptReferences(value: string, scripts: Set<string>): string[] {
  const refs = new Set<string>();
  const runPattern = /\bpnpm\s+run\s+([A-Za-z0-9][A-Za-z0-9:_-]*)\b/g;
  for (const match of value.matchAll(runPattern)) refs.add(match[1]);
  const barePattern = /\bpnpm\s+([A-Za-z0-9][A-Za-z0-9:_-]*)\b/g;
  for (const match of value.matchAll(barePattern)) {
    // A colon is the package-script namespace. Bare words such as `pnpm
    // doctor` are also supported by pnpm, but are commonly embedded in prose
    // and are validated by the explicit `pnpm run` form above. Do not consult
    // the current script set here: deleted script references must remain
    // observable to this checker.
    if (match[1].includes(':')) refs.add(match[1]);
  }
  return [...refs];
}

function collectStructuredPackageScriptReferences(command: unknown, args: unknown): string[] {
  if (command !== 'pnpm' || !Array.isArray(args)) return [];
  const tokens = args.filter((value): value is string => typeof value === 'string');
  const runIndex = tokens.indexOf('run');
  const script = runIndex >= 0 ? tokens[runIndex + 1] : undefined;
  return script ? [script] : [];
}

/**
 * Package scripts that execute authored TypeScript must expose the shared
 * script harness. The build bootstrap is the only exception: it runs before
 * package dist exists and therefore cannot import the normal harness.
 */
export function findScriptHarnessViolations(
  packageScripts: Record<string, string>,
  sourceForScript: (repoRelativePath: string) => string | undefined
): string[] {
  const violations: string[] = [];
  for (const [scriptName, command] of Object.entries(packageScripts)) {
    const owner = `package.json scripts.${scriptName}`;
    for (const reference of collectCommandReferences(command)) {
      if (!reference.startsWith('scripts/') || !reference.endsWith('.ts')) continue;
      if (SCRIPT_HARNESS_BOOTSTRAP_ALLOWLIST.has(reference)) continue;
      const source = sourceForScript(reference);
      if (source === undefined) continue;
      if (!/\bdefine(?:Script|Generator)\s*\(/u.test(source)) {
        violations.push(`${owner}: ${reference} must execute through scripts/lib/harness.ts`);
      }
    }
  }
  return violations;
}

const PNPM_BUILT_INS = new Set([
  'add',
  'config',
  'create',
  'dlx',
  'exec',
  'help',
  'import',
  'init',
  'install',
  'link',
  'list',
  'outdated',
  'publish',
  'remove',
  'root',
  'store',
  'uninstall',
  'update',
  'why',
  'run',
]);

function validatePackageScriptReferences(
  value: string,
  owner: string,
  scripts: Set<string>,
  violations: string[]
): void {
  for (const script of collectPackageScriptReferences(value, scripts)) {
    if (PNPM_BUILT_INS.has(script) || scripts.has(script)) continue;
    violations.push(`${owner}: pnpm script not found (${script})`);
  }
}

/**
 * Compiled scripts must retain an explicit direct-entry guard.  The shared
 * helper accepts a `.ts` expectation for a compiled `.js` module, but keeping
 * both spellings at each entrypoint makes the source/dist contract reviewable
 * and prevents a generator from silently becoming an import-only no-op.
 */
export function findDirectScriptGuardViolations(relative: string, source: string): string[] {
  const violations: string[] = [];
  const expectedTs = /isDirectScript\(import\.meta\.url,\s*'([^']+\.ts)'\)/gu;
  for (const match of source.matchAll(expectedTs)) {
    const expected = match[1];
    const expectedJs = expected.replace(/\.ts$/u, '.js');
    if (!source.includes(`isDirectScript(import.meta.url, '${expectedJs}')`)) {
      violations.push(`${relative}: direct-script guard is missing compiled entry ${expectedJs}`);
    }
  }
  return violations;
}

const COMMAND_REFERENCE_KEYS = new Set([
  'cmd',
  'command',
  'args',
  'pipeline',
  'pipeline_ref',
  'pipeline_path',
  'suggested_pipeline_path',
  'fallback_pipeline',
]);

function scanValue(
  owner: string,
  value: unknown,
  violations: string[],
  pathExists: (repoRelativePath: string) => boolean,
  packageScripts: Set<string>,
  keyHint = ''
): void {
  if (typeof value === 'string') {
    validatePackageScriptReferences(value, owner, packageScripts, violations);
    if (COMMAND_REFERENCE_KEYS.has(keyHint)) {
      for (const reference of collectCommandReferences(value)) {
        validateRepoPath(reference, owner, violations, pathExists);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      scanValue(owner, item, violations, pathExists, packageScripts, keyHint);
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const script of collectStructuredPackageScriptReferences(record.command, record.args)) {
      if (!PNPM_BUILT_INS.has(script) && !packageScripts.has(script)) {
        violations.push(`${owner}: pnpm script not found (${script})`);
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      scanValue(owner, nested, violations, pathExists, packageScripts, key);
    }
  }
}

function listPipelineFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const absRoot = pathResolver.rootResolve(root);
    if (!safeExistsSync(absRoot)) continue;
    for (const file of getAllFiles(absRoot)) {
      if (file.endsWith('.json')) files.push(file);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function listPipelineDocumentationFiles(): string[] {
  return ['pipelines', 'knowledge']
    .map((root) => pathResolver.rootResolve(root))
    .filter((root) => safeExistsSync(root))
    .flatMap((root) => getAllFiles(root).filter((file) => file.endsWith('.md')))
    .sort((a, b) => a.localeCompare(b));
}

function checkProductionScriptBoundaries(): string[] {
  const violations: string[] = [];
  const processArgvLabel = ['process', 'argv'].join('.');
  const processExitLabel = ['process', 'exit'].join('.');
  const argvPattern = new RegExp(`\\b${['process', 'argv'].join('\\.')}\\b`);
  const exitPattern = /\bprocess\.exit\s*\(/u;
  const scriptRoot = pathResolver.rootResolve('scripts');
  if (!safeExistsSync(scriptRoot)) return violations;

  for (const file of getAllFiles(scriptRoot)) {
    if (!/\.(?:ts|js)$/u.test(file)) continue;
    const relative = toRepoRelative(file);
    if (
      relative.endsWith('.test.ts') ||
      relative.startsWith('scripts/refactor/') ||
      relative === 'scripts/lib/harness.ts'
    ) {
      continue;
    }
    const source = readScriptIntegrityTextFile(file, relative);
    if (argvPattern.test(source)) {
      violations.push(
        `${relative}: direct ${processArgvLabel} access; use the script harness boundary`
      );
    }
    if (exitPattern.test(source)) {
      violations.push(
        `${relative}: direct ${processExitLabel}() call; use the script error boundary`
      );
    }
    violations.push(...findDirectScriptGuardViolations(relative, source));
  }
  return violations;
}

export function checkScriptIntegrity(options: ScriptIntegrityOptions = {}): string[] {
  const violations: string[] = checkProductionScriptBoundaries();
  const pathExists =
    options.pathExists ||
    ((repoRelativePath: string) => safeExistsSync(pathResolver.rootResolve(repoRelativePath)));
  const packageJsonPath = options.packageJsonPath || pathResolver.rootResolve('package.json');
  const scanRepositoryDocs = options.packageJsonPath === undefined;
  const packageJson = readSafeJsonFile<{
    scripts?: Record<string, string>;
  }>(packageJsonPath, 'script integrity package manifest');
  const packageScripts = new Set(Object.keys(packageJson.scripts || {}));

  if (options.packageJsonPath === undefined) {
    violations.push(
      ...findScriptHarnessViolations(packageJson.scripts || {}, (repoRelativePath) => {
        const sourcePath = pathResolver.rootResolve(repoRelativePath);
        if (!safeExistsSync(sourcePath)) return undefined;
        return readScriptIntegrityTextFile(sourcePath, repoRelativePath);
      })
    );
  }

  for (const [scriptName, command] of Object.entries(packageJson.scripts || {})) {
    const owner = `package.json scripts.${scriptName}`;
    validatePackageScriptReferences(command, owner, packageScripts, violations);
    for (const reference of collectCommandReferences(command)) {
      validateRepoPath(reference, owner, violations, pathExists);
      validateScriptBuildTarget(reference, owner, violations, pathExists);
    }
  }

  const pipelineRoots = options.pipelineRoots || DEFAULT_PIPELINE_ROOTS;
  for (const file of listPipelineFiles(pipelineRoots)) {
    const owner = toRepoRelative(file);
    const payload = readSafeJsonValueFile<unknown>(file, `script integrity pipeline ${owner}`);
    scanValue(owner, payload, violations, pathExists, packageScripts);
  }

  for (const root of scanRepositoryDocs
    ? [
        'README.md',
        'docs',
        '.github',
        'knowledge/product/governance/ci-gates.json',
        'knowledge/product/governance/environment-manifests',
      ]
    : []) {
    const absolute = pathResolver.rootResolve(root);
    if (!safeExistsSync(absolute)) continue;
    const files = safeStat(absolute).isDirectory() ? getAllFiles(absolute) : [absolute];
    for (const file of files) {
      if (
        !/\.(?:md|yml|yaml|json)$/u.test(file) ||
        file.includes('/improvement-plans-2026-08/reviews/') ||
        file.includes('/improvement-plans-archive/')
      )
        continue;
      validatePackageScriptReferences(
        readScriptIntegrityTextFile(file, toRepoRelative(file)),
        toRepoRelative(file),
        packageScripts,
        violations
      );
    }
  }

  if (scanRepositoryDocs) {
    for (const file of listPipelineDocumentationFiles()) {
      validatePackageScriptReferences(
        readScriptIntegrityTextFile(file, toRepoRelative(file)),
        toRepoRelative(file),
        packageScripts,
        violations
      );
    }
  }

  return violations;
}

export const runCheckScriptIntegrity = defineScript({
  name: 'check:script-integrity',
  run(context) {
    const violations = checkScriptIntegrity();
    if (violations.length > 0) {
      throw new ScriptExitError(1, violations.map((violation) => `- ${violation}`).join('\n'));
    }
    context.print('[check:script-integrity] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_script_integrity.ts') ||
  isDirectScript(import.meta.url, 'check_script_integrity.js')
)
  void runCheckScriptIntegrity();
