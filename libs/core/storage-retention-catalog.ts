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
 * is enforced by the shared governed catalog boundary. Domain-specific path
 * and duplicate checks remain below because they are retention semantics, not
 * generic JSON shape validation.
 */

import * as nodePath from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { rootDir } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
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
  /**
   * AL-04: load-bearing runtime state (registries, locks, sessions, oauth
   * tokens, service bindings, …). State directories are declared so coverage
   * is complete, but they are never TTL-deleted — pair with
   * `action: 'review_required'`.
   */
  'state',
] as const;
export type RetentionArtifactClass = (typeof RETENTION_ARTIFACT_CLASSES)[number];

export const RETENTION_ACTIONS = [
  'delete',
  'archive',
  /**
   * AL-04: no automatic deletion — the directory is declared (so it never
   * shows up as uncovered) and surfaced in the janitor report for a human
   * retention decision. The janitor MUST NOT delete anything under it —
   * except through a nested `status_rules` entry, the one explicit, opt-in
   * exception (see `RetentionStatusRule`).
   */
  'review_required',
] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

/**
 * AL-04: shared audit JSONL (under `active/shared/logs/audit/`) for retention
 * deletions, soft-deletes, trash purges, mission runtime-residue GC, and
 * tenant/project offboarding steps. Sibling of AL-03's
 * `mission-closure.jsonl` / `mission-purge.jsonl`.
 */
export const STORAGE_RETENTION_AUDIT_FILENAME = 'storage-retention.jsonl';

/**
 * Actions a per-file status rule may declare. Only `delete` is implemented —
 * a status-based rule expresses "this specific file, by its own JSON status
 * field, is past its own TTL", which the janitor sweep resolves through the
 * same audited `expireFilePerPolicy` path as a directory-level `delete`
 * entry (soft-delete when the owning directory entry declares
 * `soft_delete_days`).
 */
export const STATUS_RULE_ACTIONS = ['delete'] as const;
export type StatusRuleAction = (typeof STATUS_RULE_ACTIONS)[number];

/**
 * WI-16: a declarative, per-file status-aware expiry rule nested under a
 * directory-level catalog entry. Directory-level `ttl_days`/mtime cannot
 * express "this file's own `pending_review` status is 30 days stale" without
 * also catching `confirmed` records in the same sweep — a `status_rules`
 * entry closes that gap by reading one JSON field (`status_field`) and one
 * JSON date field (`age_field`) out of each file the pattern matches, instead
 * of trusting directory mtime.
 *
 * Status rules are the one explicit, opt-in exception to "review_required
 * never becomes a deletion rule" (AL-04): a rule nested under a
 * `review_required` entry deletes inside it, but only by the rule's own
 * `action: 'delete'`, scoped to files matching its `path_pattern` whose
 * `status_field` is one of its `statuses` and past its `ttl_days`. Nothing
 * else under the entry is ever deleted.
 */
export interface RetentionStatusRule {
  /** Stable identifier, named in the janitor's deletion audit record. */
  id: string;
  /**
   * Glob-like path, relative to the owning entry's `path`, matched against
   * every file under that directory. A `*` matches within one path segment
   * only (it never spans a path separator); segments are otherwise literal
   * repo-relative-safe path pieces (no `..`, no leading/trailing slash, no
   * absolute path). Example (see the `knowledge/personal/members` entry in
   * the governance catalog): a wildcard member-id segment, then the literal
   * `work-inventory`, `observations`, then a wildcard `.json` filename.
   */
  path_pattern: string;
  /** JSON field (top-level) read from each matched file to test `statuses`. */
  status_field: string;
  /** The file is a candidate only when `status_field`'s value is one of these. */
  statuses: string[];
  /** JSON field (top-level, ISO date string) the TTL is measured from. */
  age_field: string;
  ttl_days: number;
  action: StatusRuleAction;
}

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
  /**
   * AL-04 soft-delete grace: instead of unlinking, the janitor moves expired
   * files to `active/archive/.trash/<original-repo-relative-path>` and purges
   * them from the trash only after this many further days.
   */
  soft_delete_days?: number;
  note?: string;
  /** WI-16: per-file status-aware expiry rules nested under this directory. */
  status_rules?: RetentionStatusRule[];
}

export interface LoadedRetentionCatalog {
  entries: RetentionCatalogEntry[];
  /** Where the entries came from: the governance catalog, or the built-in fallback. */
  source: 'catalog' | 'builtin-defaults';
  /** Human-readable reasons for a fallback / anomalies. Empty on a clean load. */
  warnings: string[];
}

interface RetentionCatalogFile {
  version: string;
  entries: RetentionCatalogEntry[];
}

function retentionCatalogSchemaPath(): string {
  return nodePath.join(
    rootDir(),
    'knowledge/product/schemas/storage-retention-catalog.schema.json'
  );
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

/**
 * WI-16: relative glob-like path segment check for `status_rules[].path_pattern`
 * — same safety bar as {@link isRepoRelativeDirPath} (no leading/trailing
 * slash, no backslash, no `.`/`..` segment, no absolute path) plus `*`
 * allowed as a within-segment wildcard character.
 */
function isSafeStatusRulePattern(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('\\') &&
    value
      .split('/')
      .every(
        (seg) => seg.length > 0 && seg !== '.' && seg !== '..' && /^[A-Za-z0-9_.*-]+$/.test(seg)
      )
  );
}

function validateStatusRule(raw: unknown, entryIndex: number, ruleIndex: number): string | null {
  const where = `entries[${entryIndex}].status_rules[${ruleIndex}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${where}: not an object`;
  }
  const rule = raw as Record<string, unknown>;
  if (typeof rule.id !== 'string' || rule.id.length === 0) {
    return `${where}: "id" must be a non-empty string`;
  }
  if (!isSafeStatusRulePattern(rule.path_pattern)) {
    return `${where} (${rule.id}): "path_pattern" must be a safe relative glob path`;
  }
  if (typeof rule.status_field !== 'string' || rule.status_field.length === 0) {
    return `${where} (${rule.id}): "status_field" must be a non-empty string`;
  }
  if (
    !Array.isArray(rule.statuses) ||
    rule.statuses.length === 0 ||
    !rule.statuses.every((s) => typeof s === 'string' && s.length > 0)
  ) {
    return `${where} (${rule.id}): "statuses" must be a non-empty array of non-empty strings`;
  }
  if (typeof rule.age_field !== 'string' || rule.age_field.length === 0) {
    return `${where} (${rule.id}): "age_field" must be a non-empty string`;
  }
  if (
    typeof rule.ttl_days !== 'number' ||
    !Number.isFinite(rule.ttl_days) ||
    (rule.ttl_days as number) <= 0
  ) {
    return `${where} (${rule.id}): "ttl_days" must be a positive number`;
  }
  if (!STATUS_RULE_ACTIONS.includes(rule.action as StatusRuleAction)) {
    return `${where} (${rule.id}): invalid "action" ${JSON.stringify(rule.action)}`;
  }
  return null;
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
  if (entry.soft_delete_days !== undefined) {
    if (
      typeof entry.soft_delete_days !== 'number' ||
      !Number.isFinite(entry.soft_delete_days) ||
      entry.soft_delete_days <= 0
    ) {
      return `entries[${index}] (${String(entry.path)}): "soft_delete_days" must be a positive number`;
    }
  }
  if (entry.note !== undefined && typeof entry.note !== 'string') {
    return `entries[${index}] (${String(entry.path)}): "note" must be a string`;
  }
  if (entry.status_rules !== undefined) {
    if (!Array.isArray(entry.status_rules)) {
      return `entries[${index}] (${String(entry.path)}): "status_rules" must be an array`;
    }
    for (let j = 0; j < entry.status_rules.length; j++) {
      const error = validateStatusRule(entry.status_rules[j], index, j);
      if (error) return error;
    }
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

  try {
    const parsed = defineCatalog<RetentionCatalogFile>({
      id: 'storage-retention-catalog',
      path: catalogPath,
      schema: retentionCatalogSchemaPath(),
    }).load();
    const entriesRaw = parsed.entries;
    if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
      return fallback(`retention catalog at ${catalogPath} has no "entries" array`);
    }

    const seenPaths = new Set<string>();
    for (let i = 0; i < entriesRaw.length; i++) {
      const error = validateEntry(entriesRaw[i], i);
      if (error) {
        return fallback(`retention catalog invalid at ${catalogPath}: ${error}`);
      }
      const entryPath = entriesRaw[i].path;
      if (seenPaths.has(entryPath)) {
        return fallback(
          `retention catalog invalid at ${catalogPath}: duplicate entry for path "${entryPath}"`
        );
      }
      seenPaths.add(entryPath);
    }

    return {
      entries: entriesRaw,
      source: 'catalog',
      warnings: [],
    };
  } catch (err) {
    return fallback(
      `retention catalog corrupt at ${catalogPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
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
 * constant. Only entries with a `ttl_days` participate; `review_required`
 * entries NEVER become scan rules (AL-04), even if a ttl_days slipped in.
 * (Status rules are the one explicit, opt-in exception — a rule's own
 * `action: 'delete'` scoped to its pattern/statuses; see `RetentionStatusRule`.)
 */
export function runtimeRetentionRules(
  catalog: LoadedRetentionCatalog
): Array<{ subdir: string; ttlMs: number; entry: RetentionCatalogEntry }> {
  return catalog.entries
    .filter(
      (e) =>
        e.path.startsWith(RUNTIME_PREFIX) &&
        e.ttl_days !== undefined &&
        e.action !== 'review_required'
    )
    .map((e) => ({
      subdir: e.path.slice(RUNTIME_PREFIX.length),
      ttlMs: (e.ttl_days as number) * RETENTION_DAY_MS,
      entry: e,
    }));
}

/**
 * EV-06: append-only event stores that live OUTSIDE `active/shared/runtime/`.
 *
 * The janitor's scan functions were rooted at tmp / logs / data-vault / runtime
 * / trash, so these trees were neither TTL-governed nor reported as uncovered —
 * an undeclared path under `runtime/` at least shows up in the janitor report,
 * while a path outside every scan root is invisible. That invisibility is how
 * the event stores grew without bound in silence.
 */
export const EVENT_STORE_PREFIXES = [
  'active/shared/observability',
  'active/shared/coordination/orchestration/events',
  'presence/bridge/runtime',
] as const;

function isEventStorePath(repoRelativePath: string): boolean {
  return EVENT_STORE_PREFIXES.some(
    (prefix) => repoRelativePath === prefix || repoRelativePath.startsWith(`${prefix}/`)
  );
}

/**
 * TTL rules for declared event-store directories. Same contract as
 * {@link runtimeRetentionRules}: only entries carrying a `ttl_days`
 * participate, and `review_required` never becomes a deletion rule (status
 * rules are the one explicit, opt-in exception; see `RetentionStatusRule`).
 */
export function eventStoreRetentionRules(
  catalog: LoadedRetentionCatalog
): Array<{ repoRelativeDir: string; ttlMs: number; entry: RetentionCatalogEntry }> {
  return catalog.entries
    .filter(
      (e) => isEventStorePath(e.path) && e.ttl_days !== undefined && e.action !== 'review_required'
    )
    .map((e) => ({
      repoRelativeDir: e.path,
      ttlMs: (e.ttl_days as number) * RETENTION_DAY_MS,
      entry: e,
    }));
}

/**
 * Immediate subdirectories of each event-store prefix that the catalog covers.
 * The janitor reports the rest, so a newly added event stream cannot quietly
 * inherit forever-retention.
 */
export function coveredEventStoreDirs(catalog: LoadedRetentionCatalog): Set<string> {
  const covered = new Set<string>();
  for (const entry of catalog.entries) {
    if (!isEventStorePath(entry.path)) continue;
    covered.add(entry.path);
  }
  return covered;
}

/** Exact-path catalog entry lookup (repo-relative directory). */
export function retentionEntryForExactPath(
  catalog: LoadedRetentionCatalog,
  repoRelativeDir: string
): RetentionCatalogEntry | null {
  return catalog.entries.find((e) => e.path === repoRelativeDir) ?? null;
}

/**
 * Longest-prefix catalog entry covering a repo-relative file or directory
 * path (exact match or an ancestor directory). Used by the janitor's trash
 * sweep to recover the governing `soft_delete_days` for a trashed file, and
 * by any caller that needs "which retention rule owns this path".
 */
export function retentionEntryForPath(
  catalog: LoadedRetentionCatalog,
  repoRelativePath: string
): RetentionCatalogEntry | null {
  let best: RetentionCatalogEntry | null = null;
  for (const entry of catalog.entries) {
    if (repoRelativePath === entry.path || repoRelativePath.startsWith(entry.path + '/')) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  return best;
}

/**
 * Repo-relative paths declared `review_required` (AL-04): covered for
 * reporting purposes, never deleted, surfaced for a human retention decision.
 * The one explicit, opt-in exception is a nested status rule (its own
 * `action: 'delete'` scoped to its pattern/statuses; see `RetentionStatusRule`).
 */
export function reviewRequiredCatalogPaths(catalog: LoadedRetentionCatalog): string[] {
  return catalog.entries
    .filter((e) => e.action === 'review_required')
    .map((e) => e.path)
    .sort();
}

/**
 * WI-16: every declared `status_rules` entry, flattened with the directory
 * entry that owns it (the janitor needs the owning entry to resolve
 * `soft_delete_days` / `audit` for the same audited expiry path directory-level
 * TTL rules use).
 */
export function catalogStatusRules(
  catalog: LoadedRetentionCatalog
): Array<{ entry: RetentionCatalogEntry; rule: RetentionStatusRule }> {
  const flattened: Array<{ entry: RetentionCatalogEntry; rule: RetentionStatusRule }> = [];
  for (const entry of catalog.entries) {
    for (const rule of entry.status_rules ?? []) {
      flattened.push({ entry, rule });
    }
  }
  return flattened;
}

/**
 * WI-16: compile a `status_rules[].path_pattern` (relative to its owning
 * entry's directory) into a `RegExp` matched against a POSIX relative path.
 * `*` matches any run of characters within one path segment; it never spans
 * `/`. Callers only ever pass patterns that already passed
 * {@link isSafeStatusRulePattern}, so no path-traversal character reaches
 * here.
 */
export function statusRulePatternToRegex(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map((segment) =>
      segment
        .split('*')
        .map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')
    )
    .join('/');
  return new RegExp(`^${source}$`);
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
