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
import { safeExistsSync } from './secure-io.js';
import { readJson } from './foundation/json.js';

export interface EnvRegistryValidationEntry {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'enum' | 'path';
  enum?: string[];
  required: boolean;
  documented?: boolean;
}

export interface EnvValidationIssue {
  name: string;
  issue: string;
}

export interface EnvValidationReport {
  errors: EnvValidationIssue[];
  warnings: EnvValidationIssue[];
  unknown: string[];
  undocumented: string[];
  checked: number;
}

export interface RegisteredEnvReadOptions<T = string> {
  env?: Record<string, string | undefined>;
  defaultValue?: T;
  /** Throw when a registered value is invalid instead of using the default. */
  strict?: boolean;
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/env-registry.json');
const BOOLEAN_VALUE_RE = /^(1|0|true|false|yes|no|on|off)$/i;

export function loadEnvRegistryEntries(): EnvRegistryValidationEntry[] {
  if (!safeExistsSync(REGISTRY_PATH)) return [];
  try {
    const parsed = readJson<{ entries?: unknown }>(REGISTRY_PATH);
    return Array.isArray(parsed.entries) ? (parsed.entries as EnvRegistryValidationEntry[]) : [];
  } catch {
    return [];
  }
}

export function validateEnvAgainstRegistry(
  entries: EnvRegistryValidationEntry[],
  env: Record<string, string | undefined>
): EnvValidationReport {
  const report: EnvValidationReport = {
    errors: [],
    warnings: [],
    unknown: [],
    undocumented: [],
    checked: 0,
  };
  const registered = new Set(entries.map((entry) => entry.name));

  for (const key of Object.keys(env)) {
    if (key.startsWith('KYBERION_') && !registered.has(key)) {
      report.unknown.push(key);
    }
  }
  report.unknown.sort((a, b) => a.localeCompare(b));

  for (const entry of entries) {
    if (entry.documented !== true) report.undocumented.push(entry.name);
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

  report.undocumented.sort((a, b) => a.localeCompare(b));

  return report;
}

export function validateEnv(
  env: Record<string, string | undefined> = process.env
): EnvValidationReport {
  return validateEnvAgainstRegistry(loadEnvRegistryEntries(), env);
}

/**
 * Read a setting through the canonical env registry.
 *
 * Existing call sites can migrate incrementally without changing the
 * warn-by-default startup policy. Values are parsed according to the
 * registered type; invalid values fall back to the caller's default unless
 * `strict` is requested. Secret values are never included in errors.
 */
export function getRegisteredEnv<T = string>(
  name: string,
  options: RegisteredEnvReadOptions<T> = {}
): string | number | boolean | T | undefined {
  const env = options.env ?? process.env;
  const raw = env[name];
  if (raw === undefined || raw === '') return options.defaultValue;

  const entry = loadEnvRegistryEntries().find((candidate) => candidate.name === name);
  if (!entry) return raw;

  const invalid = (): string | number | boolean | T | undefined => {
    if (options.strict) {
      throw new Error(`Invalid value for registered environment variable ${name}`);
    }
    return options.defaultValue;
  };

  switch (entry.type) {
    case 'boolean':
      if (/^(1|true|yes|on)$/i.test(raw)) return true;
      if (/^(0|false|no|off)$/i.test(raw)) return false;
      return invalid();
    case 'number': {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : invalid();
    }
    case 'enum':
      return entry.enum?.includes(raw) ? raw : invalid();
    case 'path':
    case 'string':
    default:
      return raw;
  }
}

export function formatEnvValidationReport(report: EnvValidationReport): string[] {
  const lines: string[] = [];
  lines.push(
    `Env configuration: ${report.checked} registered variable(s) set, ` +
      `${report.errors.length} error(s), ${report.warnings.length} warning(s), ` +
      `${report.unknown.length} unknown, ${report.undocumented.length} undocumented`
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
  if (report.undocumented.length > 0) {
    lines.push(
      `  ⚠ ${report.undocumented.length} registered KYBERION_* variable(s) lack documentation ` +
        '(curate description/documented in knowledge/product/governance/env-registry.json)'
    );
  }
  return lines;
}
