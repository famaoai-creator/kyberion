#!/usr/bin/env node
import * as path from 'node:path';
import { loadJson, pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { defineScript, isDirectScript } from './lib/harness.js';

const ROOT = pathResolver.rootDir();

export interface ScriptIntegrityOptions {
  packageJsonPath?: string;
  pipelineRoots?: string[];
  pathExists?: (repoRelativePath: string) => boolean;
}

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
  keyHint = ''
): void {
  if (typeof value === 'string') {
    if (COMMAND_REFERENCE_KEYS.has(keyHint)) {
      for (const reference of collectCommandReferences(value)) {
        validateRepoPath(reference, owner, violations, pathExists);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanValue(owner, item, violations, pathExists, keyHint);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      scanValue(owner, nested, violations, pathExists, key);
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
    const source = String(safeReadFile(file, { encoding: 'utf8' }));
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
  }
  return violations;
}

export function checkScriptIntegrity(options: ScriptIntegrityOptions = {}): string[] {
  const violations: string[] = checkProductionScriptBoundaries();
  const pathExists =
    options.pathExists ||
    ((repoRelativePath: string) => safeExistsSync(pathResolver.rootResolve(repoRelativePath)));
  const packageJsonPath = options.packageJsonPath || pathResolver.rootResolve('package.json');
  const packageJson = loadJson<{
    scripts?: Record<string, string>;
  }>(packageJsonPath);

  for (const [scriptName, command] of Object.entries(packageJson.scripts || {})) {
    const owner = `package.json scripts.${scriptName}`;
    for (const reference of collectCommandReferences(command)) {
      validateRepoPath(reference, owner, violations, pathExists);
      validateScriptBuildTarget(reference, owner, violations, pathExists);
    }
  }

  const pipelineRoots = options.pipelineRoots || DEFAULT_PIPELINE_ROOTS;
  for (const file of listPipelineFiles(pipelineRoots)) {
    const owner = toRepoRelative(file);
    const payload = loadJson<unknown>(file);
    scanValue(owner, payload, violations, pathExists);
  }

  return violations;
}

export const runCheckScriptIntegrity = defineScript({
  name: 'check:script-integrity',
  run(context) {
    const violations = checkScriptIntegrity();
    if (violations.length > 0) {
      throw new Error(violations.join('; '));
    }
    context.print('[check:script-integrity] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_script_integrity.ts') ||
  isDirectScript(import.meta.url, 'check_script_integrity.js')
)
  void runCheckScriptIntegrity();
