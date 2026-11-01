import * as path from 'node:path';
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

import { pathResolver } from '../path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { streamJsonLines } from '../jsonl-read.js';
import { resetAppendOnlyStoreMaintenanceState } from '../append-only-store.js';
import {
  AUTONOMY_OUTCOMES_MIN_RETENTION_MS,
  AUTONOMY_OUTCOMES_PATH,
  AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS,
  actionAutonomyStats,
  listAutonomyActionIds,
  recordAutonomyExecution,
  recordAutonomyOutcome,
  setAutonomyOutcomesStoreTuningForTests,
  sweepAutonomyActionStates,
  type AutonomyOutcomeRow,
} from './autonomy-action-state.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ROOT = pathResolver.sharedTmp('autonomy-action-state-retention-tests');
const LEDGER = path.join(ROOT, AUTONOMY_OUTCOMES_PATH);
const ARCHIVE = path.join(ROOT, 'archive');
const NOW = new Date('2026-11-01T00:00:00.000Z');

function depsAt(at: Date) {
  return { rootDir: ROOT, now: () => at };
}

function seedSuccesses(actionId: string, count: number, at: Date): void {
  for (let i = 0; i < count; i++) {
    const receipt = `${actionId}-${at.getTime()}-${i}`;
    recordAutonomyOutcome(
      { action_id: actionId, decision: 'approve', executed: false, receipt_id: receipt },
      depsAt(at)
    );
    recordAutonomyExecution({ action_id: actionId, receipt_id: receipt, ok: true }, depsAt(at));
  }
}

function liveRows(): Array<Partial<AutonomyOutcomeRow>> {
  return [...streamJsonLines<Partial<AutonomyOutcomeRow>>(LEDGER, { onMalformed: 'skip' })];
}

describe('autonomy-outcomes retention', () => {
  beforeEach(() => {
    safeRmSync(ROOT, { recursive: true, force: true });
    retentionAudits.length = 0;
    resetAppendOnlyStoreMaintenanceState();
  });
  afterEach(() => {
    setAutonomyOutcomesStoreTuningForTests({});
    resetAppendOnlyStoreMaintenanceState();
    safeRmSync(ROOT, { recursive: true, force: true });
  });

  it('windows the ledger at write time without erasing in-window promotion evidence', () => {
    setAutonomyOutcomesStoreTuningForTests({
      minBytes: 2 * 1024,
      chunkBytes: 97,
      archiveDir: ARCHIVE,
    });
    const old = new Date(
      NOW.getTime() -
        AUTONOMY_OUTCOMES_MIN_RETENTION_MS -
        AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS -
        3 * DAY_MS
    );
    // An action only seen long ago, then fresh evidence for another action.
    seedSuccesses('stale_action', 10, old);
    seedSuccesses('daemon_restart', 12, new Date(NOW.getTime() - DAY_MS));

    expect(retentionAudits.some((r) => r.event === 'RETENTION_WINDOW')).toBe(true);
    const live = liveRows();
    expect(live.some((row) => row.action_id === 'stale_action')).toBe(false);
    expect(live.filter((row) => row.action_id === 'daemon_restart')).toHaveLength(24);
    // Dropped rows went to the archive, not nowhere.
    const archived = safeReaddir(ARCHIVE).flatMap((name) => [
      ...streamJsonLines<Partial<AutonomyOutcomeRow>>(path.join(ARCHIVE, name)),
    ]);
    // The archive is a raw union (rows may repeat across segments).
    const staleArchived = new Set(
      archived
        .filter((row) => row.action_id === 'stale_action')
        .map((row) => `${row.kind ?? 'decision'}:${row.receipt_id}`)
    );
    expect(staleArchived.size).toBe(20);

    // Invariant: promotion still sees every in-window row.
    expect(listAutonomyActionIds(depsAt(NOW))).toEqual(['daemon_restart']);
    const stats = actionAutonomyStats('daemon_restart', depsAt(NOW));
    expect(stats).toMatchObject({ decisions: 12, succeeded: 12, incidents: 0 });
    expect(sweepAutonomyActionStates(['daemon_restart'], depsAt(NOW)).promoted).toEqual([
      'daemon_restart→notify',
    ]);
  });

  it('reads only the window over a multi-chunk CRLF ledger and still fails closed on a torn tail', () => {
    setAutonomyOutcomesStoreTuningForTests({ minBytes: 1024 * 1024 * 1024, chunkBytes: 64 });
    const row = (at: number, extra: Partial<AutonomyOutcomeRow> = {}) =>
      JSON.stringify({
        action_id: 'daemon_restart',
        decision: 'approve',
        executed: false,
        recorded_at: new Date(at).toISOString(),
        ...extra,
      });
    safeMkdir(path.dirname(LEDGER), { recursive: true });
    const outside = NOW.getTime() - 40 * DAY_MS;
    const inside = NOW.getTime() - DAY_MS;
    safeWriteFile(
      LEDGER,
      [
        // Out-of-window failure: the backward scan stops before it.
        row(outside, { executed: true, ok: false, receipt_id: 'old' }),
        ...Array.from({ length: 5 }, () => row(inside)),
      ].join('\r\n') + '\r\n'
    );
    expect(actionAutonomyStats('daemon_restart', depsAt(NOW))).toMatchObject({
      decisions: 5,
      incidents: 0,
    });

    // A torn tail is an in-flight append until the next row (written with a
    // leading newline) completes it into a malformed line — then it counts.
    safeAppendFileSync(LEDGER, '{"action_id":"daemon_res');
    expect(actionAutonomyStats('daemon_restart', depsAt(NOW)).decisions).toBe(5);
    safeAppendFileSync(LEDGER, `\n${row(inside)}\n`);
    expect(safeExistsSync(LEDGER)).toBe(true);
    expect(actionAutonomyStats('daemon_restart', depsAt(NOW)).incidents).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });
});
