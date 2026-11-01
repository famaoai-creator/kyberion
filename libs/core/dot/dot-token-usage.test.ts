import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the retention audit out of the shared audit log during tests.
const retentionAudits = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../storage-retention-expiry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage-retention-expiry.js')>();
  return {
    ...actual,
    appendRetentionAudit: (record: Record<string, unknown>) => retentionAudits.push(record),
  };
});

import { safeAppendFileSync, safeReaddir, safeRmSync } from '../secure-io.js';
import { streamJsonLines } from '../jsonl-read.js';
import { resetAppendOnlyStoreMaintenanceState } from '../append-only-store.js';
import type { DotCharter } from './dot-charter.js';
import { dotDailyTokenCapReached, dotTokensUsedToday, recordDotTokenUsage } from './dot-runtime.js';
import {
  DOT_TOKEN_USAGE_PATH,
  DOT_TOKEN_USAGE_RETENTION_MS,
  readDotTokenUsageForDay,
  setDotTokenUsageStoreTuningForTests,
  type DotTokenUsageEntry,
} from './dot-token-usage.js';

const HOUR_MS = 60 * 60 * 1000;
const END = new Date('2026-10-30T18:00:00Z').getTime();

describe('dot-token-usage ledger (MSN-STORE-BOUNDS-2)', () => {
  let rootDir: string;
  let archiveDir: string;

  beforeEach(() => {
    rootDir = path.join('active/shared/tmp', `dot-token-usage-${randomUUID().slice(0, 8)}`);
    archiveDir = path.join(rootDir, 'archive');
    retentionAudits.length = 0;
    resetAppendOnlyStoreMaintenanceState();
  });

  afterEach(() => {
    setDotTokenUsageStoreTuningForTests({});
    resetAppendOnlyStoreMaintenanceState();
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  const ledger = (): string => path.join(rootDir, DOT_TOKEN_USAGE_PATH);

  it('windows the ledger at write time and the daily cap still holds after retention', () => {
    setDotTokenUsageStoreTuningForTests({ minBytes: 2 * 1024, chunkBytes: 61, archiveDir });
    // 6 days of usage, 10 tokens per hour.
    for (let at = END - 6 * 24 * HOUR_MS; at <= END; at += HOUR_MS) {
      recordDotTokenUsage('ops', 10, { rootDir, now: () => new Date(at) });
    }
    expect(retentionAudits.some((a) => a.event === 'RETENTION_WINDOW')).toBe(true);
    expect(safeReaddir(archiveDir).length).toBeGreaterThan(0);

    const live = [...streamJsonLines<DotTokenUsageEntry>(ledger())];
    expect(live.length).toBeLessThan(6 * 24 + 1);
    // Retention only ever drops rows older than the window — every row of the
    // last 3 days (so every row of today) is still live.
    const recent = live.filter(
      (row) => Date.parse(row.recorded_at) >= END - DOT_TOKEN_USAGE_RETENTION_MS
    );
    expect(recent).toHaveLength(3 * 24 + 1);

    // Today (2026-10-30) has 19 hourly rows: 00:00 .. 18:00 UTC.
    const deps = { rootDir, now: () => new Date(END) };
    expect(dotTokensUsedToday('ops', deps)).toBe(190);
    const charter = (cap: number) =>
      ({ dot_id: 'ops', goal: { budget: { token_cap_per_day: cap } } }) as unknown as DotCharter;
    expect(dotDailyTokenCapReached(charter(190), deps)).toBe(true);
    expect(dotDailyTokenCapReached(charter(191), deps)).toBe(false);
  });

  it('reads only the day (margin before midnight) and skips a torn tail', () => {
    for (let at = END - 3 * 24 * HOUR_MS; at <= END; at += 6 * HOUR_MS) {
      recordDotTokenUsage('ops', 1, { rootDir, now: () => new Date(at) });
    }
    safeAppendFileSync(ledger(), '{"dot_id":"ops","day":"2026-10-30","tokens":99');
    const rows = readDotTokenUsageForDay(ledger(), '2026-10-30');
    expect(rows.map((row) => row.recorded_at)).toEqual([
      '2026-10-30T00:00:00.000Z',
      '2026-10-30T06:00:00.000Z',
      '2026-10-30T12:00:00.000Z',
      '2026-10-30T18:00:00.000Z',
    ]);
    expect(dotTokensUsedToday('ops', { rootDir, now: () => new Date(END) })).toBe(4);
    expect(readDotTokenUsageForDay(ledger(), 'not-a-day')).toEqual([]);
  });
});
