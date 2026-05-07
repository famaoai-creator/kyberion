#!/usr/bin/env node
/**
 * Pipeline Shell Independence Check
 *
 * Flags pipeline shell commands that depend on host-specific substitutions or
 * process-substitution tricks (`$(pwd)`, `$(uname -s)`, `$(date)`, `<(...)`,
 * `>(...)`, `/dev/fd`, `mktemp`).
 *
 * The goal is not to ban shell entirely; it is to keep pipelines portable by
 * forcing runtime context to come from pipeline inputs or helper scripts.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver, safeExistsSync, safeReadFile, safeReaddir, safeStat } from '@agent/core';

interface ShellViolation {
  file: string;
  pattern: string;
  match: string;
}

const ROOT = pathResolver.rootDir();
const PIPELINE_ROOTS = [
  path.join(ROOT, 'pipelines'),
  path.join(ROOT, 'pipelines', 'fragments'),
];

const FORBIDDEN_PATTERNS: Array<{ pattern: string; regex: RegExp }> = [
  { pattern: 'pwd-substitution', regex: /\$\(\s*pwd\s*\)/i },
  { pattern: 'uname-substitution', regex: /\$\(\s*uname\s+-s\s*\)/i },
  { pattern: 'date-substitution', regex: /\$\(\s*date\b/i },
  { pattern: 'process-substitution', regex: /[<>]\(\s*[^)]+\)/ },
  { pattern: 'dev-fd', regex: /\/dev\/fd\//i },
  { pattern: 'mktemp', regex: /\bmktemp\b/i },
];

function listPipelineFiles(roots: string[] = PIPELINE_ROOTS): string[] {
  const files: string[] = [];
  const walk = (target: string): void => {
    if (!safeExistsSync(target)) return;
    const stat = safeStat(target);
    if (stat.isDirectory()) {
      for (const entry of safeReaddir(target)) {
        walk(path.join(target, entry));
      }
      return;
    }
    if (stat.isFile() && target.endsWith('.json')) {
      files.push(target);
    }
  };

  for (const root of roots) {
    walk(root);
  }
  return files;
}

function scanValue(file: string, value: unknown, violations: ShellViolation[]): void {
  if (typeof value === 'string') {
    for (const rule of FORBIDDEN_PATTERNS) {
      const match = value.match(rule.regex);
      if (match) {
        violations.push({
          file,
          pattern: rule.pattern,
          match: match[0],
        });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanValue(file, item, violations);
    return;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      scanValue(file, nested, violations);
    }
  }
}

export function scanPipelineShellIndependence(files: string[] = listPipelineFiles()): ShellViolation[] {
  const violations: ShellViolation[] = [];
  for (const file of files) {
    if (!safeExistsSync(file)) continue;
    const data = JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as unknown;
    scanValue(file, data, violations);
  }
  return violations;
}

export function main(): void {
  const violations = scanPipelineShellIndependence();
  if (violations.length > 0) {
    console.error('[check:pipeline-shell-independence] violations detected:');
    for (const violation of violations) {
      console.error(
        `- ${path.relative(ROOT, violation.file)} :: ${violation.pattern} :: ${JSON.stringify(violation.match)}`
      );
    }
    process.exit(1);
  }
  console.log('[check:pipeline-shell-independence] OK');
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
