import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { buildEgressWarnReport, summarizeEgressRecords } from './egress_warn_report.js';

const egressLoaderTestDir = pathResolver.sharedTmp(`egress-warn-report-${process.pid}`);

afterEach(() => {
  safeRmSync(egressLoaderTestDir, { recursive: true, force: true });
});

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

describe('summarizeEgressRecords (SA-04/SA-05)', () => {
  it('groups warn and deny counts per hostname with seen bounds', () => {
    const hosts = summarizeEgressRecords([
      line({
        action: 'egress_request',
        timestamp: '2026-07-10T00:00:00.000Z',
        result: 'allowed',
        metadata: { hostname: 'api.example.com', verdict: 'warn' },
      }),
      line({
        action: 'egress_request',
        timestamp: '2026-07-11T00:00:00.000Z',
        result: 'allowed',
        metadata: { hostname: 'api.example.com', verdict: 'warn' },
      }),
      line({
        action: 'egress_request',
        timestamp: '2026-07-11T01:00:00.000Z',
        result: 'failed',
        metadata: { hostname: 'evil.example.net' },
      }),
      line({ action: 'meeting.speak', metadata: { hostname: 'ignored.example' } }),
      'not json',
    ]);

    expect(hosts.size).toBe(2);
    const api = hosts.get('api.example.com');
    expect(api).toMatchObject({ warned: 2, denied: 0 });
    expect(api?.first_seen).toBe('2026-07-10T00:00:00.000Z');
    expect(api?.last_seen).toBe('2026-07-11T00:00:00.000Z');
    expect(hosts.get('evil.example.net')).toMatchObject({ warned: 0, denied: 1 });
  });

  it('does not read symlinked audit records', () => {
    const target = `${egressLoaderTestDir}/target.jsonl`;
    const link = `${egressLoaderTestDir}/audit-2026-08-31.jsonl`;
    safeMkdir(egressLoaderTestDir, { recursive: true });
    safeWriteFile(
      target,
      `${line({
        action: 'egress_request',
        timestamp: '2026-08-31T00:00:00.000Z',
        result: 'allowed',
        metadata: { hostname: 'external.example.com', verdict: 'warn' },
      })}\n`
    );
    safeSymlinkSync(target, link);

    const report = buildEgressWarnReport(egressLoaderTestDir);
    expect(report.files_scanned).toBe(0);
    expect(report.hosts).toEqual([]);
  });

  it('skips malformed egress records instead of coercing their fields', () => {
    const hosts = summarizeEgressRecords([
      line({
        action: 'egress_request',
        timestamp: 42,
        result: 'allowed',
        metadata: { hostname: 'x' },
      }),
      line({
        action: 'egress_request',
        timestamp: '2026-08-31',
        result: 'unknown',
        metadata: { hostname: 'x' },
      }),
      line({
        action: 'egress_request',
        timestamp: '2026-08-31',
        result: 'allowed',
        metadata: { hostname: [] },
      }),
      line({
        action: 'egress_request',
        timestamp: '2026-08-31',
        result: 'allowed',
        metadata: { hostname: 'valid.example' },
      }),
    ]);
    expect([...hosts.keys()]).toEqual(['valid.example']);
  });
});
