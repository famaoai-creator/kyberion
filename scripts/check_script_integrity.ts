#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';

const ROOT = pathResolver.rootDir();

export interface ScriptIntegrityOptions {
  packageJsonPath?: string;
  pipelineRoots?: string[];
}

const DEFAULT_PIPELINE_ROOTS = [
  'pipelines',
  'pipelines/fragments',
  'knowledge/product/pipeline-templates',
];

function toRepoRelative(targetPath: string): string {
  return path.relative(ROOT, path.resolve(targetPath)).split(path.sep).join('/');
}

function existingRepoPath(repoRelativePath: string): boolean {
  return safeExistsSync(pathResolver.rootResolve(repoRelativePath));
}

function sourceForDistScript(repoRelativePath: string): string | null {
  const match = repoRelativePath.match(/^dist\/scripts\/(.+)\.js$/);
  if (!match) return null;
  return `scripts/${match[1]}.ts`;
}

function validateRepoPath(reference: string, owner: string, violations: string[]): void {
  const normalized = reference.replace(/^\.\//, '');
  const sourcePath = sourceForDistScript(normalized);
  if (sourcePath) {
    if (!existingRepoPath(sourcePath)) {
      violations.push(`${owner}: ${normalized} has no source ${sourcePath}`);
    }
    return;
  }
  if (!existingRepoPath(normalized)) {
    violations.push(`${owner}: referenced path not found (${normalized})`);
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

function scanValue(owner: string, value: unknown, violations: string[], keyHint = ''): void {
  if (typeof value === 'string') {
    if (COMMAND_REFERENCE_KEYS.has(keyHint)) {
      for (const reference of collectCommandReferences(value)) {
        validateRepoPath(reference, owner, violations);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanValue(owner, item, violations, keyHint);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      scanValue(owner, nested, violations, key);
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

export function checkScriptIntegrity(options: ScriptIntegrityOptions = {}): string[] {
  const violations: string[] = [];
  const packageJsonPath = options.packageJsonPath || pathResolver.rootResolve('package.json');
  const packageJson = JSON.parse(safeReadFile(packageJsonPath, { encoding: 'utf8' }) as string) as {
    scripts?: Record<string, string>;
  };

  for (const [scriptName, command] of Object.entries(packageJson.scripts || {})) {
    const owner = `package.json scripts.${scriptName}`;
    for (const reference of collectCommandReferences(command)) {
      validateRepoPath(reference, owner, violations);
    }
  }

  const pipelineRoots = options.pipelineRoots || DEFAULT_PIPELINE_ROOTS;
  for (const file of listPipelineFiles(pipelineRoots)) {
    const owner = toRepoRelative(file);
    const payload = JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as unknown;
    scanValue(owner, payload, violations);
  }

  return violations;
}

export function main(): void {
  const violations = checkScriptIntegrity();
  if (violations.length > 0) {
    console.error('[check:script-integrity] violations detected:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }
  console.log('[check:script-integrity] OK');
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
