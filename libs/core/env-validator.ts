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
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnv as getFoundationRegisteredEnv } from './foundation/env.js';

export interface EnvRegistryValidationEntry {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'enum' | 'path';
  enum?: string[];
  required: boolean;
  documented?: boolean;
}

export interface EnvRegistryEntry extends EnvRegistryValidationEntry {
  category: 'secret' | 'path' | 'flag' | 'tuning' | 'provider' | 'runtime';
  default?: string | null;
  subsystem?: string;
  description: string;
  documented: boolean;
}

export interface EnvRegistryFile {
  $schema?: string;
  version: string;
  description: string;
  entries: EnvRegistryEntry[];
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

export interface EnvValidationOptions {
  /** Promote unknown variables and type mismatches from warnings to errors. */
  strict?: boolean;
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/env-registry.json');
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge('product/schemas/env-registry.schema.json');
const BOOLEAN_VALUE_RE = /^(1|0|true|false|yes|no|on|off)$/i;

const envRegistryCatalog = defineCatalog<EnvRegistryFile>({
  id: 'env-registry',
  path: REGISTRY_PATH,
  schema: REGISTRY_SCHEMA_PATH,
});

export function loadEnvRegistryFile(): EnvRegistryFile {
  return envRegistryCatalog.load();
}

export function loadEnvRegistryEntries(): EnvRegistryValidationEntry[] {
  try {
    return loadEnvRegistryFile().entries;
  } catch {
    return [];
  }
}

export function validateEnvAgainstRegistry(
  entries: EnvRegistryValidationEntry[],
  env: Record<string, string | undefined>,
  options: EnvValidationOptions = {}
): EnvValidationReport {
  const report: EnvValidationReport = {
    errors: [],
    warnings: [],
    unknown: [],
    undocumented: [],
    checked: 0,
  };
  const registered = new Set(entries.map((entry) => entry.name));
  const addIssue = (issue: EnvValidationIssue, strictIssue = false): void => {
    if (options.strict && strictIssue) report.errors.push(issue);
    else report.warnings.push(issue);
  };

  for (const key of Object.keys(env)) {
    if (key.startsWith('KYBERION_') && !registered.has(key)) {
      report.unknown.push(key);
      if (options.strict) {
        report.errors.push({ name: key, issue: 'variable is not registered' });
      }
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
      addIssue(
        {
          name: entry.name,
          issue: 'expected a boolean value (1/0/true/false/yes/no/on/off)',
        },
        true
      );
    } else if (entry.type === 'number' && Number.isNaN(Number(value))) {
      addIssue({ name: entry.name, issue: 'expected a numeric value' }, true);
    } else if (entry.type === 'enum' && entry.enum?.length && !entry.enum.includes(value)) {
      addIssue(
        {
          name: entry.name,
          issue: `expected one of: ${entry.enum.join(', ')}`,
        },
        true
      );
    }
  }

  report.undocumented.sort((a, b) => a.localeCompare(b));

  return report;
}

export function validateEnv(
  env: Record<string, string | undefined> = process.env,
  options: EnvValidationOptions = {}
): EnvValidationReport {
  return validateEnvAgainstRegistry(loadEnvRegistryEntries(), env, options);
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
  return getFoundationRegisteredEnv(name, options) as string | number | boolean | T | undefined;
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
