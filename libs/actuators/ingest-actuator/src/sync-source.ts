/**
 * DA-03 ingest:sync_source — incremental change-listing for one or multiple
 * tenant × source systems. Reads the persisted watermark (ingest-sync-cursors),
 * calls the source's read preset through executeServicePreset, and returns the
 * differential WORK LIST.
 */

import {
  advanceSyncCursor,
  readSyncCursor,
  recordSyncFailure,
  type SyncCursorKind,
} from '@agent/core/ingest-sync-cursors';
import { executeServicePreset } from '@agent/core/service-engine';
import {
  getSourceWalker,
  type PageWalkResult,
  type SyncSourceItem,
  type SyncSourceTransport,
} from './sources/index.js';

export type SyncSourceSystem = 'box' | 'slack' | 'confluence' | 'google_drive' | (string & {});

export {
  type SyncSourceItem,
  type SyncSourceTransport,
  extractConfluenceCursor,
  registerSourceWalker,
  listSupportedSources,
} from './sources/index.js';

export interface SyncSourceInput {
  tenant_slug: string;
  source_system?: SyncSourceSystem;
  /** When multi-source sync is desired, pass array of systems to crawl */
  source_systems?: SyncSourceSystem[];
  source_params?: Record<string, unknown>;
  /** Optional per-system parameters for multi-source sync */
  per_source_params?: Record<string, Record<string, unknown>>;
  auth?: 'none' | 'secret-guard';
  max_items?: number;
  page_limit?: number;
  dry_run?: boolean;
  now?: string;
  cursor_path_seam?: string;
  transport?: SyncSourceTransport;
}

export interface SyncSourceResult {
  tenant_slug: string;
  source_system: SyncSourceSystem;
  items: SyncSourceItem[];
  new_cursor: { cursor_kind: SyncCursorKind; cursor_value: string };
  advanced: boolean;
  truncated: boolean;
  pages_fetched: number;
  dry_run: boolean;
}

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_PAGE_LIMIT = 100;

async function syncSingleSource(
  system: SyncSourceSystem,
  input: SyncSourceInput,
  sourceParams: Record<string, unknown>
): Promise<SyncSourceResult> {
  const tenantSlug = String(input.tenant_slug ?? '').trim();
  const walker = getSourceWalker(system);

  const transport = input.transport ?? (executeServicePreset as SyncSourceTransport);
  const auth = input.auth ?? 'secret-guard';
  const maxItems = input.max_items && input.max_items > 0 ? input.max_items : DEFAULT_MAX_ITEMS;
  const pageLimit =
    input.page_limit && input.page_limit > 0 ? input.page_limit : DEFAULT_PAGE_LIMIT;
  const dryRun = input.dry_run === true;
  const cursorOptions = input.cursor_path_seam ? { cursorsDir: input.cursor_path_seam } : {};

  const state = readSyncCursor(tenantSlug, system, cursorOptions);
  const watermark =
    state && state.cursor_kind === 'updated_since' && typeof state.cursor_value === 'string'
      ? state.cursor_value
      : '';

  let walk: PageWalkResult;
  try {
    walk = await walker.walk({
      tenant_slug: tenantSlug,
      source_params: sourceParams,
      transport,
      auth,
      watermark,
      maxItems,
      pageLimit,
    });
  } catch (error) {
    if (!dryRun) {
      recordSyncFailure(
        tenantSlug,
        system,
        { cursor_kind: 'updated_since', ...(input.now ? { now: input.now } : {}) },
        cursorOptions
      );
    }
    throw error;
  }

  let advanced = false;
  if (!dryRun && !walk.truncated) {
    const nextWatermark = walk.highWater || watermark;
    if (nextWatermark) {
      advanceSyncCursor(
        tenantSlug,
        system,
        {
          cursor_kind: 'updated_since',
          cursor_value: nextWatermark,
          ...(input.now ? { now: input.now } : {}),
        },
        cursorOptions
      );
      advanced = true;
    }
  }

  return {
    tenant_slug: tenantSlug,
    source_system: system,
    items: walk.items,
    new_cursor: {
      cursor_kind: 'updated_since',
      cursor_value: walk.highWater || watermark,
    },
    advanced,
    truncated: walk.truncated,
    pages_fetched: walk.pages,
    dry_run: dryRun,
  };
}

export interface MultiSyncSourceResult {
  tenant_slug: string;
  results: SyncSourceResult[];
  items: SyncSourceItem[];
}

export async function syncSource(
  input: SyncSourceInput & { source_systems: SyncSourceSystem[] }
): Promise<MultiSyncSourceResult>;
export async function syncSource(
  input: SyncSourceInput & { source_system: SyncSourceSystem }
): Promise<SyncSourceResult>;
export async function syncSource(
  input: SyncSourceInput
): Promise<SyncSourceResult | MultiSyncSourceResult>;
export async function syncSource(
  input: SyncSourceInput
): Promise<SyncSourceResult | MultiSyncSourceResult> {
  const tenantSlug = String(input?.tenant_slug ?? '').trim();
  if (!tenantSlug) throw new Error('ingest:sync_source — tenant_slug is required');

  // Multi-source sync mode
  if (Array.isArray(input.source_systems) && input.source_systems.length > 0) {
    const results: SyncSourceResult[] = [];
    const aggregatedItems: SyncSourceItem[] = [];

    for (const sys of input.source_systems) {
      const params = input.per_source_params?.[sys] || input.source_params || {};
      const res = await syncSingleSource(sys, input, params);
      results.push(res);
      aggregatedItems.push(...res.items);
    }

    return {
      tenant_slug: tenantSlug,
      results,
      items: aggregatedItems,
    };
  }

  // Single-source sync mode
  const sourceSystem = input?.source_system;
  if (!sourceSystem) {
    throw new Error('ingest:sync_source — source_system or source_systems is required');
  }
  if (!input.source_params || typeof input.source_params !== 'object') {
    throw new Error('ingest:sync_source — source_params is required');
  }

  return syncSingleSource(sourceSystem, input, input.source_params);
}
