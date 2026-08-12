// DA-03 watermark store: write-after-success-only advance, failure recording
// without cursor movement (at-least-once), fail-closed corrupt-state handling.
// Hermetic: the cursors base dir is overridden to a fixture under
// active/shared/tmp via the cursorsDir path seam.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './index.js';
import {
  advanceSyncCursor,
  readSyncCursor,
  recordSyncFailure,
  resetSyncCursor,
  syncCursorPath,
} from './ingest-sync-cursors.js';

const TENANT = 'acme-corp';
const NOW_1 = '2026-07-28T00:00:00.000Z';
const NOW_2 = '2026-07-29T00:00:00.000Z';
const NOW_3 = '2026-07-30T00:00:00.000Z';

describe('ingest-sync-cursors (DA-03 watermark store)', () => {
  let cursorsDir = '';

  beforeAll(() => {
    cursorsDir = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `ingest-cursors-da03-${randomUUID()}`
    );
    safeMkdir(cursorsDir, { recursive: true });
  });

  afterAll(() => {
    if (cursorsDir) safeRmSync(cursorsDir, { recursive: true, force: true });
  });

  it('returns null before the first sync', () => {
    expect(readSyncCursor(TENANT, 'box', { cursorsDir })).toBeNull();
  });

  it('resolves the documented per-tenant per-source path shape', () => {
    const file = syncCursorPath(TENANT, 'box', { cursorsDir });
    expect(file).toBe(path.join(cursorsDir, TENANT, 'box.json'));
  });

  it('rejects path-traversal-shaped tenant slugs and source systems', () => {
    expect(() => syncCursorPath('../evil', 'box', { cursorsDir })).toThrow(/invalid tenant slug/);
    expect(() => syncCursorPath(TENANT, '../box', { cursorsDir })).toThrow(/invalid source_system/);
  });

  it('advanceSyncCursor persists the watermark with last_success_at = now and zero failures', () => {
    const state = advanceSyncCursor(
      TENANT,
      'box',
      { cursor_kind: 'updated_since', cursor_value: '2026-07-01T00:00:00.000Z', now: NOW_1 },
      { cursorsDir }
    );
    expect(state).toEqual({
      tenant_slug: TENANT,
      source_system: 'box',
      cursor_kind: 'updated_since',
      cursor_value: '2026-07-01T00:00:00.000Z',
      last_synced_at: NOW_1,
      last_success_at: NOW_1,
      consecutive_failures: 0,
    });
    expect(readSyncCursor(TENANT, 'box', { cursorsDir })).toEqual(state);
  });

  it('recordSyncFailure increments consecutive_failures WITHOUT moving the cursor (at-least-once)', () => {
    const failed = recordSyncFailure(TENANT, 'box', { now: NOW_2 }, { cursorsDir });
    expect(failed.cursor_value).toBe('2026-07-01T00:00:00.000Z');
    expect(failed.last_success_at).toBe(NOW_1);
    expect(failed.last_synced_at).toBe(NOW_2);
    expect(failed.consecutive_failures).toBe(1);

    const failedAgain = recordSyncFailure(TENANT, 'box', { now: NOW_3 }, { cursorsDir });
    expect(failedAgain.consecutive_failures).toBe(2);
    expect(failedAgain.cursor_value).toBe('2026-07-01T00:00:00.000Z');
  });

  it('a success after failures resets consecutive_failures and advances the watermark', () => {
    const state = advanceSyncCursor(
      TENANT,
      'box',
      { cursor_kind: 'updated_since', cursor_value: '2026-07-15T00:00:00.000Z', now: NOW_3 },
      { cursorsDir }
    );
    expect(state.consecutive_failures).toBe(0);
    expect(state.cursor_value).toBe('2026-07-15T00:00:00.000Z');
    expect(state.last_success_at).toBe(NOW_3);
  });

  it('recordSyncFailure on a never-synced source creates a first-failure state with an empty cursor', () => {
    const state = recordSyncFailure(
      TENANT,
      'slack',
      { cursor_kind: 'updated_since', now: NOW_1 },
      { cursorsDir }
    );
    expect(state).toEqual({
      tenant_slug: TENANT,
      source_system: 'slack',
      cursor_kind: 'updated_since',
      cursor_value: '',
      last_synced_at: NOW_1,
      last_success_at: '',
      consecutive_failures: 1,
    });
  });

  it('supports etag_map cursors (string map values)', () => {
    const state = advanceSyncCursor(
      TENANT,
      'sharepoint',
      { cursor_kind: 'etag_map', cursor_value: { 'doc-1': 'etag-a' }, now: NOW_1 },
      { cursorsDir }
    );
    expect(readSyncCursor(TENANT, 'sharepoint', { cursorsDir })).toEqual(state);
  });

  it('fails closed on a corrupt state file instead of pretending there is no cursor', () => {
    const file = syncCursorPath(TENANT, 'confluence', { cursorsDir });
    safeMkdir(path.dirname(file), { recursive: true });
    safeWriteFile(file, '{ not json');
    expect(() => readSyncCursor(TENANT, 'confluence', { cursorsDir })).toThrow(
      /not valid JSON.*resetSyncCursor/s
    );
  });

  // An unreadable cursor is not a corrupt cursor. Reporting it as corrupt JSON
  // also prescribed resetSyncCursor, which would discard an intact watermark and
  // force a full re-fetch to "fix" an access problem it cannot fix.
  it('reports an unreadable state file as a read failure and does not advise a reset', () => {
    // A source system no other test touches: 'box' already holds a valid cursor
    // by this point, and safeMkdir would skip an existing path.
    const file = syncCursorPath(TENANT, 'onedrive', { cursorsDir });
    safeMkdir(file, { recursive: true });
    expect(safeExistsSync(file)).toBe(true);
    let message = '';
    try {
      readSyncCursor(TENANT, 'onedrive', { cursorsDir });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/could not be read/);
    expect(message).not.toMatch(/not valid JSON/);
    expect(message).not.toMatch(/resetSyncCursor/);
    expect(message).toMatch(/watermark is intact/);
  });

  it('fails closed on a shape-invalid state file', () => {
    const file = syncCursorPath(TENANT, 'jira', { cursorsDir });
    safeMkdir(path.dirname(file), { recursive: true });
    safeWriteFile(file, JSON.stringify({ tenant_slug: TENANT, source_system: 'jira' }));
    expect(() => readSyncCursor(TENANT, 'jira', { cursorsDir })).toThrow(/invalid cursor state/);
  });

  it('resetSyncCursor removes the state file so the next sync is a full re-fetch', () => {
    expect(resetSyncCursor(TENANT, 'confluence', { cursorsDir })).toBe(true);
    expect(safeExistsSync(syncCursorPath(TENANT, 'confluence', { cursorsDir }))).toBe(false);
    expect(resetSyncCursor(TENANT, 'confluence', { cursorsDir })).toBe(false);
    expect(readSyncCursor(TENANT, 'confluence', { cursorsDir })).toBeNull();
  });
});
