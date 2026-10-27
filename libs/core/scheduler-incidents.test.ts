import { appendOpsAlertLogRecord } from './ops-alert-log.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
const state = vi.hoisted(() => ({ scope: { tier: 'confidential', tenant_slug: 'fixture-a' } }));
vi.mock('./scope-context.js', async (original) => ({
  ...(await original<typeof import('./scope-context.js')>()),
  currentScope: () => state.scope,
}));
import {
  acknowledgeSchedulerIncident,
  listSchedulerIncidents,
  recordSchedulerIncident,
  schedulerFailureIdentity,
  schedulerIncidentSweepKey,
} from './scheduler-incidents.js';
const root = pathResolver.sharedTmp(`scheduler-incidents-${process.pid}`);
const alertLogPath = `${root}/ops-alerts.jsonl`;
afterAll(() => safeRmSync(root, { recursive: true, force: true }));

describe('scheduler cause projection on the existing append-only alert ledger', () => {
  it('groups duration variation, honors exact-cause acknowledgements, recovery, recurrence and TTL', () => {
    const start = Date.now();
    const at = (offset: number) => ({ alertLogPath, now: new Date(start + offset) });
    expect(schedulerFailureIdentity('Timed out after 300s')).toEqual(
      schedulerFailureIdentity('Timed out after 999s')
    );
    recordSchedulerIncident('job', 'failed', 'Timed out after 300s', at(0));
    const first = listSchedulerIncidents(at(0))[0]!;
    expect(acknowledgeSchedulerIncident('job', first.signature, first.episodeId!, at(1))).toBe(
      true
    );
    recordSchedulerIncident('job', 'failed', 'Timed out after 999s', at(2));
    expect(listSchedulerIncidents(at(2))[0]).toMatchObject({
      status: 'acknowledged',
      occurrences: 2,
    });
    recordSchedulerIncident('job', 'succeeded', undefined, at(3));
    expect(listSchedulerIncidents(at(3))[0]).toMatchObject({ status: 'resolved' });
    recordSchedulerIncident('job', 'failed', 'Timed out after 1000s', at(4));
    expect(listSchedulerIncidents(at(4))[0]).toMatchObject({ status: 'detected' });
    recordSchedulerIncident('job', 'failed', '401 authentication failed secret=fixture', at(5));
    const changed = listSchedulerIncidents(at(5)).find(
      (entry) => entry.cause === 'authentication'
    )!;
    expect(changed.status).toBe('detected');
    expect(String(safeReadFile(alertLogPath, { encoding: 'utf8' }))).not.toContain(
      'secret=fixture'
    );
    expect(acknowledgeSchedulerIncident('job', changed.signature, changed.episodeId!, at(6))).toBe(
      true
    );
    expect(
      listSchedulerIncidents(at(86_400_007)).find((entry) => entry.signature === changed.signature)
        ?.status
    ).toBe('detected');
    recordSchedulerIncident('job', 'succeeded', undefined, at(86_400_008));
    recordSchedulerIncident(
      'job',
      'failed',
      '401 authentication failed secret=fixture',
      at(86_400_009)
    );
    expect(
      listSchedulerIncidents(at(86_400_009)).find((entry) => entry.signature === changed.signature)
        ?.status
    ).toBe('detected');
  });
  it('ignores a stale acknowledgement after cause replacement, invalid rows and future events', () => {
    const start = Date.now();
    const now = (offset: number) => ({ alertLogPath, now: new Date(start + offset) });
    recordSchedulerIncident('race-job', 'failed', 'timeout', now(0));
    const old = listSchedulerIncidents(now(0)).find((entry) => entry.scheduleId === 'race-job')!;
    recordSchedulerIncident('race-job', 'failed', '401 authentication failed', now(1));
    appendOpsAlertLogRecord(alertLogPath, {
      ts: new Date(start + 2).toISOString(),
      kind: 'scheduler_incident',
      schedule_id: 'race-job',
      signature: old.signature,
      cause: old.cause,
      event: 'acknowledged',
      ack_until: new Date(start + 10_000).toISOString(),
      scope: state.scope,
    });
    appendOpsAlertLogRecord(alertLogPath, {
      ts: new Date(start + 50_000).toISOString(),
      kind: 'scheduler_incident',
      schedule_id: 'race-job',
      signature: old.signature,
      cause: old.cause,
      event: 'recovered',
      scope: state.scope,
    });
    const before = listSchedulerIncidents(now(3));
    expect(before.find((entry) => entry.signature === old.signature)?.status).toBe('resolved');
    expect(
      before.find((entry) => entry.scheduleId === 'race-job' && entry.cause === 'authentication')
        ?.status
    ).toBe('detected');
    const malformed = {
      ts: new Date(start).toISOString(),
      kind: 'scheduler_incident',
      schedule_id: 'race-job',
      signature: old.signature,
      cause: old.cause,
      event: 'acknowledged',
      ack_until: 'broken',
      scope: state.scope,
    };
    const existing = String(safeReadFile(alertLogPath, { encoding: 'utf8' }));
    safeWriteFile(alertLogPath, existing + JSON.stringify(malformed) + '\n');
    expect(listSchedulerIncidents(now(3))).toEqual(before);
  });

  it('binds acknowledgement to the observed episode across same-cause recovery and delayed ack races', () => {
    const start = Date.now();
    const at = (offset: number) => ({ alertLogPath, now: new Date(start + offset) });
    recordSchedulerIncident('episode-job', 'failed', 'timeout', at(0));
    const first = listSchedulerIncidents(at(0)).find(
      (entry) => entry.scheduleId === 'episode-job'
    )!;
    expect(first.episodeId).toMatch(/^[a-f0-9]{32}$/);
    recordSchedulerIncident('episode-job', 'failed', 'timeout', at(1));
    expect(
      listSchedulerIncidents(at(1)).find((entry) => entry.scheduleId === 'episode-job')?.episodeId
    ).toBe(first.episodeId);
    recordSchedulerIncident('episode-job', 'succeeded', undefined, at(2));
    expect(
      listSchedulerIncidents(at(2)).find((entry) => entry.scheduleId === 'episode-job')
    ).toMatchObject({ status: 'resolved', resolvedBy: 'recovered' });
    recordSchedulerIncident('episode-job', 'failed', 'timeout', at(3));
    const second = listSchedulerIncidents(at(3)).find(
      (entry) => entry.scheduleId === 'episode-job'
    )!;
    expect(second.episodeId).not.toBe(first.episodeId);
    expect(
      acknowledgeSchedulerIncident('episode-job', first.signature, first.episodeId!, at(4))
    ).toBe(false);
    // Simulate an acknowledgement that read the first episode before recovery,
    // then reached the append-only ledger after the recurrence.
    appendOpsAlertLogRecord(alertLogPath, {
      ts: new Date(start + 4).toISOString(),
      kind: 'scheduler_incident',
      schedule_id: 'episode-job',
      signature: first.signature,
      cause: first.cause,
      event: 'acknowledged',
      episode_id: first.episodeId,
      ack_until: new Date(start + 10_000).toISOString(),
      scope: state.scope,
    });
    expect(
      listSchedulerIncidents(at(4)).find((entry) => entry.scheduleId === 'episode-job')
    ).toMatchObject({ episodeId: second.episodeId, status: 'detected' });
    // A repeat prepared using stale producer state cannot replace the live id.
    appendOpsAlertLogRecord(alertLogPath, {
      ts: new Date(start + 5).toISOString(),
      kind: 'scheduler_incident',
      event_id: 'c'.repeat(32),
      schedule_id: 'episode-job',
      signature: first.signature,
      cause: first.cause,
      event: 'failed',
      episode_id: first.episodeId,
      scope: state.scope,
    });
    expect(
      listSchedulerIncidents(at(5)).find((entry) => entry.scheduleId === 'episode-job')?.episodeId
    ).toBe(second.episodeId);
    expect(
      acknowledgeSchedulerIncident('episode-job', second.signature, second.episodeId!, at(6))
    ).toBe(true);
    expect(
      listSchedulerIncidents(at(6)).find((entry) => entry.scheduleId === 'episode-job')
    ).toMatchObject({ episodeId: second.episodeId, status: 'acknowledged' });
    recordSchedulerIncident('episode-job', 'failed', '401 unauthorized', at(7));
    expect(
      listSchedulerIncidents(at(7)).find(
        (entry) => entry.signature === second.signature && entry.scheduleId === 'episode-job'
      )
    ).toMatchObject({ status: 'resolved', resolvedBy: 'superseded' });
  });

  it('keeps legacy history readable but refuses legacy/missing/invalid episode acknowledgements', () => {
    const start = Date.now();
    const options = { alertLogPath, now: new Date(start + 3) };
    const identity = schedulerFailureIdentity('legacy timeout');
    const event = {
      kind: 'scheduler_incident',
      schedule_id: 'legacy-job',
      ...identity,
      scope: state.scope,
    };
    appendOpsAlertLogRecord(alertLogPath, {
      ...event,
      ts: new Date(start).toISOString(),
      event: 'failed',
    });
    appendOpsAlertLogRecord(alertLogPath, {
      ...event,
      ts: new Date(start + 1).toISOString(),
      event: 'acknowledged',
      ack_until: new Date(start + 10_000).toISOString(),
    });
    expect(
      listSchedulerIncidents(options).find((entry) => entry.scheduleId === 'legacy-job')
    ).toMatchObject({ status: 'detected' });
    expect(
      listSchedulerIncidents(options).find((entry) => entry.scheduleId === 'legacy-job')?.episodeId
    ).toBeUndefined();
    expect(() =>
      acknowledgeSchedulerIncident(
        'legacy-job',
        identity.signature,
        undefined as unknown as string,
        options
      )
    ).toThrow('SCHEDULER_INCIDENT_EPISODE_REQUIRED');
    expect(() =>
      acknowledgeSchedulerIncident('legacy-job', identity.signature, 'invalid', options)
    ).toThrow('SCHEDULER_INCIDENT_EPISODE_REQUIRED');
    expect(
      acknowledgeSchedulerIncident('legacy-job', identity.signature, 'a'.repeat(32), options)
    ).toBe(false);
    recordSchedulerIncident('legacy-job', 'failed', 'legacy timeout', {
      ...options,
      now: new Date(start + 2),
    });
    const current = listSchedulerIncidents(options).find(
      (entry) => entry.scheduleId === 'legacy-job'
    )!;
    expect(current.episodeId).toMatch(/^[a-f0-9]{32}$/);
    expect(
      acknowledgeSchedulerIncident('legacy-job', identity.signature, current.episodeId!, options)
    ).toBe(true);
  });

  it('does not expose or acknowledge another tenant cause, even with a known signature', () => {
    const options = { alertLogPath, now: new Date(Date.now() + 86_400_010) };
    const existing = listSchedulerIncidents(options)[0]!;
    const firstKey = schedulerIncidentSweepKey(['job:same-cause']);
    state.scope = { tier: 'confidential', tenant_slug: 'fixture-b' };
    try {
      expect(listSchedulerIncidents(options)).toEqual([]);
      expect(schedulerIncidentSweepKey(['job:same-cause'])).not.toBe(firstKey);
      expect(
        acknowledgeSchedulerIncident('job', existing.signature, existing.episodeId!, options)
      ).toBe(false);
    } finally {
      state.scope = { tier: 'confidential', tenant_slug: 'fixture-a' };
    }
  });
});
