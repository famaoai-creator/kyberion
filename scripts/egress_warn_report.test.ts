import { describe, expect, it } from 'vitest';
import { summarizeEgressRecords } from './egress_warn_report.js';

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
});
