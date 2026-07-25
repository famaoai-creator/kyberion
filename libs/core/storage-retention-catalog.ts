/**
 * Storage Retention Catalog (AL-01).
 *
 * Loader for `knowledge/product/governance/storage-retention-catalog.json`,
 * the single source of truth for storage retention declarations (which
 * repo-relative directories are TTL-governed, what class of artifact they
 * hold, and what the janitor does when the TTL elapses). The catalog replaces
 * TTL constants that previously lived scattered inside
 * `storage-janitor.ts` (`DEFAULT_TMP_TTL_MS`, `DEFAULT_LOG_RETENTION_DAYS`,
 * `RUNTIME_RETENTION`).
 *
 * Fail-safe contract: the janitor must never die because of a bad catalog.
 * On a missing, unparseable, or schema-invalid catalog this loader falls
 * back to `BUILTIN_RETENTION_DEFAULTS` (which mirror the pre-catalog
 * constants exactly) and reports what went wrong via `warnings` + a logged
 * warning — it never throws.
 *
 * The JSON schema (`knowledge/product/schemas/storage-retention-catalog.schema.json`)
 * documents the vocabulary for external tooling; runtime validation here is
 * structural TypeScript (no schema-file dependency) so the loader keeps
 * working under hermetic test roots where the schema file does not exist.
 */

import * as nodePath from 'node:path';
import { rootDir } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { logger } from './core.js';

export const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION_CATALOG_REPO_PATH =
  'knowledge/product/governance/storage-retention-catalog.json';

export const RETENTION_ARTIFACT_CLASSES = [
  'evidence',
  'report',
  'export',
  'cache',
  'tmp',
  'log',
] as const;
export type RetentionArtifactClass = (typeof RETENTION_ARTIFACT_CLASSES)[number];

export const RETENTION_ACTIONS = ['delete', 'archive'] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

export interface RetentionCatalogEntry {
  /** Repo-relative directory (POSIX separators, no leading/trailing slash). */
  path: string;
  artifact_class: RetentionArtifactClass;
  /**
   * TTL in days. Omitted for note-only entries (e.g. data-vault, whose files
   * carry their own per-entry `expiresAt` and are self-expiring).
   */
  ttl_days?: number;
  action: RetentionAction;
  /** When true, expiry actions should leave an audit record. */
  audit?: boolean;
  note?: string;
}

export interface LoadedRetentionCatalog {
  entries: RetentionCatalogEntry[];
  /** Where the entries came from: the governance catalog, or the built-in fallback. */
  source: 'catalog' | 'builtin-defaults';
  /** Human-readable reasons for a fallback / anomalies. Empty on a clean load. */
  warnings: string[];
}

/**
 * Mirrors the pre-AL-01 in-code constants exactly (behavior-unchanged
 * fallback): tmp 24h, logs 30d, browser-receipts 90d, procedure-deltas 14d,
 * a2a-conversations 30d, data-vault self-expiring.
 */
export const BUILTIN_RETENTION_DEFAULTS: readonly RetentionCatalogEntry[] = Object.freeze([
  {
    path: 'active/shared/tmp',
    artifact_class: 'tmp',
    ttl_days: 1,
    action: 'delete',
    note: 'formerly DEFAULT_TMP_TTL_MS (24h)',
  },
  {
    path: 'active/shared/logs',
    artifact_class: 'log',
    ttl_days: 30,
    action: 'delete',
    note: 'formerly DEFAULT_LOG_RETENTION_DAYS',
  },
  {
    path: 'active/shared/runtime/browser-receipts',
    artifact_class: 'evidence',
    ttl_days: 90,
    action: 'delete',
    note: 'execution evidence, aligned with audit retention (review finding OP-M3)',
  },
  {
    path: 'active/shared/runtime/procedure-deltas',
    artifact_class: 'cache',
    ttl_days: 14,
    action: 'delete',
    note: 'self-repair artifacts, short-lived until promoted',
  },
  {
    path: 'active/shared/runtime/a2a-conversations',
    artifact_class: 'log',
    ttl_days: 30,
    action: 'delete',
  },
  {
    path: 'active/shared/data-vault',
    artifact_class: 'cache',
    action: 'delete',
    note: 'self-expiring: each JSON entry carries its own expiresAt honored per-file by the janitor',
  },
]) as readonly RetentionCatalogEntry[];

function isRepoRelativeDirPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  );
}

function validateEntry(raw: unknown, index: number): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `entries[${index}]: not an object`;
  }
  const entry = raw as Record<string, unknown>;
  if (!isRepoRelativeDirPath(entry.path)) {
    return `entries[${index}]: "path" must be a repo-relative directory path`;
  }
  if (!RETENTION_ARTIFACT_CLASSES.includes(entry.artifact_class as RetentionArtifactClass)) {
    return `entries[${index}] (${String(entry.path)}): invalid "artifact_class" ${JSON.stringify(entry.artifact_class)}`;
  }
  if (!RETENTION_ACTIONS.includes(entry.action as RetentionAction)) {
    return `entries[${index}] (${String(entry.path)}): invalid "action" ${JSON.stringify(entry.action)}`;
  }
  if (entry.ttl_days !== undefined) {
    if (
      typeof entry.ttl_days !== 'number' ||
      !Number.isFinite(entry.ttl_days) ||
      entry.ttl_days <= 0
    ) {
      return `entries[${index}] (${String(entry.path)}): "ttl_days" must be a positive number`;
    }
  }
  if (entry.audit !== undefined && typeof entry.audit !== 'boolean') {
    return `entries[${index}] (${String(entry.path)}): "audit" must be a boolean`;
  }
  if (entry.note !== undefined && typeof entry.note !== 'string') {
    return `entries[${index}] (${String(entry.path)}): "note" must be a string`;
  }
  return null;
}

function fallback(warning: string): LoadedRetentionCatalog {
  logger.warn(`[retention-catalog] ${warning} — falling back to built-in retention defaults`);
  return {
    entries: [...BUILTIN_RETENTION_DEFAULTS],
    source: 'builtin-defaults',
    warnings: [warning],
  };
}

/**
 * Load and validate the retention catalog. Never throws — see the module doc
 * for the fail-safe contract.
 */
export function loadRetentionCatalog(
  options: { catalogPath?: string } = {}
): LoadedRetentionCatalog {
  const catalogPath =
    options.catalogPath ?? nodePath.join(rootDir(), ...RETENTION_CATALOG_REPO_PATH.split('/'));

  let exists = false;
  try {
    exists = safeExistsSync(catalogPath);
  } catch (err) {
    return fallback(
      `retention catalog unreadable at ${catalogPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!exists) {
    return fallback(`retention catalog not found at ${catalogPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(safeReadFile(catalogPath, { encoding: 'utf8' })));
  } catch (err) {
    return fallback(
      `retention catalog corrupt at ${catalogPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const entriesRaw = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
    return fallback(`retention catalog at ${catalogPath} has no "entries" array`);
  }

  const seenPaths = new Set<string>();
  for (let i = 0; i < entriesRaw.length; i++) {
    const error = validateEntry(entriesRaw[i], i);
    if (error) {
      return fallback(`retention catalog invalid at ${catalogPath}: ${error}`);
    }
    const entryPath = (entriesRaw[i] as RetentionCatalogEntry).path;
    if (seenPaths.has(entryPath)) {
      return fallback(
        `retention catalog invalid at ${catalogPath}: duplicate entry for path "${entryPath}"`
      );
    }
    seenPaths.add(entryPath);
  }

  return {
    entries: entriesRaw as RetentionCatalogEntry[],
    source: 'catalog',
    warnings: [],
  };
}

/** TTL in milliseconds declared for an exact repo-relative directory, or null when none/no TTL. */
export function retentionTtlMsForPath(
  catalog: LoadedRetentionCatalog,
  repoRelativeDir: string
): number | null {
  const entry = catalog.entries.find((e) => e.path === repoRelativeDir);
  return entry?.ttl_days !== undefined ? entry.ttl_days * RETENTION_DAY_MS : null;
}

/** TTL in whole days declared for an exact repo-relative directory, or null when none/no TTL. */
export function retentionTtlDaysForPath(
  catalog: LoadedRetentionCatalog,
  repoRelativeDir: string
): number | null {
  const entry = catalog.entries.find((e) => e.path === repoRelativeDir);
  return entry?.ttl_days ?? null;
}

const RUNTIME_PREFIX = 'active/shared/runtime/';

/**
 * TTL rules for `active/shared/runtime/<subdir>` derived from the catalog —
 * the catalog-driven successor of the janitor's former `RUNTIME_RETENTION`
 * constant. Only entries with a `ttl_days` participate.
 */
export function runtimeRetentionRules(
  catalog: LoadedRetentionCatalog
): Array<{ subdir: string; ttlMs: number }> {
  return catalog.entries
    .filter((e) => e.path.startsWith(RUNTIME_PREFIX) && e.ttl_days !== undefined)
    .map((e) => ({
      subdir: e.path.slice(RUNTIME_PREFIX.length),
      ttlMs: (e.ttl_days as number) * RETENTION_DAY_MS,
    }));
}

/**
 * Top-level `active/shared/runtime/` subdirectory names covered by any
 * catalog entry (with or without a TTL). Used by the janitor to report which
 * runtime directories it skipped because no retention rule covers them.
 */
export function coveredRuntimeSubdirs(catalog: LoadedRetentionCatalog): Set<string> {
  const covered = new Set<string>();
  for (const entry of catalog.entries) {
    if (!entry.path.startsWith(RUNTIME_PREFIX)) continue;
    const first = entry.path.slice(RUNTIME_PREFIX.length).split('/')[0];
    if (first) covered.add(first);
  }
  return covered;
}
