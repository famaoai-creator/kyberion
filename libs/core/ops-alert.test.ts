import { describe, expect, it } from 'vitest';
import { sendOpsAlert } from './ops-alert.js';
import { pathResolver } from './index.js';
import { safeReadFile, safeRmSync } from './secure-io.js';

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
    const line = String(safeReadFile(ALERT_TEST_LOG, { encoding: 'utf8' })).trim();
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
    expect(lines).toHaveLength(2);
  });
});
