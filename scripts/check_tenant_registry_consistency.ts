/**
 * DA-01: Tenant registry consistency checker (`pnpm check:tenant-registry`).
 *
 * Cross-checks the tenant slug sets across the coexisting tenant reference
 * systems and exits non-zero on drift:
 *
 *   (a) tenant profiles — the SPINE (libs/core/tenant-registry.ts:
 *       knowledge/personal/tenants/*.json, or customer/{slug}/tenants/*.json
 *       when KYBERION_CUSTOMER is set),
 *   (b) knowledge/confidential/tenants/index.json (design override index),
 *   (c) top-level customer/{slug}/ directories,
 *   (d) project registry — NOT APPLICABLE: libs/core/project-registry.ts
 *       ProjectRecord carries no tenant slug field (verified 2026-07-28), so
 *       there is nothing to cross-check; reported as a note.
 *
 * Consistency rule: every slug known to (b) or (c) must either have a tenant
 * profile in (a) — which must resolve via resolveTenant() — or be listed in
 * the documented exception allowlist:
 *
 *   knowledge/product/governance/tenant-registry-exceptions.json
 *   { "exceptions": [ { "slug": "...", "reason": "one-line reason" } ] }
 *
 * A slug that exists only in (a) is fine: the profile is the spine, the other
 * systems are optional facets. Exception entries that match no known slug are
 * surfaced as warnings (never failures — CI checkouts have no gitignored
 * tenant data, so every exception is legitimately unused there).
 *
 * All output is codepoint-sorted (never localeCompare) for cross-platform
 * reproducibility.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listTenantProfileSlugs,
  pathResolver,
  resolveTenant,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeStat,
  listProjectRecords,
} from '@agent/core';

export const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const EXCEPTIONS_RELATIVE_PATH =
  'knowledge/product/governance/tenant-registry-exceptions.json';
const CONFIDENTIAL_INDEX_RELATIVE_PATH = 'knowledge/confidential/tenants/index.json';

export interface TenantRegistryException {
  slug: string;
  reason: string;
}

export interface TenantSystemsSnapshot {
  /** (a) tenant profile slugs — the spine. */
  profiles: string[];
  /** (b) ids in knowledge/confidential/tenants/index.json. */
  confidentialIndex: string[];
  /** (c) top-level customer/{slug}/ directory names. */
  customerDirs: string[];
  /** (d) tenant slugs declared by project registry records. */
  projectTenants: string[];
  notes: string[];
}

export interface TenantConsistencyRow {
  slug: string;
  profile: boolean;
  confidential_index: boolean;
  customer_dir: boolean;
  project_registry: boolean;
  exception: string | null;
}

export interface TenantConsistencyReport {
  rows: TenantConsistencyRow[];
  violations: string[];
  warnings: string[];
  notes: string[];
}

export interface CheckOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

export function collectTenantSystems(options: CheckOptions = {}): TenantSystemsSnapshot {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const env = options.env ?? process.env;
  const notes: string[] = [];

  const profiles = listTenantProfileSlugs({ rootDir, env });
  if (profiles.length === 0) {
    notes.push('(a) tenant profile directory is empty or absent — treated as empty set');
  }

  let confidentialIndex: string[] = [];
  const indexPath = path.join(rootDir, CONFIDENTIAL_INDEX_RELATIVE_PATH);
  const indexPayload = readJsonIfExists<{ tenants?: Array<{ id?: string }> }>(indexPath);
  if (indexPayload) {
    confidentialIndex = (indexPayload.tenants || [])
      .map((entry) => String(entry.id || ''))
      .filter((id) => id.length > 0)
      .sort();
  } else {
    notes.push(`(b) ${CONFIDENTIAL_INDEX_RELATIVE_PATH} not present — treated as empty set`);
  }

  let customerDirs: string[] = [];
  const customerBase = path.join(rootDir, 'customer');
  if (safeExistsSync(customerBase)) {
    customerDirs = safeReaddir(customerBase)
      .filter((entry) => {
        try {
          return safeStat(path.join(customerBase, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } else {
    notes.push('(c) customer/ directory not present — treated as empty set');
  }

  const projectTenants =
    path.resolve(rootDir) === path.resolve(pathResolver.rootDir())
      ? listProjectRecords()
          .map((record) => record.tenant_slug)
          .filter((slug): slug is string => Boolean(slug && slug !== 'shared'))
          .sort()
      : [];
  notes.push(
    '(d) project registry tenant_slug fields are included in the tenant spine cross-check'
  );

  return { profiles, confidentialIndex, customerDirs, projectTenants, notes };
}

export function loadTenantRegistryExceptions(options: CheckOptions = {}): {
  exceptions: TenantRegistryException[];
  problems: string[];
} {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const problems: string[] = [];
  const payload = readJsonIfExists<{ exceptions?: TenantRegistryException[] }>(
    path.join(rootDir, EXCEPTIONS_RELATIVE_PATH)
  );
  const exceptions = payload?.exceptions ?? [];
  const seen = new Set<string>();
  for (const entry of exceptions) {
    if (!entry.slug || typeof entry.slug !== 'string') {
      problems.push('exceptions: entry with empty or non-string slug');
      continue;
    }
    if (!entry.reason || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(
        `exceptions: '${entry.slug}' has no reason — every exception must document why`
      );
    }
    if (seen.has(entry.slug)) {
      problems.push(`exceptions: duplicate entry for '${entry.slug}'`);
    }
    seen.add(entry.slug);
  }
  return { exceptions, problems };
}

export function evaluateTenantConsistency(
  systems: TenantSystemsSnapshot,
  exceptions: TenantRegistryException[],
  options: CheckOptions = {}
): TenantConsistencyReport {
  const violations: string[] = [];
  const warnings: string[] = [];
  const exceptionBySlug = new Map<string, string>(
    exceptions.map((entry) => [entry.slug, entry.reason])
  );

  const profileSet = new Set(systems.profiles);
  const indexSet = new Set(systems.confidentialIndex);
  const customerSet = new Set(systems.customerDirs);
  const projectSet = new Set(systems.projectTenants);
  const allSlugs = Array.from(
    new Set([...profileSet, ...indexSet, ...customerSet, ...projectSet])
  ).sort();

  const rows: TenantConsistencyRow[] = allSlugs.map((slug) => ({
    slug,
    profile: profileSet.has(slug),
    confidential_index: indexSet.has(slug),
    customer_dir: customerSet.has(slug),
    project_registry: projectSet.has(slug),
    exception: exceptionBySlug.get(slug) ?? null,
  }));

  for (const row of rows) {
    const excepted = row.exception != null;
    if (!TENANT_SLUG_RE.test(row.slug)) {
      if (!excepted) {
        violations.push(
          `'${row.slug}' is not a valid tenant slug (${TENANT_SLUG_RE.source}) and has no documented exception`
        );
      }
      continue;
    }
    if (!row.profile) {
      if (!excepted) {
        const knownTo = [
          row.confidential_index ? 'confidential index' : null,
          row.customer_dir ? 'customer/ directory' : null,
          row.project_registry ? 'project registry' : null,
        ]
          .filter((label) => label != null)
          .join(' + ');
        violations.push(
          `'${row.slug}' is known to ${knownTo} but has no tenant profile — register it in the tenant profile directory or add a documented exception`
        );
      }
      continue;
    }
    if (excepted) {
      warnings.push(
        `'${row.slug}' has both a tenant profile and an exception — the exception is redundant`
      );
    }
    try {
      resolveTenant(row.slug, options);
    } catch (error) {
      violations.push(`profile for '${row.slug}' failed to resolve: ${(error as Error).message}`);
    }
  }

  const knownSlugs = new Set(allSlugs);
  for (const entry of exceptions) {
    if (!knownSlugs.has(entry.slug)) {
      warnings.push(
        `exception for '${entry.slug}' matches no slug in any system (stale entry, or the data is absent from this checkout)`
      );
    }
  }

  return { rows, violations, warnings, notes: systems.notes };
}

export function renderReport(report: TenantConsistencyReport): string {
  const lines: string[] = [];
  const header = ['slug', 'profile', 'conf-index', 'customer-dir', 'project-reg', 'status'];
  const rowsAsText = report.rows.map((row) => [
    row.slug,
    row.profile ? 'yes' : '-',
    row.confidential_index ? 'yes' : '-',
    row.customer_dir ? 'yes' : '-',
    row.project_registry ? 'yes' : '-',
    row.exception != null ? `exception: ${row.exception}` : row.profile ? 'ok' : 'DRIFT',
  ]);
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rowsAsText.map((row) => row[column].length))
  );
  const renderRow = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  lines.push(renderRow(header));
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rowsAsText) lines.push(renderRow(row));
  return lines.join('\n');
}

export function runCheck(options: CheckOptions = {}): { exitCode: number; output: string } {
  const output: string[] = [];
  const systems = collectTenantSystems(options);
  const { exceptions, problems } = loadTenantRegistryExceptions(options);
  const report = evaluateTenantConsistency(systems, exceptions, options);
  report.violations.push(...problems);

  if (report.rows.length > 0) {
    output.push(renderReport(report));
    output.push('');
  }
  for (const note of report.notes.sort()) output.push(`note: ${note}`);
  for (const warning of report.warnings.sort()) output.push(`warning: ${warning}`);
  if (report.violations.length > 0) {
    output.push('[check:tenant-registry] drift detected:');
    for (const violation of report.violations.sort()) output.push(`- ${violation}`);
    return { exitCode: 1, output: output.join('\n') };
  }
  output.push('[check:tenant-registry] OK');
  return { exitCode: 0, output: output.join('\n') };
}

const isDirectExecution =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const { exitCode, output } = runCheck();
  if (exitCode === 0) console.log(output);
  else console.error(output);
  process.exit(exitCode);
}
