import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { probeSpecId } from '../pipeline/state-probe.js';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import { dotAdmissionScopeHash } from './dot-admission-identity.js';
import type { DotCharter } from './dot-charter.js';
import { sendDueDotDigest } from './dot-digest-delivery.js';
import {
  decideDotSignalAlert,
  dotSignalTriageEntries,
  publishDotSignalAlerts,
} from './dot-signal-alert.js';

type Episode = ReturnType<typeof decideDotSignalAlert>['state'];
type State = {
  tick: number;
  mode: 'shadow' | 'prepare';
  preference: 'none' | 'proposed' | 'approved' | 'revoked';
  episode?: Episode;
  route?: 'inbox' | 'digest';
  proof?: 'configured' | 'human';
  delivered: boolean;
  finished: number;
};

it('checks scoped routing safety and repeatability over a bounded proactive lifecycle', () => {
  const result = checkFiniteStateSafety<State>(
    {
      initial: (['shadow', 'prepare'] as const).map((mode) => ({
        tick: 0,
        mode,
        preference: 'none',
        delivered: false,
        finished: 0,
      })),
      key: (state) => JSON.stringify(state),
      next(state) {
        if (state.tick === 8) return [];
        const tick = state.tick + 1;
        const step = (action: string, patch: Partial<State> = {}) => ({
          action,
          state: { ...state, tick, ...patch },
        });
        const next = [step('wait')];
        if (state.preference === 'none')
          next.push(step('operator proposes digest', { preference: 'proposed' }));
        if (state.preference === 'proposed')
          next.push(step('authenticated human approves', { preference: 'approved' }));
        if (state.preference === 'approved')
          next.push(step('revoke approval', { preference: 'revoked' }));
        for (const observation of ['healthy', 'unhealthy', 'unavailable'] as const) {
          for (const quiet of [false, true]) {
            const result = decideDotSignalAlert({
              prior: state.episode,
              observedAt: tick,
              observation,
              now: tick,
              maxAgeMs: 3,
              quiet,
            });
            if (observation === 'healthy') {
              next.push(
                step('close on recovery', {
                  episode: result.state,
                  route: undefined,
                  proof: undefined,
                  delivered: false,
                  finished: state.finished + Number(state.delivered),
                })
              );
            } else if (result.publish && !state.route) {
              for (const configured of [false, true]) {
                const allowed = configured || state.preference === 'approved';
                const route = state.mode === 'prepare' && allowed ? 'digest' : 'inbox';
                next.push(
                  step('confirm and choose immutable route', {
                    episode: result.state,
                    route,
                    proof: route === 'digest' ? (configured ? 'configured' : 'human') : undefined,
                  })
                );
              }
            } else next.push(step(observation, { episode: result.state }));
          }
        }
        if (
          state.route &&
          !state.delivered &&
          state.episode?.status === 'pending' &&
          tick < state.episode.expires_at &&
          (state.proof !== 'human' || state.preference === 'approved')
        ) {
          next.push(
            step('transport accepts', {
              delivered: true,
              episode: { ...state.episode, status: 'published' },
            })
          );
        }
        return next;
      },
      invariants: {
        shadowPreservesInbox: (state) => state.mode !== 'shadow' || state.route !== 'digest',
        digestHasAdmissionBasis: (state) => state.route !== 'digest' || Boolean(state.proof),
        humanRouteWasRatified: (state) =>
          state.proof !== 'human' ||
          state.preference === 'approved' ||
          state.preference === 'revoked',
        committedDeliveryHasAnEpisode: (state) =>
          !state.delivered || Boolean(state.episode && state.route),
      },
    },
    150_000
  );
  expect(result).toMatchObject({ status: 'verified' });
});

it('progresses twice through the real observation reducer if fresh observations and successful delivery continue', () => {
  let prior: Episode;
  for (const start of [1, 4]) {
    const opened = decideDotSignalAlert({
      prior,
      observedAt: start,
      observation: 'unhealthy',
      now: start,
      maxAgeMs: 3,
      quiet: true,
    });
    expect(opened.publish).toBe(false);
    const admitted = decideDotSignalAlert({
      prior: opened.state,
      observedAt: start + 1,
      observation: 'unhealthy',
      now: start + 1,
      maxAgeMs: 3,
      quiet: false,
    });
    expect(admitted.publish).toBe(true);
    prior = decideDotSignalAlert({
      prior: { ...admitted.state!, status: 'published' },
      observedAt: start + 2,
      observation: 'healthy',
      now: start + 2,
      maxAgeMs: 3,
      quiet: false,
    }).state;
    expect(prior?.status).toBe('clear');
  }
});

it('does not retry an unresolved digest after the source recovers', () => {
  const rootDir = 'active/shared/tmp/proactive-loop-' + randomUUID();
  const probe = { type: 'file', path: 'knowledge/public/readiness.txt', expect: 'exists' } as const;
  const charter = {
    dot_id: 'loop-check',
    status: 'active',
    scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
    goal: { signal_probes: [{ signal: 'readiness', probe }] },
    authority: { authority_role: 'worker' },
    runtime: {},
    notification: {
      digest_cron: '0 9 * * *',
      signal_alerts: { max_age_s: 7200, mode: 'triage', digest_signals: ['readiness'] },
    },
  } as DotCharter;
  const observe = (at: string, healthy: boolean) =>
    publishDotSignalAlerts(
      charter,
      [
        {
          dot_id: charter.dot_id,
          signal: 'readiness',
          probe_id: probeSpecId(probe),
          scope_hash: dotAdmissionScopeHash(charter),
          measured_at: at,
          healthy,
        },
      ],
      {
        now: new Date(at),
        rootDir,
        currentCharter: () => charter,
        enqueue: vi.fn(),
        digestTimezone: 'UTC',
      }
    );
  const send = (at: string, notify: Parameters<typeof sendDueDotDigest>[2]['notify']) =>
    sendDueDotDigest(charter, 'UTC', {
      rootDir,
      now: () => new Date(at),
      compose: () => 'digest',
      deferredSignals: (now) => dotSignalTriageEntries(charter, now, rootDir),
      notify,
    });
  try {
    observe('2026-11-24T08:00:00Z', false);
    const firstAttempt = vi.fn((_text: string) => ({ status: 'retryable' as const }));
    expect(send('2026-11-24T09:00:00Z', firstAttempt)).toBe(false);
    expect(firstAttempt).toHaveBeenCalledWith(
      expect.stringContaining('readiness: still outside its expected state'),
      expect.any(String)
    );
    safeWriteFile(rootDir + '/' + probe.path, 'ready', { mkdir: true });
    observe('2026-11-24T09:05:00Z', true);
    expect(dotSignalTriageEntries(charter, new Date('2026-11-24T09:11:00Z'), rootDir)).toEqual([]);
    const report = checkFiniteStateSafety<'admitted' | 'recovered' | 'stale_delivered'>({
      initial: ['admitted'],
      key: (state) => state,
      next: (state) => {
        if (state === 'admitted') return [{ action: 'source recovers', state: 'recovered' }];
        if (state !== 'recovered') return [];
        const notify = vi.fn((_text: string) => ({ status: 'accepted' as const }));
        send('2026-11-24T09:11:00Z', notify);
        return notify.mock.calls.some(([text]) =>
          text.includes('readiness: still outside its expected state')
        )
          ? [{ action: 'retry sends frozen unresolved text', state: 'stale_delivered' }]
          : [];
      },
      invariants: { noUnresolvedMessageAfterKnownRecovery: (state) => state !== 'stale_delivered' },
    });
    expect(report).toMatchObject({ status: 'verified' });
  } finally {
    safeRmSync(rootDir, { recursive: true, force: true });
  }
});

it('renews a never-attempted alert after expiry when quiet hours end', () => {
  type Progress = { tick: number; episode?: Episode; delivered: boolean };
  const report = checkFiniteStateSafety<Progress>({
    initial: [{ tick: 0, delivered: false }],
    key: (state) => JSON.stringify(state),
    next(state) {
      if (state.tick >= 6) return [];
      const tick = state.tick + 1;
      const quiet = tick <= 3;
      const result = decideDotSignalAlert({
        prior: state.episode,
        observedAt: tick,
        observation: 'unhealthy',
        now: tick,
        maxAgeMs: 3,
        quiet,
      });
      return [
        {
          action: quiet ? 'unhealthy during quiet hours' : 'fresh unhealthy after quiet hours',
          state: {
            tick,
            delivered: state.delivered || result.publish,
            episode:
              result.publish && result.state
                ? { ...result.state, status: 'published' }
                : result.state,
          },
        },
      ];
    },
    invariants: {
      eventuallyAlertsWithinThreeFreshUnquietSweeps: (state) => state.tick < 6 || state.delivered,
    },
  });
  expect(report).toMatchObject({ status: 'verified' });
});
