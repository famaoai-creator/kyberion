import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import { probeSpecId } from '../pipeline/state-probe.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import { appendDotInboxEntry, dotPreparationIntentPayload } from './dot-inbox.js';
import { sendDueDotDigest } from './dot-digest-delivery.js';
import { dotStatePath } from './dot-state-paths.js';
import { dotAdmissionScopeHash } from './dot-admission-identity.js';
import {
  decideDotSignalAlert,
  dotSignalTriageEntries,
  publishDotSignalAlerts,
  readDotSignalTriage,
  measureDirectedPreparationIntent,
} from './dot-signal-alert.js';

const dotSignalTriageLines = (...args: Parameters<typeof dotSignalTriageEntries>) =>
  dotSignalTriageEntries(...args).map((entry) => entry.text);

it('checks every schedule of a bounded alert episode', () => {
  type State = {
    tick: number;
    state?: ReturnType<typeof decideDotSignalAlert>['state'];
    expiresAt?: number;
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
          const expiresAt =
            observation === 'healthy'
              ? undefined
              : observation === 'unhealthy' &&
                  (previous.expiresAt === undefined ||
                    (!quiet && !previous.published && tick >= previous.expiresAt))
                ? tick + 2
                : previous.expiresAt;
          const expected =
            observation === 'unhealthy' &&
            !previous.published &&
            !quiet &&
            expiresAt !== undefined &&
            tick < expiresAt;
          return {
            action: `${observation}, quiet=${quiet}`,
            state: {
              tick,
              state:
                result.publish && result.state
                  ? { ...result.state, status: 'published' as const }
                  : result.state,
              expiresAt,
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
      summary: expect.stringContaining(
        'the expected file was missing (knowledge/public/check.txt)'
      ),
    })
  );
  const summary = enqueue.mock.calls[0]?.[0].summary;
  expect(summary).toContain('At 2026-11-24T08:02:00.000Z');
  expect(summary).toContain('Next step: Check with the source owner');
  expect(summary).not.toContain('private raw probe output');
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

it('retains prepared evidence when the file arrives but is still invalid during retry', () => {
  const matching = { ...probe, expect: 'matches', regex: '^SECRET_READY$' } as const;
  const configured = {
    ...charter,
    goal: { ...charter.goal, signal_probes: [{ signal: 'meeting material', probe: matching }] },
  };
  const enqueue = vi.fn().mockImplementationOnce(() => {
    throw new Error('injected interruption');
  });
  const publish = (at: string) =>
    publishDotSignalAlerts(configured, [{ ...observation(at), probe_id: probeSpecId(matching) }], {
      rootDir,
      currentCharter: () => configured,
      enqueue,
      now: new Date(at),
    });
  expect(() => publish('2026-11-24T09:00:00Z')).toThrow('injected interruption');
  safeWriteFile(`${rootDir}/${probe.path}`, 'RAW_FILE_CONTENT', { mkdir: true });
  expect(publish('2026-11-24T09:01:00Z')).toBe(1);
  expect(enqueue.mock.calls[0]?.[0]).toEqual(enqueue.mock.calls[1]?.[0]);
  expect(enqueue.mock.calls[1]?.[0].summary).toContain('At 2026-11-24T09:00:00.000Z');
  expect(enqueue.mock.calls[1]?.[0].summary).not.toMatch(/SECRET_READY|RAW_FILE_CONTENT/);
  expect(publish('2026-11-24T09:02:00Z')).toBe(0);
});

it('uses the unchanged inbox payload for episodes pending before preparation was deployed', () => {
  const at = '2026-11-24T09:00:00.000Z';
  const opened = Date.parse(at);
  const probeKey = JSON.stringify(['meeting material', probeSpecId(probe)]);
  const identity = recoveryEvidenceHash([dotAdmissionScopeHash(charter), probeKey]);
  const state = dotStatePath(charter, 'signal-alerts', `${identity}.json`);
  safeWriteFile(
    `${rootDir}/${state}`,
    JSON.stringify({
      version: 1,
      observed_at: opened,
      opened_at: opened,
      expires_at: opened + 60_000,
      status: 'pending',
    }),
    { mkdir: true }
  );
  const enqueue = vi.fn();
  expect(
    publishDotSignalAlerts(charter, [observation(at)], {
      rootDir,
      currentCharter: () => charter,
      enqueue,
      now: new Date(at),
    })
  ).toBe(1);
  expect(enqueue.mock.calls[0]?.[0].summary).toBe(
    `meeting material is still outside its expected state. First detected ${at}.`
  );
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

it.each(['shadow', 'triage', 'prepare'] as const)(
  'routes a configured signal in %s mode without duplicating the primary notification',
  (mode) => {
    const configured: DotCharter = {
      ...charter,
      notification: {
        ...charter.notification,
        digest_cron: '0 9 * * *',
        signal_alerts: { max_age_s: 7200, mode, digest_signals: ['meeting material'] },
      },
    };
    const enqueue = vi.fn();
    const at = new Date('2026-11-24T08:00:00Z');
    const row = observation(at.toISOString());
    const result = publishDotSignalAlerts(configured, [row], {
      rootDir,
      currentCharter: () => configured,
      enqueue,
      now: at,
      digestTimezone: 'UTC',
    });
    expect(readDotSignalTriage(configured, rootDir)).toMatchObject([
      {
        proposed: 'digest',
        applied: mode === 'shadow' ? 'inbox' : 'digest',
        reason: 'configured_digest',
      },
    ]);
    if (mode === 'shadow') {
      expect(result).toBe(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(dotSignalTriageLines(configured, at, rootDir)).toEqual([]);
      return;
    }
    expect(result).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(dotSignalTriageLines(configured, at, rootDir)).toEqual([
      '- meeting material: still outside its expected state at the digest recheck.',
    ]);
    expect(dotSignalTriageLines(configured, at, rootDir, at)).toEqual([]);
    safeWriteFile(`${rootDir}/${probe.path}`, 'ready', { mkdir: true });
    expect(dotSignalTriageLines(configured, at, rootDir)).toEqual([]);
  }
);

it('adds bounded preparation options in prepare mode for an immediate alert', () => {
  const configured: DotCharter = {
    ...charter,
    notification: { signal_alerts: { max_age_s: 3600, mode: 'prepare' } },
  };
  const now = new Date('2026-11-24T08:00:00Z');
  const enqueue = vi.fn();
  expect(
    publishDotSignalAlerts(configured, [observation(now.toISOString())], {
      rootDir,
      currentCharter: () => configured,
      enqueue,
      now,
    })
  ).toBe(1);
  expect(enqueue.mock.calls[0]?.[0].summary).toContain('Options: recheck after the source owner');
});

it.each([false, true])(
  'includes only corroboration from an admitted peer scope (foreign=%s)',
  (foreign) => {
    const peer: DotCharter = {
      ...charter,
      dot_id: 'peer-dot',
      scope: foreign ? { ...charter.scope, tenant_slug: 'tenant-b' } : charter.scope,
    };
    const configured: DotCharter = {
      ...charter,
      team: { accepts_handoffs_from: ['peer-dot'] },
      notification: {
        signal_alerts: {
          max_age_s: 3600,
          mode: 'prepare',
          corroboration: { dot_id: 'peer-dot', signal: 'meeting material' },
        },
      },
    };
    const now = new Date('2026-11-24T08:00:00Z');
    const row = observation(now.toISOString());
    safeWriteFile(
      `${rootDir}/${dotStatePath(peer, 'signal-ledger.jsonl')}`,
      JSON.stringify({
        ...row,
        dot_id: peer.dot_id,
        scope_hash: dotAdmissionScopeHash(peer),
      }) + '\n',
      { mkdir: true }
    );
    const enqueue = vi.fn();
    expect(
      publishDotSignalAlerts(configured, [row], {
        rootDir,
        currentCharter: () => configured,
        enqueue,
        now,
        listPeers: () => [peer],
      })
    ).toBe(1);
    const summary = enqueue.mock.calls[0]?.[0].summary as string;
    expect(summary.includes('Related observation: peer-dot')).toBe(!foreign);
    expect(summary).not.toContain('private raw probe output');
  }
);

it('keeps immediate delivery when the next digest is outside the evidence window', () => {
  const configured: DotCharter = {
    ...charter,
    notification: {
      digest_cron: '0 9 * * *',
      signal_alerts: { max_age_s: 3600, mode: 'triage', digest_signals: ['meeting material'] },
    },
  };
  const now = new Date('2026-11-24T08:00:00Z');
  const enqueue = vi.fn();
  expect(
    publishDotSignalAlerts(configured, [observation(now.toISOString())], {
      rootDir,
      currentCharter: () => configured,
      enqueue,
      now,
      digestTimezone: 'UTC',
    })
  ).toBe(1);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it.each(['accepted', 'retryable'] as const)(
  'does not replay an admitted %s digest as an inbox alert after a mode change',
  (status) => {
    const configured: DotCharter = {
      ...charter,
      notification: {
        digest_cron: '0 9 * * *',
        signal_alerts: { max_age_s: 7200, mode: 'triage', digest_signals: ['meeting material'] },
      },
    };
    const enqueue = vi.fn();
    const publish = (current: DotCharter, at: Date) =>
      publishDotSignalAlerts(current, [observation(at.toISOString())], {
        rootDir,
        now: at,
        currentCharter: () => current,
        enqueue,
        digestTimezone: 'UTC',
      });
    expect(publish(configured, new Date('2026-11-24T08:00:00Z'))).toBe(0);
    const due = new Date('2026-11-24T09:00:00Z');
    const notify = vi.fn(() => ({ status }));
    sendDueDotDigest(configured, 'UTC', {
      rootDir,
      now: () => due,
      notify,
      compose: () => 'digest',
      deferredSignals: () => dotSignalTriageEntries(configured, due, rootDir),
    });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('meeting material'),
      expect.any(String)
    );
    const shadow: DotCharter = {
      ...configured,
      notification: {
        ...configured.notification,
        signal_alerts: { max_age_s: 7200, mode: 'shadow', digest_signals: ['meeting material'] },
      },
    };
    expect(publish(shadow, new Date('2026-11-24T09:11:00Z'))).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    sendDueDotDigest(shadow, 'UTC', {
      rootDir,
      now: () => new Date('2026-11-24T09:11:00Z'),
      notify,
      compose: () => 'replacement digest',
    });
    expect(notify).toHaveBeenCalledTimes(1);
  }
);

it('checks only a declared file signal explicitly addressed under the same custody', () => {
  const configured = {
    ...charter,
    attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
    notification: { signal_alerts: { max_age_s: 3600, mode: 'prepare', directed_intent: true } },
  } as DotCharter;
  const now = new Date('2026-11-24T08:00:00Z');
  const deps = { rootDir, now: () => now };
  appendDotInboxEntry(
    {
      channel: 'inbox',
      dot_id: 'someone-else',
      scope: configured.scope,
      payload: { prepare_signal: 'meeting material' },
    },
    deps
  );
  expect(measureDirectedPreparationIntent(configured, now, rootDir)).toBeUndefined();
  appendDotInboxEntry(
    {
      channel: 'inbox',
      dot_id: configured.dot_id,
      scope: configured.scope,
      source: 'cli',
      payload: dotPreparationIntentPayload(configured, 'meeting material', 'inbox'),
    },
    deps
  );
  expect(measureDirectedPreparationIntent(configured, now, rootDir)).toMatchObject({
    signal: 'meeting material',
    healthy: false,
    probe_id: probeSpecId(probe),
  });
  const changed: DotCharter = {
    ...configured,
    goal: {
      ...configured.goal,
      signal_probes: [
        {
          signal: 'meeting material',
          probe: { ...probe, path: 'knowledge/public/replaced.txt' },
        },
      ],
    },
  };
  expect(measureDirectedPreparationIntent(changed, now, rootDir)).toBeUndefined();
});

it('notifies once when a never-attempted alert outlives quiet hours', () => {
  const configured: DotCharter = {
    ...charter,
    notification: { signal_alerts: { max_age_s: 60 } },
  };
  const enqueue = vi.fn();
  const publish = (at: string) =>
    publishDotSignalAlerts(configured, [observation(at)], {
      rootDir,
      currentCharter: () => configured,
      enqueue,
      now: new Date(at),
      quietHours: { start: '22:00', end: '08:00', timezone: 'UTC' },
    });
  expect(publish('2026-11-24T07:55:00Z')).toBe(0);
  expect(publish('2026-11-24T07:57:00Z')).toBe(0);
  expect(publish('2026-11-24T08:00:00Z')).toBe(1);
  expect(publish('2026-11-24T08:01:00Z')).toBe(0);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it('does not open a new delivery after a previously attempted alert expires', () => {
  const configured: DotCharter = {
    ...charter,
    notification: { signal_alerts: { max_age_s: 60 } },
  };
  const enqueue = vi.fn(() => {
    throw new Error('interrupted delivery');
  });
  const publish = (at: string) =>
    publishDotSignalAlerts(configured, [observation(at)], {
      rootDir,
      currentCharter: () => configured,
      enqueue,
      now: new Date(at),
    });
  expect(() => publish('2026-11-24T08:00:00Z')).toThrow('interrupted delivery');
  expect(publish('2026-11-24T08:02:00Z')).toBe(0);
  expect(publish('2026-11-24T08:03:00Z')).toBe(0);
  expect(enqueue).toHaveBeenCalledTimes(1);
});
