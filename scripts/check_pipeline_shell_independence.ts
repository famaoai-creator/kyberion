#!/usr/bin/env node
/**
 * Pipeline Shell Independence Check
 *
 * Flags pipeline shell commands that depend on host-specific substitutions or
 * process-substitution tricks (`$(pwd)`, `$(uname -s)`, `$(date)`, `<(...)`,
 * `>(...)`, `/dev/fd`, `mktemp`, direct shell interpreter escapes, implicit
 * host temp paths), or wrappers around repository scripts/actuators
 * (`node dist/`, `npx tsx`, `pnpm exec|dlx`, `dist/libs/actuators/`).
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
  // `pipelines` already contains `pipelines/fragments`; keep the audit one
  // finding per source file even when both roots are configured.
  return [...new Set(files)].sort();
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

function isPipelineShellOp(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const op = (value as Record<string, unknown>).op;
  return op === 'system:shell' || op === 'system:exec';
}

function getCommandAndArgs(params: Record<string, unknown>): {
  command: string;
  args: string[];
} | null {
  const commandValue = [params.cmd, params.command, params.shell_command].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  if (!commandValue) return null;
  const args = Array.isArray(params.args)
    ? params.args.filter((value): value is string => typeof value === 'string')
    : [];
  return { command: commandValue, args };
}

function detectScriptWrapper(command: string, args: readonly string[]): string | undefined {
  const normalized = [command, ...args].join(' ').replace(/\s+/g, ' ').trim();
  const executable = command.trim().split(/[\\/]/).pop()?.toLowerCase();

  // Typed system:exec shape: command and args are separate fields.
  if (executable === 'node') {
    if (
      args.some(
        (arg) =>
          /(?:^|\.\/?)(?:dist|scripts|libs\/actuators|presence|src|tests?)\//i.test(arg) ||
          /\.(?:[cm]?js|mjs|cjs|ts|tsx)$/i.test(arg)
      ) ||
      args.some((arg) => arg === '-e' || arg === '--eval')
    ) {
      return normalized;
    }
  }
  if (executable === 'npx' && args[0]?.toLowerCase() === 'tsx') return normalized;
  if (executable === 'pnpm' && ['exec', 'dlx'].includes(args[0]?.toLowerCase() ?? '')) {
    return normalized;
  }
  if (executable === 'tsx') return normalized;

  // Raw system:shell shape, including environment assignments and chained commands.
  if (
    /(?:^|[;&|]\s*|\s)node\s+(?:(?:--import|--require)\s+[^;&|]+\s+)?(?:\.\/)?(?:dist|scripts|libs\/actuators|presence|src|tests?)\/[^;&|\s]+/iu.test(
      normalized
    ) ||
    /(?:^|[;&|]\s*|\s)node\s+(?:-e|--eval)\b/iu.test(normalized) ||
    /(?:^|[;&|]\s*|\s)npx\s+tsx\b/iu.test(normalized) ||
    /(?:^|[;&|]\s*|\s)pnpm\s+(?:exec|dlx)\b/iu.test(normalized) ||
    /(?:^|[;&|]\s*|\s)tsx\s+(?:\.\/)?scripts\//iu.test(normalized) ||
    /dist\/libs\/actuators\//iu.test(normalized)
  ) {
    return normalized;
  }
  return undefined;
}

function scanScriptWrappers(file: string, value: unknown, violations: ShellViolation[]): void {
  if (Array.isArray(value)) {
    for (const item of value) scanScriptWrappers(file, item, violations);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (isPipelineShellOp(record) && record.params && typeof record.params === 'object') {
    const command = getCommandAndArgs(record.params as Record<string, unknown>);
    if (command) {
      const match = detectScriptWrapper(command.command, command.args);
      if (match) {
        violations.push({ file, pattern: 'script-wrapper', match });
      }
    }
  }

  for (const nested of Object.values(record)) {
    scanScriptWrappers(file, nested, violations);
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
    scanScriptWrappers(file, data, violations);
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
