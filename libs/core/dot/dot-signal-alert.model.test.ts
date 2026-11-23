import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import { probeSpecId } from '../pipeline/state-probe.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import { dotAdmissionScopeHash } from './dot-admission-identity.js';
import { decideDotSignalAlert, publishDotSignalAlerts } from './dot-signal-alert.js';

it('checks every schedule of a bounded alert episode', () => {
  type State = {
    tick: number;
    state?: ReturnType<typeof decideDotSignalAlert>['state'];
    firstUnhealthy?: number;
    published: boolean;
    violation?: boolean;
  };
  const report = checkFiniteStateSafety<State>({
    initial: [{ tick: 0, published: false }],
    key: (state) => JSON.stringify(state),
    next(previous) {
      if (previous.tick === 5) return [];
      const tick = previous.tick + 1;
      return (['healthy', 'unhealthy', 'unavailable'] as const).flatMap((observation) =>
        [false, true].map((quiet) => {
          const result = decideDotSignalAlert({
            prior: previous.state,
            observedAt: tick,
            observation,
            now: tick,
            maxAgeMs: 2,
            quiet,
          });
          const firstUnhealthy =
            observation === 'healthy'
              ? undefined
              : (previous.firstUnhealthy ?? (observation === 'unhealthy' ? tick : undefined));
          const expected =
            observation === 'unhealthy' &&
            !previous.published &&
            !quiet &&
            firstUnhealthy !== undefined &&
            tick < firstUnhealthy + 2;
          return {
            action: `${observation}, quiet=${quiet}`,
            state: {
              tick,
              state:
                result.publish && result.state
                  ? { ...result.state, status: 'published' as const }
                  : result.state,
              firstUnhealthy,
              published: observation === 'healthy' ? false : previous.published || result.publish,
              violation: result.publish !== expected,
            },
          };
        })
      );
    },
    invariants: {
      freshUnresolvedUnexpiredAndNotYetPublished: (state) => !state.violation,
    },
  });
  expect(report).toMatchObject({ status: 'verified' });
});

it('admits a pending replay only while fresh, unquiet and unpublished', () => {
  const scenarios = ([8, 9, 10, 11, 12] as const).flatMap((now) =>
    [false, true].flatMap((quiet) =>
      (['pending', 'published'] as const).map((status) => ({
        now,
        quiet,
        status,
      }))
    )
  );
  type State =
    | { stage: 'initial' }
    | {
        stage: 'checked';
        scenario: (typeof scenarios)[number];
        published: boolean;
      };
  const checked = checkFiniteStateSafety<State>({
    initial: [{ stage: 'initial' }],
    key: JSON.stringify,
    next: (state) =>
      state.stage === 'initial'
        ? scenarios.map((scenario) => ({
            action: 'replay observation at 9',
            state: {
              stage: 'checked',
              scenario,
              published: decideDotSignalAlert({
                prior: {
                  version: 1,
                  observed_at: 9,
                  opened_at: 9,
                  expires_at: 12,
                  status: scenario.status,
                },
                observation: 'unhealthy',
                observedAt: 9,
                now: scenario.now,
                maxAgeMs: 3,
                quiet: scenario.quiet,
              }).publish,
            },
          }))
        : [],
    invariants: {
      replayAdmissible: (state) =>
        state.stage === 'initial' ||
        state.published ===
          (state.scenario.status === 'pending' &&
            !state.scenario.quiet &&
            state.scenario.now >= 9 &&
            state.scenario.now < 12),
    },
  });
  expect(checked).toMatchObject({ status: 'verified', transitions: 20 });
});

const rootDir = 'active/shared/tmp/signal-alert-' + randomUUID();
afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

const probe = { type: 'file', path: 'knowledge/public/check.txt', expect: 'exists' } as const;
const charter = {
  dot_id: 'signal-test',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
  goal: { signal_probes: [{ signal: 'meeting material', probe }] },
  authority: { authority_role: 'worker' },
  runtime: {},
  notification: { signal_alerts: { max_age_s: 86400 } },
} as DotCharter;

function observation(at: string, healthy = false) {
  return {
    dot_id: charter.dot_id,
    signal: 'meeting material',
    probe_id: probeSpecId(probe),
    scope_hash: dotAdmissionScopeHash(charter),
    measured_at: at,
    healthy,
    detail: 'private raw probe output',
  };
}

it('rechecks scope and recovery before publishing once in the scoped inbox', () => {
  const enqueue = vi.fn();
  const quietHours = { start: '22:00', end: '08:00', timezone: 'UTC' };
  const currentCharter = vi.fn(() => charter);
  const publish = (row: ReturnType<typeof observation>) =>
    publishDotSignalAlerts(charter, [row], {
      rootDir,
      currentCharter,
      enqueue,
      quietHours,
      now: new Date(row.measured_at),
    });
  expect(publish(observation('2026-11-23T23:00:00Z'))).toBe(0);
  currentCharter.mockReturnValueOnce({
    ...charter,
    scope: { ...charter.scope, tenant_slug: 'tenant-b' },
  });
  expect(publish(observation('2026-11-24T08:00:00Z'))).toBe(0);
  expect(publish(observation('2026-11-24T08:01:00Z', true))).toBe(0);
  expect(publish(observation('2026-11-24T08:00:00Z'))).toBe(0);
  expect(enqueue).not.toHaveBeenCalled();
  const next = observation('2026-11-24T08:02:00Z');
  expect(publish(next)).toBe(1);
  expect(publish(next)).toBe(0);
  expect(publish(observation('2026-11-24T08:03:00Z'))).toBe(0);
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      ifAbsent: true,
      scope: expect.objectContaining(charter.scope),
      summary: expect.not.stringContaining('private raw probe output'),
    })
  );
});

it('retains the same inbox identity after an interrupted enqueue', () => {
  const enqueue = vi.fn().mockImplementationOnce(() => {
    throw new Error('injected interruption');
  });
  const publish = (at: string) =>
    publishDotSignalAlerts(charter, [observation(at)], {
      rootDir,
      currentCharter: () => charter,
      enqueue,
      now: new Date(at),
    });
  expect(() => publish('2026-11-24T09:00:00Z')).toThrow('injected interruption');
  expect(publish('2026-11-24T09:00:00Z')).toBe(1);
  expect(enqueue.mock.calls[0]?.[0]).toEqual(enqueue.mock.calls[1]?.[0]);
  expect(publish('2026-11-24T09:00:00Z')).toBe(0);
});

it('withdraws an alert when its source recovers between measurement and delivery', () => {
  const enqueue = vi.fn();
  const row = observation('2026-11-24T08:00:00Z');
  safeWriteFile(`${rootDir}/${probe.path}`, 'ready', { mkdir: true });
  expect(
    publishDotSignalAlerts(charter, [row], {
      rootDir,
      currentCharter: () => charter,
      enqueue,
      now: new Date(row.measured_at),
    })
  ).toBe(0);
  expect(enqueue).not.toHaveBeenCalled();
});
