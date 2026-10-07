import { describe, expect, it, vi } from 'vitest';

// Hermetic: the real loader reads knowledge/personal/notification-preferences.json
// — on machines that have it, route resolution diverges from the unconfigured
// path these tests assert. Stub to "no route" and a delivery that fails, which
// exercises the same receipt/envelope contract as an unconfigured environment.
// per-test overrides exercise the success and mute paths.
const notifMock = vi.hoisted(() => ({
  route: null as { surface: 'inbox'; target: string } | 'mute' | null,
  delivered: false,
}));
vi.mock('./surface/operator-notifications.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./surface/operator-notifications.js')>();
  return {
    ...actual,
    loadNotificationPreferences: () => ({}),
    resolveOperatorNotificationRoute: () => notifMock.route,
    notifyOperatorSync: () => notifMock.delivered,
  };
});

import {
  acknowledgeOpsAlerts,
  parseOpsAlertLog,
  readOpsAlertLogRecords,
  redeliverUndeliveredOpsAlerts,
  resolveOpsAlertChannelStatus,
  selectOutstandingUndeliveredOpsAlerts,
  sendOpsAlert,
  summarizeOpsAlertLog,
  OPS_ALERT_WEBHOOK_ENV,
} from './ops-alert.js';
import { pathResolver } from './index.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

const ALERT_TEST_LOG = pathResolver.sharedTmp('ops-alert-test/alerts.jsonl');

describe('ops-alert', () => {
  it('records an ops alert to the local jsonl sink', () => {
    safeRmSync(pathResolver.sharedTmp('ops-alert-test'), { recursive: true, force: true });
    const receipt = sendOpsAlert(
      {
        severity: 'warning',
        title: 'Scheduled pipeline failed',
        context: { schedule_id: 'daily-routine' },
        recommendation: 'Inspect the pipeline trace.',
      },
      {
        alertLogPath: ALERT_TEST_LOG,
        now: new Date('2026-07-04T00:00:00.000Z'),
      }
    );

    expect(receipt.webhook_attempted).toBe(false);
    expect(receipt.suppressed).toBe(false);
    const line = String(safeReadFile(ALERT_TEST_LOG, { encoding: 'utf8' }))
      .trim()
      .split('\n')[0]!;
    expect(JSON.parse(line)).toMatchObject({
      severity: 'warning',
      title: 'Scheduled pipeline failed',
      recommendation: 'Inspect the pipeline trace.',
    });
  });

  it('suppresses repeated alerts inside the dedupe window while still recording them', () => {
    safeRmSync(pathResolver.sharedTmp('ops-alert-test'), { recursive: true, force: true });
    const first = sendOpsAlert(
      {
        severity: 'critical',
        title: 'Daemon fatal',
        context: { daemon_id: 'chronos-daemon' },
        recommendation: 'Restart daemon.',
        dedupe_key: 'chronos:fatal:test',
      },
      {
        alertLogPath: ALERT_TEST_LOG,
        now: new Date('2026-07-04T00:00:00.000Z'),
      }
    );
    const second = sendOpsAlert(
      {
        severity: 'critical',
        title: 'Daemon fatal',
        context: { daemon_id: 'chronos-daemon' },
        recommendation: 'Restart daemon.',
        dedupe_key: 'chronos:fatal:test',
      },
      {
        alertLogPath: ALERT_TEST_LOG,
        now: new Date('2026-07-04T00:01:00.000Z'),
        minIntervalMs: 600_000,
      }
    );

    expect(first.suppressed).toBe(false);
    expect(second.suppressed).toBe(true);
    const lines = String(safeReadFile(ALERT_TEST_LOG, { encoding: 'utf8' }))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(3); // two ops_alert records + one retryable undelivered envelope
  });

  it('queues an undelivered ops alert for later redelivery', () => {
    safeRmSync(pathResolver.sharedTmp('ops-alert-test'), { recursive: true, force: true });
    sendOpsAlert(
      {
        severity: 'critical',
        title: 'Scheduler unavailable',
        context: { daemon_id: 'chronos-daemon' },
        recommendation: 'Restart the scheduler.',
        dedupe_key: 'scheduler:undelivered-test',
      },
      {
        alertLogPath: ALERT_TEST_LOG,
        now: new Date('2026-07-04T00:00:00.000Z'),
        webhookUrl: '',
      }
    );

    const payloads: string[] = [];
    const report = redeliverUndeliveredOpsAlerts({
      alertLogPath: ALERT_TEST_LOG,
      now: new Date('2026-07-04T00:01:00.000Z'),
      deliver: (payload) => payloads.push(payload),
    });

    expect(report).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
    expect(JSON.parse(payloads[0]!)).toMatchObject({
      text: '[REDELIVERY] Scheduler unavailable',
      redelivery_of: expect.any(String),
    });
    expect(
      selectOutstandingUndeliveredOpsAlerts(readOpsAlertLogRecords(ALERT_TEST_LOG))
    ).toHaveLength(0);
  });

  it('falls back to the local inbox when no channel is configured, and still queues a retryable envelope on failure', () => {
    safeRmSync(pathResolver.sharedTmp('ops-alert-test'), { recursive: true, force: true });
    // Under vitest notifyOperatorSync is intentionally a no-op (returns false),
    // so the inbox fallback registers as attempted-but-undelivered and leaves
    // the retryable envelope — the same contract the old null-route path had.
    const receipt = sendOpsAlert(
      {
        severity: 'critical',
        title: 'Daemon heartbeat stale',
        context: { daemon_id: 'chronos-daemon' },
        recommendation: 'Restart the unit.',
        dedupe_key: 'chronos:inbox-fallback-test',
      },
      {
        alertLogPath: ALERT_TEST_LOG,
        now: new Date('2026-07-04T00:00:00.000Z'),
        webhookUrl: '',
      }
    );

    expect(receipt.operator_attempted).toBe(true);
    expect(receipt.operator_delivered).toBe(false);
    const outstanding = selectOutstandingUndeliveredOpsAlerts(
      readOpsAlertLogRecords(ALERT_TEST_LOG)
    );
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.raw.reason).toBe('inbox_delivery_failed');
  });

  it('reports delivery and writes no envelope when the inbox fallback succeeds', () => {
    notifMock.delivered = true;
    try {
      safeRmSync(pathResolver.sharedTmp('ops-alert-test'), { recursive: true, force: true });
      const receipt = sendOpsAlert(
        {
          severity: 'critical',
          title: 'Heartbeat stale again',
          context: {},
          recommendation: 'Restart.',
          dedupe_key: 'chronos:inbox-ok-test',
        },
        { alertLogPath: ALERT_TEST_LOG, now: new Date('2026-07-04T00:00:00.000Z') }
      );
      expect(receipt.operator_attempted).toBe(true);
      expect(receipt.operator_delivered).toBe(true);
      expect(
        selectOutstandingUndeliveredOpsAlerts(readOpsAlertLogRecords(ALERT_TEST_LOG))
      ).toHaveLength(0);
    } finally {
      notifMock.delivered = false;
    }
  });

  it('honors an explicit mute over the inbox fallback', () => {
    notifMock.route = 'mute';
    try {
      safeRmSync(pathResolver.sharedTmp('ops-alert-test'), { recursive: true, force: true });
      const receipt = sendOpsAlert(
        {
          severity: 'info',
          title: 'Muted alert',
          context: {},
          recommendation: 'Nothing.',
          dedupe_key: 'mute:test',
        },
        { alertLogPath: ALERT_TEST_LOG, now: new Date('2026-07-04T00:00:00.000Z') }
      );
      expect(receipt.operator_attempted).toBe(false);
      expect(receipt.operator_delivered).toBe(false);
      expect(
        readOpsAlertLogRecords(ALERT_TEST_LOG).filter(
          (record) => record.kind === 'operator_notification_undelivered'
        )
      ).toHaveLength(0);
    } finally {
      notifMock.route = null;
    }
  });

  it('collapses duplicate undelivered envelopes sharing one correlation_id', () => {
    safeRmSync(pathResolver.sharedTmp('ops-alert-test'), { recursive: true, force: true });
    seedTriageLog([
      JSON.stringify({
        ts: '2026-08-01T00:00:00.000Z',
        kind: 'operator_notification_undelivered',
        event: 'ops_alert',
        title: 'X',
        correlation_id: 'corr-1',
        reason: 'delivery_failed:x',
      }),
      JSON.stringify({
        ts: '2026-08-01T00:00:01.000Z',
        kind: 'operator_notification_undelivered',
        event: 'ops_alert',
        title: 'X',
        correlation_id: 'corr-1',
        alert_id: 'corr-1',
        reason: 'inbox_delivery_failed',
      }),
      JSON.stringify({
        ts: '2026-08-01T00:00:02.000Z',
        kind: 'operator_notification_undelivered',
        event: 'ops_alert',
        title: 'Y',
        correlation_id: 'corr-2',
        reason: 'inbox_delivery_failed',
      }),
    ]);
    const outstanding = selectOutstandingUndeliveredOpsAlerts(readOpsAlertLogRecords(TRIAGE_LOG));
    expect(outstanding).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// LC-02a: triage (summary / ack / redeliver) — hermetic, fixture log only.
// ---------------------------------------------------------------------------

const TRIAGE_LOG = pathResolver.sharedTmp('ops-alert-triage-test/alerts.jsonl');

const UNDELIVERED_A = JSON.stringify({
  ts: '2026-08-01T00:00:00.000Z',
  kind: 'operator_notification_undelivered',
  event: 'mission_failed',
  title: 'Mission A blocked',
  correlation_id: 'A',
  reason: 'no_channel_configured',
});
const UNDELIVERED_B = JSON.stringify({
  ts: '2026-08-05T00:00:00.000Z',
  kind: 'operator_notification_undelivered',
  event: 'question',
  title: 'Question B',
  correlation_id: 'B',
  reason: 'no_channel_configured',
});
const EMITTED_ALERT = JSON.stringify({
  id: 'alert-1',
  timestamp: '2026-08-02T00:00:00.000Z',
  suppressed: false,
  severity: 'critical',
  title: 'Daemon dead',
  category: 'scheduler',
  context: {},
  recommendation: 'restart',
});

function seedTriageLog(lines: string[]): void {
  safeRmSync(pathResolver.sharedTmp('ops-alert-triage-test'), { recursive: true, force: true });
  safeWriteFile(TRIAGE_LOG, `${lines.join('\n')}\n`);
}

describe('ops-alert triage (LC-02a)', () => {
  it('summarizes record kinds, undelivered reasons/events, and top categories', () => {
    seedTriageLog([UNDELIVERED_A, UNDELIVERED_B, EMITTED_ALERT, 'not-json{{{']);
    const summary = summarizeOpsAlertLog(readOpsAlertLogRecords(TRIAGE_LOG));

    expect(summary.total_records).toBe(4);
    expect(summary.by_kind.operator_notification_undelivered).toBe(2);
    expect(summary.by_kind.ops_alert).toBe(1);
    expect(summary.by_kind.unknown).toBe(1);
    expect(summary.alerts).toEqual({
      total: 1,
      suppressed: 0,
      by_severity: { critical: 1 },
    });
    expect(summary.undelivered.total).toBe(2);
    expect(summary.undelivered.outstanding).toBe(2);
    expect(summary.undelivered.by_reason).toEqual({ no_channel_configured: 2 });
    expect(summary.undelivered.by_event).toEqual({ mission_failed: 1, question: 1 });
    expect(summary.undelivered.oldest_outstanding).toBe('2026-08-01T00:00:00.000Z');
    expect(summary.undelivered.newest_outstanding).toBe('2026-08-05T00:00:00.000Z');
    expect(summary.top_categories).toEqual([
      { category: 'notification:mission_failed', count: 1 },
      { category: 'notification:question', count: 1 },
      { category: 'scheduler', count: 1 },
    ]);
  });

  it('acknowledgement appends a record (append-only) and removes covered records from outstanding', () => {
    seedTriageLog([UNDELIVERED_A, UNDELIVERED_B]);
    const receipt = acknowledgeOpsAlerts({
      before: '2026-08-03T00:00:00.000Z',
      now: new Date('2026-08-08T00:00:00.000Z'),
      alertLogPath: TRIAGE_LOG,
    });

    expect(receipt.acked_count).toBe(1); // only the 08-01 record is <= before
    const lines = String(safeReadFile(TRIAGE_LOG, { encoding: 'utf8' }))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(3); // originals untouched, one ack appended
    expect(lines[0]).toBe(UNDELIVERED_A);
    expect(lines[1]).toBe(UNDELIVERED_B);
    expect(JSON.parse(lines[2]!)).toMatchObject({ kind: 'ops_alert_ack', acked_count: 1 });

    const summary = summarizeOpsAlertLog(readOpsAlertLogRecords(TRIAGE_LOG));
    expect(summary.undelivered.outstanding).toBe(1);
    expect(summary.undelivered.acknowledged).toBe(1);
    expect(summary.undelivered.oldest_outstanding).toBe('2026-08-05T00:00:00.000Z');
  });

  it('rejects an acknowledgement cutoff in the future', () => {
    seedTriageLog([UNDELIVERED_A]);
    expect(() =>
      acknowledgeOpsAlerts({
        before: '2026-08-09T00:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        alertLogPath: TRIAGE_LOG,
      })
    ).toThrow(/must not be in the future/);
  });

  it('redelivery sends outstanding records via the injected channel and appends receipts', () => {
    seedTriageLog([UNDELIVERED_A, UNDELIVERED_B]);
    const payloads: string[] = [];
    const report = redeliverUndeliveredOpsAlerts({
      alertLogPath: TRIAGE_LOG,
      now: new Date('2026-08-08T00:00:00.000Z'),
      deliver: (payload) => {
        if (payload.includes('Question B')) throw new Error('boom');
        payloads.push(payload);
      },
    });

    expect(report.attempted).toBe(2);
    expect(report.delivered).toBe(1);
    expect(report.failed).toBe(1);
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(payloads[0]!)).toMatchObject({ text: '[REDELIVERY] Mission A blocked' });

    const lines = String(safeReadFile(TRIAGE_LOG, { encoding: 'utf8' }))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(4); // 2 originals + 2 redelivery receipts
    const receipts = lines.slice(2).map((line) => JSON.parse(line));
    expect(receipts[0]).toMatchObject({ kind: 'ops_alert_redelivery', delivered: true });
    expect(receipts[1]).toMatchObject({ kind: 'ops_alert_redelivery', delivered: false });

    // The successfully redelivered record leaves outstanding; the failed one stays.
    const outstanding = selectOutstandingUndeliveredOpsAlerts(readOpsAlertLogRecords(TRIAGE_LOG));
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.raw.title).toBe('Question B');
  });

  it('redelivery without any channel throws and names the env var', () => {
    seedTriageLog([UNDELIVERED_A]);
    expect(() =>
      redeliverUndeliveredOpsAlerts({ alertLogPath: TRIAGE_LOG, webhookUrl: '' })
    ).toThrowError(new RegExp(OPS_ALERT_WEBHOOK_ENV));
  });

  it('identical duplicate lines share a fingerprint ref, so one redelivery covers both', () => {
    seedTriageLog([UNDELIVERED_A, UNDELIVERED_A]);
    const records = readOpsAlertLogRecords(TRIAGE_LOG);
    const undelivered = records.filter((r) => r.kind === 'operator_notification_undelivered');
    expect(undelivered[0]!.ref).toBe(undelivered[1]!.ref);

    redeliverUndeliveredOpsAlerts({
      alertLogPath: TRIAGE_LOG,
      now: new Date('2026-08-08T00:00:00.000Z'),
      deliver: () => {},
    });
    const outstanding = selectOutstandingUndeliveredOpsAlerts(readOpsAlertLogRecords(TRIAGE_LOG));
    expect(outstanding).toHaveLength(0);
  });

  it('parseOpsAlertLog tolerates blank and unparsable lines without throwing', () => {
    const records = parseOpsAlertLog(`\n${UNDELIVERED_A}\n\nnot-json\n`);
    expect(records).toHaveLength(2);
    expect(records[1]!.kind).toBe('unknown');
  });

  it('resolveOpsAlertChannelStatus reports webhook/operator routes and the env var to set', () => {
    expect(resolveOpsAlertChannelStatus({ webhookUrl: '' })).toMatchObject({
      configured: false,
      webhook_configured: false,
      operator_route_configured: false,
      env_var: OPS_ALERT_WEBHOOK_ENV,
    });
    expect(
      resolveOpsAlertChannelStatus({ webhookUrl: 'https://example.com/hook' }).configured
    ).toBe(true);
    expect(
      resolveOpsAlertChannelStatus({ webhookUrl: '', operatorRouteConfigured: true }).configured
    ).toBe(true);
  });

  it('treats schema-invalid persisted records as unknown and non-actionable', () => {
    seedTriageLog([
      JSON.stringify({
        id: 'bad-alert',
        timestamp: '2026-08-01T00:00:00.000Z',
        suppressed: false,
        severity: 'critical',
        title: 'Invalid alert',
        context: [],
        recommendation: 'not valid',
      }),
    ]);
    const records = readOpsAlertLogRecords(TRIAGE_LOG);
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe('unknown');
    expect(summarizeOpsAlertLog(records).alerts.total).toBe(0);
  });

  it('rejects a log path that is a directory before reading or writing', () => {
    const directoryPath = pathResolver.sharedTmp('ops-alert-triage-test/directory.jsonl');
    safeRmSync(directoryPath, { recursive: true, force: true });
    safeMkdir(directoryPath, { recursive: true });
    expect(() => readOpsAlertLogRecords(directoryPath)).toThrow(/regular file/);
    expect(() =>
      sendOpsAlert(
        {
          severity: 'warning',
          title: 'Directory target',
          context: {},
          recommendation: 'stop',
        },
        { alertLogPath: directoryPath, now: new Date('2026-08-08T00:00:00.000Z') }
      )
    ).toThrow(/regular file/);
    safeRmSync(directoryPath, { recursive: true, force: true });
  });
});
