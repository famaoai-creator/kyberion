/**
 * DA-03 ingest:sync_source — incremental change-listing for one tenant ×
 * source system. Reads the persisted watermark (ingest-sync-cursors), calls
 * the source's read preset through executeServicePreset, and returns the
 * differential WORK LIST — it never downloads bodies and never commits;
 * body fetch → parse → normalize → commit are wired downstream in the
 * pipeline so the op stays composable (LE layer rule: state-driven paging
 * loops live here in the typed op, the pipeline is declarative wiring).
 *
 * Watermark semantics (fail-closed, at-least-once):
 *   - The cursor advances ONLY after the whole differential listing
 *     completed. Any thrown mid-fetch error calls recordSyncFailure (cursor
 *     unchanged, consecutive_failures + 1) and re-throws.
 *   - A run truncated by max_items does NOT advance either: the next run
 *     re-lists the same window and the downstream dedup registry absorbs the
 *     re-delivered items. Raise max_items for very large sources.
 *
 * Retry/backoff placement: the ENGINE layer already retries every transport
 * call — service-engine-execution.ts wraps each preset alternative in
 * retry(fn, buildRetryOptions(...)), driven by the preset's recovery_policy
 * (box/confluence declare maxRetries 3, 500ms→10s exponential backoff with
 * jitter over network/rate_limit/timeout/resource_unavailable; presets
 * without a policy get the same category defaults). This op deliberately
 * does NOT add a second retry loop — duplicating it would multiply attempts
 * (3×3) and stack backoffs. The op's own failure duty is watermark
 * bookkeeping (recordSyncFailure), not transport recovery.
 *
 * Per-source cursor mapping:
 *   - box: get_folder_items with usemarker=true; the marker is an INTRA-RUN
 *     pagination token only (it positions inside one listing snapshot, it is
 *     not a durable change token). Durable watermark: cursor_kind
 *     'updated_since', cursor_value = max modified_at seen in the last
 *     completed listing; each fresh listing filters client-side on
 *     modified_at > watermark. Entries without modified_at are always
 *     included (fail-closed: over-deliver, never drop).
 *   - slack: conversations_history with oldest = cursor_value (server-side
 *     incremental; Slack's oldest is exclusive) and intra-run cursor
 *     pagination via response_metadata.next_cursor. Watermark: cursor_kind
 *     'updated_since', cursor_value = max message ts seen.
 *   - confluence: get_pages with the v2 cursor param — like box's marker,
 *     an intra-run pagination token (extracted from _links.next). Durable
 *     watermark: cursor_kind 'updated_since', cursor_value = max
 *     version.createdAt seen; client-side filter on version.createdAt >
 *     watermark.
 */

import {
  advanceSyncCursor,
  readSyncCursor,
  recordSyncFailure,
  type SyncCursorKind,
} from '@agent/core/ingest-sync-cursors';
import { executeServicePreset } from '@agent/core/service-engine';
import { logger } from '@agent/core/core';

export type SyncSourceSystem = 'box' | 'slack' | 'confluence';

/** Transport seam: hermetic tests inject a mock; default is executeServicePreset. */
export type SyncSourceTransport = (
  serviceId: string,
  action: string,
  params: Record<string, unknown>,
  auth: 'none' | 'secret-guard'
) => Promise<unknown>;

export interface SyncSourceInput {
  tenant_slug: string;
  source_system: SyncSourceSystem;
  /** Source addressing: box → { folder_id }, slack → { channel }, confluence → { domain? }. */
  source_params: Record<string, unknown>;
  auth?: 'none' | 'secret-guard';
  /** Work-list cap per run; hitting it truncates WITHOUT advancing the watermark. Default 500. */
  max_items?: number;
  /** Per-request page size. Default 100. */
  page_limit?: number;
  /** List only — no cursor writes at all (neither advance nor failure record). */
  dry_run?: boolean;
  /** Timestamp override for deterministic tests. */
  now?: string;
  /** Path seam: overrides the ingest-cursors base directory (hermetic tests). */
  cursor_path_seam?: string;
  transport?: SyncSourceTransport;
}

/** One changed item in the differential work list. */
export interface SyncSourceItem {
  source_id: string;
  source_version?: string;
  /** Downstream fetch reference, e.g. 'box:file:123', 'slack:C123:1720000000.000100', 'confluence:page:99'. */
  content_ref: string;
  modified_at?: string;
}

export interface SyncSourceResult {
  tenant_slug: string;
  source_system: SyncSourceSystem;
  items: SyncSourceItem[];
  new_cursor: { cursor_kind: SyncCursorKind; cursor_value: string };
  /** True when the watermark was persisted (full success, not dry_run). */
  advanced: boolean;
  /** True when max_items cut the listing short (watermark NOT advanced). */
  truncated: boolean;
  pages_fetched: number;
  dry_run: boolean;
}

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_PAGE_LIMIT = 100;
/** Hard cap on pagination requests per run (fail-closed against cursor loops). */
const MAX_PAGES = 1000;

interface PageWalkResult {
  items: SyncSourceItem[];
  /** New durable watermark value; '' keeps the previous value. */
  highWater: string;
  truncated: boolean;
  pages: number;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ingest:sync_source — ${what} is not an object (fail-closed)`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`ingest:sync_source — ${what} is not an array (fail-closed)`);
  }
  return value;
}

function requireStringParam(params: Record<string, unknown>, key: string, source: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ingest:sync_source — source_params.${key} is required for ${source}`);
  }
  return value;
}

function isNewerIso(candidate: string, watermark: string): boolean {
  if (!watermark) return true;
  const candidateMs = Date.parse(candidate);
  const watermarkMs = Date.parse(watermark);
  // Unparseable timestamps are treated as newer (fail-closed: include).
  if (Number.isNaN(candidateMs) || Number.isNaN(watermarkMs)) return true;
  return candidateMs > watermarkMs;
}

function maxIso(current: string, candidate: string | undefined): string {
  if (!candidate) return current;
  if (!current) return candidate;
  return isNewerIso(candidate, current) ? candidate : current;
}

async function walkBox(
  input: SyncSourceInput,
  transport: SyncSourceTransport,
  auth: 'none' | 'secret-guard',
  watermark: string,
  maxItems: number,
  pageLimit: number
): Promise<PageWalkResult> {
  const folderId = requireStringParam(input.source_params, 'folder_id', 'box');
  const items: SyncSourceItem[] = [];
  let highWater = '';
  let marker = '';
  let pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) {
      throw new Error(`ingest:sync_source — box pagination exceeded ${MAX_PAGES} pages`);
    }
    const page = asRecord(
      await transport(
        'box',
        'get_folder_items',
        {
          folder_id: folderId,
          query: {
            usemarker: true,
            limit: pageLimit,
            fields: 'id,type,name,etag,sha1,modified_at',
            ...(marker ? { marker } : {}),
          },
        },
        auth
      ),
      'box get_folder_items response'
    );
    pages += 1;
    const entries = asArray(page.entries, 'box get_folder_items entries');
    for (const raw of entries) {
      const entry = asRecord(raw, 'box folder entry');
      if (entry.type !== 'file') continue; // folder recursion is a separate job, not this op's scope
      const modifiedAt = typeof entry.modified_at === 'string' ? entry.modified_at : undefined;
      if (modifiedAt && !isNewerIso(modifiedAt, watermark)) continue;
      const id = String(entry.id ?? '');
      items.push({
        source_id: id,
        ...(typeof entry.etag === 'string'
          ? { source_version: entry.etag }
          : typeof entry.sha1 === 'string'
            ? { source_version: entry.sha1 }
            : {}),
        content_ref: `box:file:${id}`,
        ...(modifiedAt ? { modified_at: modifiedAt } : {}),
      });
      highWater = maxIso(highWater, modifiedAt);
      if (items.length >= maxItems) {
        return { items, highWater, truncated: true, pages };
      }
    }
    const nextMarker = typeof page.next_marker === 'string' ? page.next_marker : '';
    if (!nextMarker) return { items, highWater, truncated: false, pages };
    if (nextMarker === marker) {
      throw new Error('ingest:sync_source — box pagination did not progress (fail-closed)');
    }
    marker = nextMarker;
  }
}

function slackTsToIso(ts: string): string | undefined {
  const seconds = Number.parseFloat(ts);
  if (Number.isNaN(seconds)) return undefined;
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

async function walkSlack(
  input: SyncSourceInput,
  transport: SyncSourceTransport,
  auth: 'none' | 'secret-guard',
  watermark: string,
  maxItems: number,
  pageLimit: number
): Promise<PageWalkResult> {
  const channel = requireStringParam(input.source_params, 'channel', 'slack');
  const items: SyncSourceItem[] = [];
  let highWaterTs = '';
  let cursor = '';
  let pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) {
      throw new Error(`ingest:sync_source — slack pagination exceeded ${MAX_PAGES} pages`);
    }
    const page = asRecord(
      await transport(
        'slack',
        'conversations_history',
        {
          query: {
            channel,
            limit: pageLimit,
            ...(watermark ? { oldest: watermark } : {}),
            ...(cursor ? { cursor } : {}),
          },
        },
        auth
      ),
      'slack conversations_history response'
    );
    pages += 1;
    if (page.ok === false) {
      // Slack answers HTTP 200 with ok:false — surface it as a real failure.
      throw new Error(
        `ingest:sync_source — slack conversations_history returned ok:false (${String(page.error ?? 'unknown error')})`
      );
    }
    const messages = asArray(page.messages, 'slack conversations_history messages');
    for (const raw of messages) {
      const message = asRecord(raw, 'slack message');
      const ts = String(message.ts ?? '');
      if (!ts) continue;
      const iso = slackTsToIso(ts);
      items.push({
        source_id: `${channel}:${ts}`,
        source_version: ts,
        content_ref: `slack:${channel}:${ts}`,
        ...(iso ? { modified_at: iso } : {}),
      });
      if (!highWaterTs || Number.parseFloat(ts) > Number.parseFloat(highWaterTs)) {
        highWaterTs = ts;
      }
      if (items.length >= maxItems) {
        return { items, highWater: highWaterTs, truncated: true, pages };
      }
    }
    const meta =
      page.response_metadata && typeof page.response_metadata === 'object'
        ? (page.response_metadata as Record<string, unknown>)
        : {};
    const nextCursor = typeof meta.next_cursor === 'string' ? meta.next_cursor : '';
    if (!nextCursor) return { items, highWater: highWaterTs, truncated: false, pages };
    if (nextCursor === cursor) {
      throw new Error('ingest:sync_source — slack pagination did not progress (fail-closed)');
    }
    cursor = nextCursor;
  }
}

/** Extracts the `cursor` query value from a Confluence v2 _links.next URL. */
export function extractConfluenceCursor(nextLink: unknown): string {
  if (typeof nextLink !== 'string' || nextLink.trim() === '') return '';
  const match = /[?&]cursor=([^&]+)/.exec(nextLink);
  return match ? decodeURIComponent(match[1]) : '';
}

async function walkConfluence(
  input: SyncSourceInput,
  transport: SyncSourceTransport,
  auth: 'none' | 'secret-guard',
  watermark: string,
  maxItems: number,
  pageLimit: number
): Promise<PageWalkResult> {
  const domain =
    typeof input.source_params.domain === 'string' ? input.source_params.domain : undefined;
  const items: SyncSourceItem[] = [];
  let highWater = '';
  let cursor = '';
  let pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) {
      throw new Error(`ingest:sync_source — confluence pagination exceeded ${MAX_PAGES} pages`);
    }
    const page = asRecord(
      await transport(
        'confluence',
        'get_pages',
        {
          ...(domain ? { domain } : {}),
          query: { limit: pageLimit, ...(cursor ? { cursor } : {}) },
        },
        auth
      ),
      'confluence get_pages response'
    );
    pages += 1;
    const results = asArray(page.results, 'confluence get_pages results');
    for (const raw of results) {
      const entry = asRecord(raw, 'confluence page entry');
      const version =
        entry.version && typeof entry.version === 'object'
          ? (entry.version as Record<string, unknown>)
          : {};
      const modifiedAt = typeof version.createdAt === 'string' ? version.createdAt : undefined;
      if (modifiedAt && !isNewerIso(modifiedAt, watermark)) continue;
      const id = String(entry.id ?? '');
      items.push({
        source_id: id,
        ...(version.number !== undefined ? { source_version: String(version.number) } : {}),
        content_ref: `confluence:page:${id}`,
        ...(modifiedAt ? { modified_at: modifiedAt } : {}),
      });
      highWater = maxIso(highWater, modifiedAt);
      if (items.length >= maxItems) {
        return { items, highWater, truncated: true, pages };
      }
    }
    const links =
      page._links && typeof page._links === 'object'
        ? (page._links as Record<string, unknown>)
        : {};
    const nextCursor = extractConfluenceCursor(links.next);
    if (!nextCursor) return { items, highWater, truncated: false, pages };
    if (nextCursor === cursor) {
      throw new Error('ingest:sync_source — confluence pagination did not progress (fail-closed)');
    }
    cursor = nextCursor;
  }
}

const WALKERS: Record<
  SyncSourceSystem,
  (
    input: SyncSourceInput,
    transport: SyncSourceTransport,
    auth: 'none' | 'secret-guard',
    watermark: string,
    maxItems: number,
    pageLimit: number
  ) => Promise<PageWalkResult>
> = {
  box: walkBox,
  slack: walkSlack,
  confluence: walkConfluence,
};

export async function syncSource(input: SyncSourceInput): Promise<SyncSourceResult> {
  const tenantSlug = String(input?.tenant_slug ?? '').trim();
  const sourceSystem = input?.source_system;
  if (!tenantSlug) throw new Error('ingest:sync_source — tenant_slug is required');
  if (!sourceSystem || !(sourceSystem in WALKERS)) {
    throw new Error(
      `ingest:sync_source — source_system must be one of ${Object.keys(WALKERS).join('|')}; got '${String(sourceSystem)}'`
    );
  }
  if (!input.source_params || typeof input.source_params !== 'object') {
    throw new Error('ingest:sync_source — source_params is required');
  }

  const transport = input.transport ?? (executeServicePreset as SyncSourceTransport);
  const auth = input.auth ?? 'secret-guard';
  const maxItems = input.max_items && input.max_items > 0 ? input.max_items : DEFAULT_MAX_ITEMS;
  const pageLimit =
    input.page_limit && input.page_limit > 0 ? input.page_limit : DEFAULT_PAGE_LIMIT;
  const dryRun = input.dry_run === true;
  const cursorOptions = input.cursor_path_seam ? { cursorsDir: input.cursor_path_seam } : {};

  // Corrupt cursor state throws here (fail-closed) BEFORE any transport call.
  const state = readSyncCursor(tenantSlug, sourceSystem, cursorOptions);
  const watermark =
    state && state.cursor_kind === 'updated_since' && typeof state.cursor_value === 'string'
      ? state.cursor_value
      : '';

  let walk: PageWalkResult;
  try {
    walk = await WALKERS[sourceSystem](input, transport, auth, watermark, maxItems, pageLimit);
  } catch (error) {
    if (!dryRun) {
      recordSyncFailure(
        tenantSlug,
        sourceSystem,
        { cursor_kind: 'updated_since', ...(input.now ? { now: input.now } : {}) },
        cursorOptions
      );
    }
    throw error;
  }

  const newCursorValue = walk.highWater || watermark;
  let advanced = false;
  if (!dryRun && !walk.truncated) {
    advanceSyncCursor(
      tenantSlug,
      sourceSystem,
      {
        cursor_kind: 'updated_since',
        cursor_value: newCursorValue,
        ...(input.now ? { now: input.now } : {}),
      },
      cursorOptions
    );
    advanced = true;
  }
  if (walk.truncated) {
    logger.warn(
      `[INGEST:SYNC] ${tenantSlug}/${sourceSystem}: listing truncated at max_items=${maxItems} — ` +
        'watermark NOT advanced (at-least-once); raise max_items to complete the window'
    );
  }

  return {
    tenant_slug: tenantSlug,
    source_system: sourceSystem,
    items: walk.items,
    new_cursor: { cursor_kind: 'updated_since', cursor_value: newCursorValue },
    advanced,
    truncated: walk.truncated,
    pages_fetched: walk.pages,
    dry_run: dryRun,
  };
}
