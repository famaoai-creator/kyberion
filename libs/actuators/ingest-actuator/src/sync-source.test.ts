// DA-03 acceptance:
//  (1) a second sync of the same source fetches ONLY the differential
//      (watermark advance pinned per source: box client-side filter,
//      slack server-side oldest, confluence client-side filter);
//  (2) a mid-fetch failure does NOT advance the watermark and increments
//      consecutive_failures (at-least-once).
// Hermetic: the transport is a mock (no network) and the cursor store is
// redirected to a fixture under active/shared/tmp via cursor_path_seam.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { readSyncCursor } from '@agent/core/ingest-sync-cursors';
import { safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { extractConfluenceCursor, syncSource, type SyncSourceTransport } from './sync-source.js';

const NOW_1 = '2026-07-28T00:00:00.000Z';
const NOW_2 = '2026-07-29T00:00:00.000Z';

describe('ingest:sync_source (DA-03)', () => {
  let cursorsDir = '';

  beforeAll(() => {
    cursorsDir = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `ingest-sync-source-da03-${randomUUID()}`
    );
    safeMkdir(cursorsDir, { recursive: true });
  });

  afterAll(() => {
    if (cursorsDir) safeRmSync(cursorsDir, { recursive: true, force: true });
  });

  describe('box (marker pagination within a run, updated_since watermark across runs)', () => {
    const tenant = 'box-tenant';
    const file = (id: string, modified: string, etag = '1') => ({
      type: 'file',
      id,
      name: `${id}.docx`,
      etag,
      modified_at: modified,
    });

    it('first sync walks all marker pages and advances the watermark to the max modified_at', async () => {
      const transport = vi
        .fn<SyncSourceTransport>()
        .mockResolvedValueOnce({
          entries: [file('f1', '2026-07-01T00:00:00.000Z'), { type: 'folder', id: 'd1' }],
          next_marker: 'm2',
        })
        .mockResolvedValueOnce({
          entries: [file('f2', '2026-07-10T00:00:00.000Z')],
        });

      const result = await syncSource({
        tenant_slug: tenant,
        source_system: 'box',
        source_params: { folder_id: '0' },
        auth: 'none',
        now: NOW_1,
        cursor_path_seam: cursorsDir,
        transport,
      });

      expect(result.items.map((item) => item.source_id)).toEqual(['f1', 'f2']);
      expect(result.items[0]).toEqual({
        source_id: 'f1',
        source_version: '1',
        content_ref: 'box:file:f1',
        modified_at: '2026-07-01T00:00:00.000Z',
      });
      expect(result.advanced).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.pages_fetched).toBe(2);
      expect(result.new_cursor).toEqual({
        cursor_kind: 'updated_since',
        cursor_value: '2026-07-10T00:00:00.000Z',
      });
      // second page was requested with the marker from page 1
      expect(transport.mock.calls[1][2]).toMatchObject({
        folder_id: '0',
        query: expect.objectContaining({ usemarker: true, marker: 'm2' }),
      });
      expect(readSyncCursor(tenant, 'box', { cursorsDir })).toMatchObject({
        cursor_kind: 'updated_since',
        cursor_value: '2026-07-10T00:00:00.000Z',
        last_success_at: NOW_1,
        consecutive_failures: 0,
      });
    });

    it('acceptance (1): the second sync lists ONLY items newer than the watermark', async () => {
      const transport = vi.fn<SyncSourceTransport>().mockResolvedValueOnce({
        entries: [
          file('f1', '2026-07-01T00:00:00.000Z'),
          file('f2', '2026-07-10T00:00:00.000Z'),
          file('f3', '2026-07-20T00:00:00.000Z', '2'),
        ],
      });

      const result = await syncSource({
        tenant_slug: tenant,
        source_system: 'box',
        source_params: { folder_id: '0' },
        auth: 'none',
        now: NOW_2,
        cursor_path_seam: cursorsDir,
        transport,
      });

      expect(result.items).toEqual([
        {
          source_id: 'f3',
          source_version: '2',
          content_ref: 'box:file:f3',
          modified_at: '2026-07-20T00:00:00.000Z',
        },
      ]);
      expect(result.advanced).toBe(true);
      expect(readSyncCursor(tenant, 'box', { cursorsDir })?.cursor_value).toBe(
        '2026-07-20T00:00:00.000Z'
      );
    });

    it('acceptance (2): a mid-page failure leaves the watermark untouched and counts the failure', async () => {
      const transport = vi
        .fn<SyncSourceTransport>()
        .mockResolvedValueOnce({
          entries: [file('f9', '2026-07-25T00:00:00.000Z')],
          next_marker: 'm2',
        })
        .mockRejectedValueOnce(new Error('box transport exploded mid-listing'));

      await expect(
        syncSource({
          tenant_slug: tenant,
          source_system: 'box',
          source_params: { folder_id: '0' },
          auth: 'none',
          now: '2026-07-30T00:00:00.000Z',
          cursor_path_seam: cursorsDir,
          transport,
        })
      ).rejects.toThrow(/exploded mid-listing/);

      const state = readSyncCursor(tenant, 'box', { cursorsDir });
      expect(state?.cursor_value).toBe('2026-07-20T00:00:00.000Z'); // unchanged
      expect(state?.last_success_at).toBe(NOW_2); // unchanged
      expect(state?.consecutive_failures).toBe(1);
      expect(state?.last_synced_at).toBe('2026-07-30T00:00:00.000Z');
    });

    it('a truncated listing (max_items) returns work but does NOT advance the watermark', async () => {
      const transport = vi.fn<SyncSourceTransport>().mockResolvedValueOnce({
        entries: [file('g1', '2026-07-26T00:00:00.000Z'), file('g2', '2026-07-27T00:00:00.000Z')],
        next_marker: 'm2',
      });

      const result = await syncSource({
        tenant_slug: 'box-trunc',
        source_system: 'box',
        source_params: { folder_id: '0' },
        auth: 'none',
        max_items: 2,
        now: NOW_1,
        cursor_path_seam: cursorsDir,
        transport,
      });

      expect(result.items).toHaveLength(2);
      expect(result.truncated).toBe(true);
      expect(result.advanced).toBe(false);
      expect(readSyncCursor('box-trunc', 'box', { cursorsDir })).toBeNull();
    });

    it('fails closed when box pagination does not progress', async () => {
      const transport = vi.fn<SyncSourceTransport>().mockResolvedValue({
        entries: [],
        next_marker: 'same-marker',
      });
      // first response: marker '' -> 'same-marker'; second: 'same-marker' -> 'same-marker'
      await expect(
        syncSource({
          tenant_slug: 'box-loop',
          source_system: 'box',
          source_params: { folder_id: '0' },
          auth: 'none',
          dry_run: true,
          cursor_path_seam: cursorsDir,
          transport,
        })
      ).rejects.toThrow(/pagination did not progress/);
    });
  });

  describe('slack (server-side oldest watermark)', () => {
    const tenant = 'slack-tenant';

    it('first sync pages via next_cursor and advances the watermark to the max message ts', async () => {
      const transport = vi
        .fn<SyncSourceTransport>()
        .mockResolvedValueOnce({
          ok: true,
          messages: [{ ts: '1753600000.000200' }, { ts: '1753500000.000100' }],
          response_metadata: { next_cursor: 'cur-2' },
        })
        .mockResolvedValueOnce({
          ok: true,
          messages: [{ ts: '1753400000.000050' }],
          response_metadata: { next_cursor: '' },
        });

      const result = await syncSource({
        tenant_slug: tenant,
        source_system: 'slack',
        source_params: { channel: 'C123' },
        auth: 'none',
        now: NOW_1,
        cursor_path_seam: cursorsDir,
        transport,
      });

      expect(result.items).toHaveLength(3);
      expect(result.items[0]).toEqual({
        source_id: 'C123:1753600000.000200',
        source_version: '1753600000.000200',
        content_ref: 'slack:C123:1753600000.000200',
        modified_at: new Date(1753600000000).toISOString(),
      });
      // first request has NO oldest (no watermark yet)
      expect(transport.mock.calls[0][2]).toEqual({
        query: { channel: 'C123', limit: 100 },
      });
      // second request resumes with the intra-run cursor
      expect(transport.mock.calls[1][2]).toMatchObject({
        query: expect.objectContaining({ cursor: 'cur-2' }),
      });
      expect(readSyncCursor(tenant, 'slack', { cursorsDir })?.cursor_value).toBe(
        '1753600000.000200'
      );
    });

    it('acceptance (1): the second sync passes the ts watermark as oldest (differential only)', async () => {
      const transport = vi.fn<SyncSourceTransport>().mockResolvedValueOnce({
        ok: true,
        messages: [{ ts: '1753700000.000300' }],
      });

      const result = await syncSource({
        tenant_slug: tenant,
        source_system: 'slack',
        source_params: { channel: 'C123' },
        auth: 'none',
        now: NOW_2,
        cursor_path_seam: cursorsDir,
        transport,
      });

      expect(transport.mock.calls[0][2]).toEqual({
        query: { channel: 'C123', limit: 100, oldest: '1753600000.000200' },
      });
      expect(result.items.map((item) => item.source_version)).toEqual(['1753700000.000300']);
      expect(readSyncCursor(tenant, 'slack', { cursorsDir })?.cursor_value).toBe(
        '1753700000.000300'
      );
    });

    it('acceptance (2): slack ok:false is a failure — watermark untouched, failure counted', async () => {
      const transport = vi
        .fn<SyncSourceTransport>()
        .mockResolvedValueOnce({ ok: false, error: 'ratelimited' });

      await expect(
        syncSource({
          tenant_slug: tenant,
          source_system: 'slack',
          source_params: { channel: 'C123' },
          auth: 'none',
          now: '2026-07-30T00:00:00.000Z',
          cursor_path_seam: cursorsDir,
          transport,
        })
      ).rejects.toThrow(/ok:false \(ratelimited\)/);

      const state = readSyncCursor(tenant, 'slack', { cursorsDir });
      expect(state?.cursor_value).toBe('1753700000.000300');
      expect(state?.consecutive_failures).toBe(1);
    });
  });

  describe('confluence (v2 cursor pagination, updated_since watermark)', () => {
    const tenant = 'conf-tenant';
    const page = (id: string, version: number, createdAt: string) => ({
      id,
      title: `Page ${id}`,
      version: { number: version, createdAt },
    });

    it('first sync follows _links.next cursors and advances to the max version.createdAt', async () => {
      const transport = vi
        .fn<SyncSourceTransport>()
        .mockResolvedValueOnce({
          results: [page('p1', 3, '2026-07-05T00:00:00.000Z')],
          _links: { next: '/wiki/api/v2/pages?cursor=abc%3D%3D&limit=100' },
        })
        .mockResolvedValueOnce({
          results: [page('p2', 1, '2026-07-12T00:00:00.000Z')],
          _links: {},
        });

      const result = await syncSource({
        tenant_slug: tenant,
        source_system: 'confluence',
        source_params: { domain: 'acme' },
        auth: 'none',
        now: NOW_1,
        cursor_path_seam: cursorsDir,
        transport,
      });

      expect(result.items).toEqual([
        {
          source_id: 'p1',
          source_version: '3',
          content_ref: 'confluence:page:p1',
          modified_at: '2026-07-05T00:00:00.000Z',
        },
        {
          source_id: 'p2',
          source_version: '1',
          content_ref: 'confluence:page:p2',
          modified_at: '2026-07-12T00:00:00.000Z',
        },
      ]);
      expect(transport.mock.calls[0][2]).toEqual({ domain: 'acme', query: { limit: 100 } });
      expect(transport.mock.calls[1][2]).toMatchObject({
        query: expect.objectContaining({ cursor: 'abc==' }),
      });
      expect(readSyncCursor(tenant, 'confluence', { cursorsDir })?.cursor_value).toBe(
        '2026-07-12T00:00:00.000Z'
      );
    });

    it('acceptance (1): the second sync filters pages at or below the watermark', async () => {
      const transport = vi.fn<SyncSourceTransport>().mockResolvedValueOnce({
        results: [
          page('p1', 3, '2026-07-05T00:00:00.000Z'),
          page('p2', 1, '2026-07-12T00:00:00.000Z'),
          page('p3', 2, '2026-07-22T00:00:00.000Z'),
        ],
        _links: {},
      });

      const result = await syncSource({
        tenant_slug: tenant,
        source_system: 'confluence',
        source_params: { domain: 'acme' },
        auth: 'none',
        now: NOW_2,
        cursor_path_seam: cursorsDir,
        transport,
      });

      expect(result.items.map((item) => item.source_id)).toEqual(['p3']);
      expect(readSyncCursor(tenant, 'confluence', { cursorsDir })?.cursor_value).toBe(
        '2026-07-22T00:00:00.000Z'
      );
    });
  });

  describe('shared semantics', () => {
    it('dry_run lists the differential but writes NO cursor state (success or failure)', async () => {
      const okTransport = vi
        .fn<SyncSourceTransport>()
        .mockResolvedValue({ entries: [], next_marker: '' });
      const result = await syncSource({
        tenant_slug: 'dry-tenant',
        source_system: 'box',
        source_params: { folder_id: '0' },
        auth: 'none',
        dry_run: true,
        cursor_path_seam: cursorsDir,
        transport: okTransport,
      });
      expect(result.advanced).toBe(false);
      expect(result.dry_run).toBe(true);
      expect(readSyncCursor('dry-tenant', 'box', { cursorsDir })).toBeNull();

      const badTransport = vi.fn<SyncSourceTransport>().mockRejectedValue(new Error('boom'));
      await expect(
        syncSource({
          tenant_slug: 'dry-tenant',
          source_system: 'box',
          source_params: { folder_id: '0' },
          auth: 'none',
          dry_run: true,
          cursor_path_seam: cursorsDir,
          transport: badTransport,
        })
      ).rejects.toThrow(/boom/);
      expect(readSyncCursor('dry-tenant', 'box', { cursorsDir })).toBeNull();
    });

    it('a sync with zero changes still succeeds and keeps the previous cursor value', async () => {
      const seed = vi.fn<SyncSourceTransport>().mockResolvedValueOnce({
        entries: [{ type: 'file', id: 'z1', etag: '1', modified_at: '2026-07-10T00:00:00.000Z' }],
      });
      await syncSource({
        tenant_slug: 'quiet-tenant',
        source_system: 'box',
        source_params: { folder_id: '0' },
        auth: 'none',
        now: NOW_1,
        cursor_path_seam: cursorsDir,
        transport: seed,
      });

      const noChange = vi.fn<SyncSourceTransport>().mockResolvedValueOnce({
        entries: [{ type: 'file', id: 'z1', etag: '1', modified_at: '2026-07-10T00:00:00.000Z' }],
      });
      const result = await syncSource({
        tenant_slug: 'quiet-tenant',
        source_system: 'box',
        source_params: { folder_id: '0' },
        auth: 'none',
        now: NOW_2,
        cursor_path_seam: cursorsDir,
        transport: noChange,
      });
      expect(result.items).toEqual([]);
      expect(result.new_cursor.cursor_value).toBe('2026-07-10T00:00:00.000Z');
      expect(readSyncCursor('quiet-tenant', 'box', { cursorsDir })).toMatchObject({
        cursor_value: '2026-07-10T00:00:00.000Z',
        last_success_at: NOW_2,
      });
    });

    it('rejects unknown source systems and missing addressing params', async () => {
      await expect(
        syncSource({
          tenant_slug: 't',
          source_system: 'jira' as never,
          source_params: {},
          cursor_path_seam: cursorsDir,
        })
      ).rejects.toThrow(/source_system must be one of box\|slack\|confluence/);
      await expect(
        syncSource({
          tenant_slug: 'no-folder',
          source_system: 'box',
          source_params: {},
          auth: 'none',
          dry_run: true,
          cursor_path_seam: cursorsDir,
          transport: vi.fn<SyncSourceTransport>(),
        })
      ).rejects.toThrow(/source_params\.folder_id is required/);
    });
  });

  describe('extractConfluenceCursor', () => {
    it('pulls and decodes the cursor query value from _links.next', () => {
      expect(extractConfluenceCursor('/wiki/api/v2/pages?cursor=abc%3D%3D&limit=25')).toBe('abc==');
      expect(extractConfluenceCursor('/wiki/api/v2/pages?limit=25')).toBe('');
      expect(extractConfluenceCursor(undefined)).toBe('');
    });
  });
});
