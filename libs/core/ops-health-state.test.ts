import { afterAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import {
  appendDaemonStart,
  readBackupDrillReceipt,
  readJanitorFailureMarker,
  recordDaemonStart,
  writeBackupDrillReceipt,
  writeJanitorFailureMarker,
} from './ops-health-state.js';

const TMP = pathResolver.sharedTmp(`ops-health-state-test-${process.pid}`);
const NOW = new Date('2026-11-01T12:00:00.000Z');
const MIN = 60 * 1000;

afterAll(() => safeRmSync(TMP, { recursive: true, force: true }));

describe('appendDaemonStart', () => {
  it('counts restarts in the trailing hour / day and prunes older starts', () => {
    const history = [
      new Date(NOW.getTime() - 30 * 60 * MIN).toISOString(), // 30h ago — pruned
      new Date(NOW.getTime() - 5 * 60 * MIN).toISOString(), // 5h ago
      new Date(NOW.getTime() - 20 * MIN).toISOString(),
      new Date(NOW.getTime() - 10 * MIN).toISOString(),
    ];
    const { starts, summary } = appendDaemonStart(history, NOW);
    expect(starts).toHaveLength(4);
    expect(starts.at(-1)).toBe(NOW.toISOString());
    expect(summary).toEqual({ started_at: NOW.toISOString(), restarts_1h: 2, restarts_24h: 3 });
  });

  it('a first start has no restarts', () => {
    expect(appendDaemonStart([], NOW).summary).toMatchObject({ restarts_1h: 0, restarts_24h: 0 });
  });
});

describe('ops-health state receipts', () => {
  it('persists daemon starts across calls', () => {
    const file = path.join(TMP, 'chronos-daemon-starts.json');
    recordDaemonStart('chronos-daemon', new Date(NOW.getTime() - 2 * MIN), file);
    recordDaemonStart('chronos-daemon', new Date(NOW.getTime() - MIN), file);
    expect(recordDaemonStart('chronos-daemon', NOW, file)).toMatchObject({
      restarts_1h: 2,
      restarts_24h: 2,
    });
  });

  it('round-trips the restore drill receipt through its schema', () => {
    const file = path.join(TMP, 'backup-drill-last.json');
    writeBackupDrillReceipt(
      { completed_at: NOW.toISOString(), archive: null, ok: false, reason: 'no_archive' },
      file
    );
    expect(readBackupDrillReceipt(file)).toEqual({
      completed_at: NOW.toISOString(),
      archive: null,
      ok: false,
      reason: 'no_archive',
    });
    expect(() =>
      writeBackupDrillReceipt({ completed_at: 'x', archive: null, ok: 'yes' } as never, file)
    ).toThrow();
  });

  it('round-trips the janitor failure marker; a missing marker reads as null', () => {
    const file = path.join(TMP, 'janitor-last-failure.json');
    expect(readJanitorFailureMarker(file)).toBeNull();
    writeJanitorFailureMarker(
      { failed_at: NOW.toISOString(), exit_code: 1, log_path: 'active/shared/logs/process/x.log' },
      file
    );
    expect(readJanitorFailureMarker(file)).toMatchObject({ exit_code: 1 });
  });
});
