/**
 * env-validator.ts — OP-05: validate KYBERION_* environment variables against
 * the canonical registry (knowledge/product/governance/env-registry.json).
 *
 * Default posture is warn-only: unknown variables and type mismatches are
 * reported as warnings so a stale registry never blocks startup. Only missing
 * `required: true` entries are errors (fail-fast candidates for callers).
 *
 * Messages never include variable values — names and expectations only.
 */

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export interface EnvRegistryValidationEntry {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'enum' | 'path';
  enum?: string[];
  required: boolean;
}

export interface EnvValidationIssue {
  name: string;
  issue: string;
}

export interface EnvValidationReport {
  errors: EnvValidationIssue[];
  warnings: EnvValidationIssue[];
  unknown: string[];
  checked: number;
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/env-registry.json');
const BOOLEAN_VALUE_RE = /^(1|0|true|false|yes|no|on|off)$/i;

export function loadEnvRegistryEntries(): EnvRegistryValidationEntry[] {
  if (!safeExistsSync(REGISTRY_PATH)) return [];
  try {
    const parsed = JSON.parse(String(safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }) || '{}'));
    return Array.isArray(parsed.entries) ? (parsed.entries as EnvRegistryValidationEntry[]) : [];
  } catch {
    return [];
  }
}

export function validateEnvAgainstRegistry(
  entries: EnvRegistryValidationEntry[],
  env: Record<string, string | undefined>
): EnvValidationReport {
  const report: EnvValidationReport = { errors: [], warnings: [], unknown: [], checked: 0 };
  const registered = new Set(entries.map((entry) => entry.name));

  for (const key of Object.keys(env)) {
    if (key.startsWith('KYBERION_') && !registered.has(key)) {
      report.unknown.push(key);
    }
  }
  report.unknown.sort((a, b) => a.localeCompare(b));

  for (const entry of entries) {
    const value = env[entry.name];
    if (value === undefined || value === '') {
      if (entry.required) {
        report.errors.push({ name: entry.name, issue: 'required variable is not set' });
      }
      continue;
    }
    report.checked += 1;
    if (entry.type === 'boolean' && !BOOLEAN_VALUE_RE.test(value)) {
      report.warnings.push({
        name: entry.name,
        issue: 'expected a boolean value (1/0/true/false/yes/no/on/off)',
      });
    } else if (entry.type === 'number' && Number.isNaN(Number(value))) {
      report.warnings.push({ name: entry.name, issue: 'expected a numeric value' });
    } else if (entry.type === 'enum' && entry.enum?.length && !entry.enum.includes(value)) {
      report.warnings.push({
        name: entry.name,
        issue: `expected one of: ${entry.enum.join(', ')}`,
      });
    }
  }

  return report;
}

export function validateEnv(
  env: Record<string, string | undefined> = process.env
): EnvValidationReport {
  return validateEnvAgainstRegistry(loadEnvRegistryEntries(), env);
}

export function formatEnvValidationReport(report: EnvValidationReport): string[] {
  const lines: string[] = [];
  lines.push(
    `Env configuration: ${report.checked} registered variable(s) set, ` +
      `${report.errors.length} error(s), ${report.warnings.length} warning(s), ` +
      `${report.unknown.length} unknown`
  );
  for (const issue of report.errors) {
    lines.push(`  ✗ ${issue.name}: ${issue.issue}`);
  }
  for (const issue of report.warnings) {
    lines.push(`  ⚠ ${issue.name}: ${issue.issue}`);
  }
  if (report.unknown.length > 0) {
    lines.push(
      `  ⚠ unregistered KYBERION_* variables set: ${report.unknown.join(', ')} ` +
        '(register via pnpm generate:env-registry)'
    );
  }
  return lines;
}
