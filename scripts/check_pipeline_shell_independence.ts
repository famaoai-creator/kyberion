#!/usr/bin/env node
/**
 * Pipeline Shell Independence Check
 *
 * Flags pipeline shell commands that depend on host-specific substitutions or
 * process-substitution tricks (`$(pwd)`, `$(uname -s)`, `$(date)`, `<(...)`,
 * `>(...)`, `/dev/fd`, `mktemp`, direct shell interpreter escapes, implicit
 * host temp paths).
 *
 * The goal is not to ban shell entirely; it is to keep pipelines portable by
 * forcing runtime context to come from pipeline inputs or helper scripts.
 */

import * as path from 'node:path';
import { loadJson, pathResolver, safeExistsSync, safeReaddir, safeStat } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

interface ShellViolation {
  file: string;
  pattern: string;
  match: string;
}

const ROOT = pathResolver.rootDir();
const PIPELINE_ROOTS = [
  path.join(ROOT, 'pipelines'),
  path.join(ROOT, 'pipelines', 'fragments'),
  path.join(ROOT, 'knowledge', 'product', 'pipeline-templates'),
];

const FORBIDDEN_PATTERNS: Array<{ pattern: string; regex: RegExp }> = [
  { pattern: 'pwd-substitution', regex: /\$\(\s*pwd\s*\)/i },
  { pattern: 'uname-substitution', regex: /\$\(\s*uname\s+-s\s*\)/i },
  { pattern: 'date-substitution', regex: /\$\(\s*date\b/i },
  { pattern: 'process-substitution', regex: /[<>]\(\s*[^)]+\)/ },
  { pattern: 'dev-fd', regex: /\/dev\/fd\//i },
  { pattern: 'mktemp', regex: /\bmktemp\b/i },
  { pattern: 'shell-interpreter', regex: /\b(?:bash|zsh|sh)\s+-c\b/i },
  {
    pattern: 'implicit-host-temp-path',
    regex: /(?:^|[\s"'=:])(?:\/tmp|\/var\/tmp|\$TMPDIR|\$\{TMPDIR\})(?:\/|\b)/i,
  },
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

export function scanPipelineShellIndependence(
  files: string[] = listPipelineFiles()
): ShellViolation[] {
  const violations: ShellViolation[] = [];
  for (const file of files) {
    if (!safeExistsSync(file)) continue;
    const data = loadJson<unknown>(file);
    scanValue(file, data, violations);
  }
  return violations;
}

export const runCheckPipelineShellIndependence = defineScript({
  name: 'check:pipeline-shell-independence',
  flags: [],
  run(context) {
    const violations = scanPipelineShellIndependence();
    if (violations.length > 0) {
      console.error('[check:pipeline-shell-independence] violations detected:');
      for (const violation of violations) {
        console.error(
          `- ${path.relative(ROOT, violation.file)} :: ${violation.pattern} :: ${JSON.stringify(violation.match)}`
        );
      }
      throw new Error(`${violations.length} pipeline shell independence violation(s)`);
    }
    context.print('[check:pipeline-shell-independence] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_pipeline_shell_independence.ts') ||
  isDirectScript(import.meta.url, 'check_pipeline_shell_independence.js')
)
  void runCheckPipelineShellIndependence();
