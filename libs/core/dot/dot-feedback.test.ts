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

import { appendJsonLine } from '../foundation/json.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
} from '../secure-io.js';
import { streamJsonLines } from '../jsonl-read.js';
import { resetAppendOnlyStoreMaintenanceState } from '../append-only-store.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_FEEDBACK_PATH,
  DOT_FEEDBACK_RETENTION_MS,
  DOT_FEEDBACK_WINDOW_MS,
  DOT_SIGNAL_LEDGER_PATH,
  DOT_SIGNAL_RETENTION_MS,
  latestDotSignals,
  learnedDotDecisionFloor,
  measureDotSuccessSignals,
  readDotFeedback,
  readDotSignals,
  recordDotFeedback,
  setDotFeedbackStoreTuningForTests,
  type DotFeedbackEntry,
  type DotSignalEntry,
} from './dot-feedback.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const END = new Date('2026-10-30T12:00:00Z').getTime();

describe('dot-feedback ledgers (MSN-STORE-BOUNDS-2 write-time retention)', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = path.join('active/shared/tmp', `dot-feedback-${randomUUID().slice(0, 8)}`);
    retentionAudits.length = 0;
    resetAppendOnlyStoreMaintenanceState();
  });

  afterEach(() => {
    setDotFeedbackStoreTuningForTests({});
    resetAppendOnlyStoreMaintenanceState();
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  const feedbackFile = (): string => path.join(rootDir, DOT_FEEDBACK_PATH);

  const record = (at: number, outcome: DotFeedbackEntry['outcome'], n: number): void => {
    recordDotFeedback(
      {
        dot_id: 'ops',
        action_id: `act-${n}`,
        action_ref: `ref-${n}`,
        outcome,
        title: `action ${n} ${'p'.repeat(200)}`,
        ...(outcome === 'approved' ? { decided_by: 'alice', decided_by_type: 'human' } : {}),
      },
      { rootDir, now: () => new Date(at), onRejection: () => {} }
    );
  };

  it('windows dot-feedback at write time, archives the dropped rows, and keeps the 30-day read', () => {
    const archiveDir = path.join(rootDir, 'archive');
    setDotFeedbackStoreTuningForTests({ feedbackMinBytes: 4 * 1024, chunkBytes: 101, archiveDir });
    // 60 days of approvals, one row every 6 hours, then a recent rejection.
    let n = 0;
    for (let at = END - 60 * DAY_MS; at < END - DAY_MS; at += 6 * HOUR_MS) {
      record(at, 'approved', n++);
    }
    record(END - DAY_MS, 'rejected', n++);
    record(END - HOUR_MS, 'approved', n++);

    const live = [...streamJsonLines<DotFeedbackEntry>(feedbackFile())];
    // Rows left the live file only into the archive (learning evidence; the
    // archive is a raw union, so rows may repeat across segments): live ∪
    // archived is every row ever recorded, and each archived row is
    // older than the retention window at the time it was dropped.
    expect(live.length).toBeLessThan(n);
    expect(retentionAudits.some((a) => a.event === 'RETENTION_WINDOW')).toBe(true);
    expect(safeExistsSync(archiveDir)).toBe(true);
    const archived = safeReaddir(archiveDir).flatMap((name) => [
      ...streamJsonLines<DotFeedbackEntry>(path.join(archiveDir, name)),
    ]);
    const liveRefs = new Set(live.map((row) => row.action_ref));
    const dropped = archived.filter((row) => !liveRefs.has(row.action_ref));
    expect(new Set([...archived, ...live].map((row) => row.action_ref)).size).toBe(n);
    const newestDropped = Math.max(...dropped.map((row) => Date.parse(row.recorded_at)));
    expect(newestDropped).toBeLessThan(END - DOT_FEEDBACK_RETENTION_MS);

    const now = () => new Date(END);
    const rows = readDotFeedback('ops', { rootDir, now });
    const expectedInWindow = live.filter(
      (row) => Date.parse(row.recorded_at) >= END - DOT_FEEDBACK_WINDOW_MS
    );
    expect(rows).toEqual(expectedInWindow);
    expect(rows.at(-1)?.action_ref).toBe(`ref-${n - 1}`);
    // Semantic invariant: the learned floor still sees the recent rejection.
    expect(learnedDotDecisionFloor('ops', { rootDir, now })).toBe('approve');
  });

  it('skips a torn tail line and reads only the window', () => {
    record(END - 40 * DAY_MS, 'rejected', 1);
    record(END - 2 * DAY_MS, 'approved', 2);
    safeAppendFileSync(feedbackFile(), '{"dot_id":"ops","action_id":"torn');
    const rows = readDotFeedback('ops', { rootDir, now: () => new Date(END) });
    expect(rows.map((row) => row.action_ref)).toEqual(['ref-2']);
    // The 40-day-old rejection is outside the window: no learned floor.
    expect(learnedDotDecisionFloor('ops', { rootDir, now: () => new Date(END) })).toBeUndefined();
  });

  it('keeps the signal history a KR signal_ratio needs (window, not latest-per-key)', async () => {
    setDotFeedbackStoreTuningForTests({ signalMinBytes: 4 * 1024, chunkBytes: 64 });
    const ledger = path.join(rootDir, DOT_SIGNAL_LEDGER_PATH);
    const charter = {
      dot_id: 'ops',
      goal: {
        signal_probes: [
          {
            signal: 'ci',
            every_s: 60,
            probe: { type: 'file', path: `${rootDir}/absent.txt`, expect: 'exists' },
          },
        ],
      },
    } as unknown as DotCharter;
    safeMkdir(path.dirname(ledger), { recursive: true });
    // 50 days of rows appended directly; one governed append triggers maintenance.
    for (let at = END - 50 * DAY_MS; at < END; at += 12 * HOUR_MS) {
      const ci: DotSignalEntry = {
        dot_id: 'ops',
        signal: 'ci',
        healthy: (at / HOUR_MS) % 24 === 0,
        measured_at: new Date(at).toISOString(),
      };
      appendJsonLine(ledger, ci);
    }
    const deploy: DotSignalEntry = {
      dot_id: 'ops',
      signal: 'deploy',
      healthy: true,
      measured_at: new Date(END - 3 * DAY_MS).toISOString(),
    };
    appendJsonLine(ledger, deploy);

    const measured = await measureDotSuccessSignals(charter, { rootDir, now: () => new Date(END) });
    expect(measured).toHaveLength(1);
    expect(retentionAudits.some((a) => a.event === 'RETENTION_WINDOW')).toBe(true);

    const rows = readDotSignals('ops', { rootDir });
    const oldest = Math.min(...rows.map((row) => Date.parse(row.measured_at)));
    expect(oldest).toBeGreaterThanOrEqual(END - DOT_SIGNAL_RETENTION_MS);
    // Every ci row inside the 30-day KR horizon survived, not only the latest.
    const ciIn30d = rows.filter(
      (row) => row.signal === 'ci' && Date.parse(row.measured_at) >= END - 30 * DAY_MS
    );
    expect(ciIn30d).toHaveLength(61);
    // Latest per (dot_id, signal) is unchanged by retention.
    const withDeploy = {
      dot_id: 'ops',
      goal: { signal_probes: [{ signal: 'ci' }, { signal: 'deploy' }] },
    } as unknown as DotCharter;
    const latest = latestDotSignals(withDeploy, { rootDir });
    expect(latest.find((l) => l.signal === 'deploy')?.latest).toEqual(deploy);
    expect(latest.find((l) => l.signal === 'ci')?.latest?.measured_at).toBe(
      new Date(END).toISOString()
    );
  });
});
