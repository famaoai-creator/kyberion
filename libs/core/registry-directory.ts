/**
 * Shared directory-first registry loader (RSP-11+).
 *
 * Canonical source is a directory of per-item envelopes:
 * `knowledge/.../<plural>/{id}.json`, where each file carries the same
 * envelope shape as the legacy single-file registry but with exactly one
 * item in its array (same precedent as `voice-profiles/*.json`).
 *
 * An optional `index.json` (`{ version, order: [ids] }`, model-registry
 * precedent) pins the canonical item order. When present, the loader
 * requires the directory set to match the index exactly and returns items
 * in index order; otherwise items are returned sorted by id.
 *
 * Guarantees per load:
 * - every `*.json` item file validates against the registry schema,
 * - the file name matches the item id (`{id}.json`),
 * - no duplicate ids across the directory,
 * - shared header fields (everything except the item array and `$schema`)
 *   are consistent across files.
 *
 * All filesystem access goes through `@agent/core/secure-io`.
 */

import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { readTextFile } from './foundation/text.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from './secure-io.js';

export interface RegistryDirectoryOptions {
  /** Catalog id used for schema-bound loading (e.g. 'capability-bundle-registry'). */
  id: string;
  /** Canonical directory, repo-relative or absolute (e.g. pathResolver.knowledge(...)). */
  dirPath: string;
  /** Schema path for the envelope (the legacy single-file schema is reused). */
  schemaPath: string;
  /** Item array key in the envelope (e.g. 'bundles'). */
  arrayKey: string;
  /** Item id key (e.g. 'bundle_id'). */
  idKey: string;
  /** Env var overriding the directory (e.g. 'KYBERION_CAPABILITY_BUNDLE_REGISTRY_DIR'). */
  envDirVar?: string;
  /** Env var pointing at a legacy single-file registry (hermetic-test seam). */
  envPathVar?: string;
  /** When true, a missing or empty directory loads as zero items instead of throwing. */
  allowEmpty?: boolean;
}

export interface RegistryDirectoryResult<TItem> {
  /** Shared header fields merged from the (consistent) per-file envelopes. */
  headers: Record<string, unknown>;
  /** Items sorted by id. */
  items: TItem[];
  /** Directory the items were loaded from (or single-file path when overridden). */
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerOf(envelope: Record<string, unknown>, arrayKey: string): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === arrayKey || key === '$schema') continue;
    headers[key] = value;
  }
  return headers;
}

/**
 * Resolve the effective directory, honouring the env override when set.
 * Returns `{ singleFile }` when the legacy single-file seam is in use so
 * callers can preserve hermetic-test behaviour.
 */
export function resolveRegistryDirectory(options: RegistryDirectoryOptions): {
  dir: string | null;
  singleFile: string | null;
} {
  if (options.envPathVar) {
    const override = getRegisteredEnvText(options.envPathVar)?.trim();
    if (override) {
      return { dir: null, singleFile: override };
    }
  }
  const dir =
    (options.envDirVar && getRegisteredEnvText(options.envDirVar)?.trim()) || options.dirPath;
  return { dir, singleFile: null };
}

/** Load and validate a single envelope file through the schema boundary. */
export function loadRegistryEnvelope<TEnvelope>(
  options: RegistryDirectoryOptions,
  filePath: string
): TEnvelope {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  return defineCatalog<TEnvelope>({
    id: options.id,
    path: safePath,
    schema: options.schemaPath,
  }).load();
}

/**
 * Load every per-item envelope in the directory and return merged headers
 * plus id-sorted items. Throws when the directory is missing, empty, or
 * inconsistent — there is no single-file fallback (snapshots abolished).
 */
export function loadRegistryDirectory<TItem extends object>(
  options: RegistryDirectoryOptions
): RegistryDirectoryResult<TItem> {
  const { dir, singleFile } = resolveRegistryDirectory(options);
  if (singleFile) {
    const envelope = loadRegistryEnvelope<Record<string, unknown>>(options, singleFile);
    const raw = envelope[options.arrayKey];
    if (!Array.isArray(raw)) {
      throw new Error(`[${options.id}] single-file registry has no array '${options.arrayKey}'`);
    }
    // Preserve file order: single files carry a deliberate order.
    const items = [...(raw as TItem[])];
    return { headers: headerOf(envelope, options.arrayKey), items, source: singleFile };
  }

  const safeDir = assertSafeRepositoryPath(dir as string, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDir)) {
    if (options.allowEmpty) {
      return { headers: {}, items: [], source: safeDir };
    }
    throw new Error(`[${options.id}] registry directory not found: ${dir}`);
  }
  const files = safeReaddir(safeDir)
    .filter((entry) => entry.endsWith('.json') && entry !== 'index.json')
    .sort();
  if (files.length === 0 && !options.allowEmpty) {
    throw new Error(`[${options.id}] registry directory is empty: ${dir}`);
  }

  const items: TItem[] = [];
  const seen = new Set<string>();
  let headers: Record<string, unknown> | null = null;
  for (const file of files) {
    const envelope = loadRegistryEnvelope<Record<string, unknown>>(
      options,
      path.join(safeDir, file)
    );
    const raw = envelope[options.arrayKey];
    if (!Array.isArray(raw) || raw.length !== 1) {
      throw new Error(
        `[${options.id}] registry file ${file} must contain exactly one '${options.arrayKey}' item`
      );
    }
    const item = raw[0] as TItem;
    const record = item as unknown as Record<string, unknown>;
    if (!isRecord(record)) {
      throw new Error(`[${options.id}] registry file ${file} item must be an object`);
    }
    const id = record[options.idKey];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`[${options.id}] registry file ${file} item must define '${options.idKey}'`);
    }
    if (`${id}.json` !== file) {
      throw new Error(`[${options.id}] registry file ${file} must match its id (${id})`);
    }
    if (seen.has(id)) {
      throw new Error(`[${options.id}] duplicate id in registry directory: ${id}`);
    }
    seen.add(id);
    items.push(item);

    const fileHeaders = headerOf(envelope, options.arrayKey);
    if (!headers) {
      headers = fileHeaders;
    } else if (JSON.stringify(headers) !== JSON.stringify(fileHeaders)) {
      throw new Error(`[${options.id}] registry file ${file} has inconsistent shared headers`);
    }
  }

  items.sort((left, right) =>
    String((left as unknown as Record<string, unknown>)[options.idKey]).localeCompare(
      String((right as unknown as Record<string, unknown>)[options.idKey])
    )
  );
  applyDirectoryIndexOrder(options, safeDir, items);
  return { headers: headers ?? {}, items, source: safeDir };
}

/**
 * When `index.json` pins `{ version, order: [ids] }`, require an exact set
 * match with the directory files and reorder items to the canonical order.
 * Otherwise keep id-sorted order.
 */
function applyDirectoryIndexOrder<TItem extends object>(
  options: RegistryDirectoryOptions,
  safeDir: string,
  items: TItem[]
): void {
  const indexPath = path.join(safeDir, 'index.json');
  let safeIndexPath: string;
  try {
    safeIndexPath = assertSafeRepositoryPath(indexPath, { allowMissingLeaf: true });
  } catch {
    return;
  }
  if (!safeExistsSync(safeIndexPath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readTextFile(safeIndexPath));
  } catch (error) {
    throw new Error(`[${options.id}] registry index.json is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['order'])) {
    throw new Error(`[${options.id}] registry index.json must define an order array`);
  }
  const order = (parsed['order'] as unknown[]).map((id) => String(id));
  const itemIds = items.map((item) =>
    String((item as unknown as Record<string, unknown>)[options.idKey])
  );
  if (
    order.length !== itemIds.length ||
    JSON.stringify([...order].sort()) !== JSON.stringify([...itemIds].sort())
  ) {
    throw new Error(`[${options.id}] registry index.json order does not match directory items`);
  }
  const rank = new Map(order.map((id, position) => [id, position] as const));
  items.sort(
    (left, right) =>
      (rank.get(String((left as unknown as Record<string, unknown>)[options.idKey])) as number) -
      (rank.get(String((right as unknown as Record<string, unknown>)[options.idKey])) as number)
  );
}
