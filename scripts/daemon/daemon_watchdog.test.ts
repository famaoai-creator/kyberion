import { afterEach, describe, expect, it, vi } from 'vitest';

const routing = vi.hoisted(() => ({
  routeAutonomousDecision: vi.fn((_input: unknown) => ({ requestId: 'REQ-DAEMON-1' })),
  missionMain: vi.fn(),
}));
vi.mock('../mission_controller.js', () => ({ main: routing.missionMain }));
vi.mock('@agent/core/governance/approval-decision-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-decision-routing')>()),
  routeAutonomousDecision: routing.routeAutonomousDecision,
}));
import {
  checkDaemonHeartbeats,
  checkDaemonHeartbeatsWithRecovery,
  formatDaemonWatchdogReport,
  DEFAULT_DAEMONS,
  sweepMissionStartCandidates,
  buildWatchdogRestartHints,
  daemonRecoveryKey,
  DAEMON_RECOVERY_MAX_ATTEMPTS_PER_EPISODE,
  resolveWatchdogServiceSpec,
  resolveWatchedDaemons,
  isConfirmedOutage,
  daemonWatchdogRunStatePath,
  DAEMON_WATCHDOG_CONFIRM_WINDOW_MS,
  watchdogConfirmsOutage,
  type ResidentServiceView,
} from './daemon_watchdog.js';
import { resolveDaemonInstance } from '@agent/core/daemon/specs';
import * as workCoordination from '@agent/core/workforce/work-coordination';
import * as autonomyGate from '@agent/core/governance/autonomous-ops-gate';
import * as autonomyState from '@agent/core/governance/autonomy-action-state';
import * as mandates from '@agent/core/governance/mandate-shadow';
import * as missionAdmission from '@agent/core/mission/mission-admission';
import {
  resolveIdentityContext,
  resolveRole,
  withExecutionContextAsync,
} from '@agent/core/authority';
import {
  recordDaemonHeartbeat,
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
} from '@agent/core';

const ROOT = pathResolver.sharedTmp('daemon-watchdog-test/heartbeats');
const ALERT_LOG = pathResolver.sharedTmp('daemon-watchdog-test/alerts.jsonl');
const TRIGGER_STORE = 'active/shared/tmp/daemon-watchdog-test/trigger-deliveries.jsonl';
/** Every DEFAULT_DAEMON treated as running here (hermetic watched set). */
const ALL_INSTALLED: ResidentServiceView = {
  services: [
    { id: 'chronos', requirement: 'required' },
    { id: 'agent-runtime-supervisor', requirement: 'optional' },
    { id: 'generation-schedule', requirement: 'optional', owner_surface: 'generation-schedule' },
  ],
  installedIds: new Set(['agent-runtime-supervisor', 'generation-schedule']),
  enabledSurfaces: new Set(),
};
const missionProposal: ReturnType<typeof workCoordination.listWorkItems>[number] = {
  item_id: 'proposal-1',
  title: 'Mission proposal',
  description: 'Awaiting governed start',
  status: 'blocked',
  priority: 'normal',
  source: 'local',
  source_ref: 'watchdog-test',
  project_id: 'project-1',
  labels: [],
  dependencies: [],
  version: 1,
  created_at: '2026-07-04T00:00:00.000Z',
  updated_at: '2026-07-04T00:00:00.000Z',
  metadata: { requested_work_shape: 'mission' },
};

describe('daemon_watchdog', () => {
  it('records no execution success for blocked mission gate evaluations', async () => {
    const resolver = vi
      .spyOn(missionAdmission, 'resolveDotMissionAdmission')
      .mockReturnValue({ mandate_ref: 'mandate-1', mandate_facts: {} as never });
    const admission = vi
      .spyOn(mandates, 'evaluateMissionStartMandate')
      .mockReturnValue({ covered: true, mandate_id: 'mandate-1', reasons: [] });
    const list = vi.spyOn(workCoordination, 'listWorkItems').mockReturnValue([
      {
        ...missionProposal,
        metadata: { ...missionProposal.metadata, mandate_ref: 'mandate-1' },
        context: { tenant_slug: 'acme' },
      },
    ]);
    const gate = vi.spyOn(autonomyGate, 'evaluateAutonomousOpsAction').mockReturnValue({
      actionId: 'mission_start_mandate',
      decision: 'approve',
      allowed: false,
    } as ReturnType<typeof autonomyGate.evaluateAutonomousOpsAction>);
    const record = vi
      .spyOn(autonomyState, 'recordAutonomyExecution')
      .mockImplementation(() => undefined);
    try {
      await sweepMissionStartCandidates({});
      expect(gate).toHaveBeenCalledWith({ actionId: 'mission_start_mandate', tenantSlug: 'acme' });
      expect(record).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      gate.mockRestore();
      record.mockRestore();
      admission.mockRestore();
      resolver.mockRestore();
    }
  });

  it('does not treat a truthy mandate reference as authority', async () => {
    const list = vi.spyOn(workCoordination, 'listWorkItems').mockReturnValue([
      {
        ...missionProposal,
        context: { tenant_slug: 'acme' },
        metadata: { ...missionProposal.metadata, mandate_ref: 'docs-update' },
      },
    ]);
    const gate = vi.spyOn(autonomyGate, 'evaluateAutonomousOpsAction');
    try {
      await sweepMissionStartCandidates({});
      expect(gate).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      gate.mockRestore();
    }
  });

  it('rechecks authority immediately before mission start and respects intervening revocation', async () => {
    const resolver = vi
      .spyOn(missionAdmission, 'resolveDotMissionAdmission')
      .mockReturnValue({ mandate_ref: 'docs-update', mandate_facts: {} as never });
    const list = vi.spyOn(workCoordination, 'listWorkItems').mockReturnValue([
      {
        ...missionProposal,
        context: { tenant_slug: 'acme' },
        metadata: { ...missionProposal.metadata, mandate_ref: 'docs-update', mandate_facts: {} },
      },
    ]);
    const admission = vi
      .spyOn(mandates, 'evaluateMissionStartMandate')
      .mockReturnValueOnce({ covered: true, mandate_id: 'docs-update', reasons: [] })
      .mockReturnValueOnce({ covered: false, reasons: ['revoked'] });
    const gate = vi.spyOn(autonomyGate, 'evaluateAutonomousOpsAction').mockReturnValue({
      actionId: 'mission_start_mandate',
      decision: 'auto',
      allowed: true,
    } as ReturnType<typeof autonomyGate.evaluateAutonomousOpsAction>);
    routing.missionMain.mockClear();
    try {
      await sweepMissionStartCandidates({});
      expect(admission).toHaveBeenCalledTimes(2);
      expect(routing.missionMain).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      gate.mockRestore();
      admission.mockRestore();
      resolver.mockRestore();
    }
  });

  it.each([
    { projectId: undefined, fail: false },
    { projectId: 'default', fail: false },
    { projectId: 'proj-1', fail: false },
    { projectId: undefined, fail: true },
    { projectId: undefined, fail: false, callerRole: 'daemon_watchdog' },
    { projectId: undefined, fail: false, held: 'preflight' },
    { projectId: undefined, fail: false, held: 'mandate' },
    { projectId: undefined, fail: false, held: 'receipt' },
  ])(
    'mediates the controller scope for project $projectId, failure $fail, held $held',
    async ({ projectId, fail, held, callerRole = 'organization_operator' }) => {
      const item = {
        ...missionProposal,
        status: 'ready' as const,
        context: {
          tenant_slug: 'acme',
          organization_id: 'org-1',
          project_id: projectId ?? 'default',
        },
        metadata: { ...missionProposal.metadata, mission_id: 'MSN-DOT-VALID' },
      };
      const list = vi.spyOn(workCoordination, 'listWorkItems').mockReturnValue([item]);
      const resolver = vi
        .spyOn(missionAdmission, 'resolveDotMissionAdmission')
        .mockReturnValue({ mandate_ref: 'docs', mandate_facts: {} as never });
      const scopeResolver = vi
        .spyOn(missionAdmission, 'resolveDotMissionAdmissionScope')
        .mockReturnValue({
          tenant_slug: 'acme',
          organization_id: 'org-1',
          ...(projectId ? { project_id: projectId } : {}),
        });
      const admission = vi
        .spyOn(mandates, 'evaluateMissionStartMandate')
        .mockReturnValue({ covered: true, mandate_id: 'docs', reasons: [] });
      const gate = vi.spyOn(autonomyGate, 'evaluateAutonomousOpsAction').mockReturnValue({
        actionId: 'mission_start_mandate',
        decision: 'auto',
        allowed: true,
      } as ReturnType<typeof autonomyGate.evaluateAutonomousOpsAction>);
      const claim = vi
        .spyOn(workCoordination, 'claimWorkItem')
        .mockReturnValue({ item, lease: { lease_id: 'mission-lease' } } as never);
      const release = vi
        .spyOn(workCoordination, 'releaseWorkItem')
        .mockReturnValue({ item } as never);
      const state = vi
        .spyOn(missionAdmission, 'inspectMissionAdmissionActivation')
        .mockImplementation(() => {
          expect(resolveRole()).toBe('mission_controller');
          expect(resolveIdentityContext().tenantSlug).toBe('acme');
          return held === 'receipt' ? 'conflict' : 'matched';
        });
      const execution = vi
        .spyOn(autonomyState, 'recordAutonomyExecution')
        .mockImplementation(() => undefined);
      routing.missionMain.mockClear();
      routing.missionMain.mockImplementation(
        async (args: string[], print?: (value: unknown) => void) => {
          expect(resolveRole()).toBe('mission_controller');
          expect(resolveIdentityContext().tenantSlug).toBe('acme');
          if (args.includes('--dry-run')) {
            expect(claim).not.toHaveBeenCalled();
            print?.({
              input: { preflight: { ready: held !== 'preflight', issues: ['tenant incomplete'] } },
            });
            if (held === 'mandate') admission.mockReturnValue({ covered: false, reasons: [] });
            return;
          }
          expect(claim).toHaveBeenCalledTimes(1);
          if (fail) throw new Error('controller rejected admission');
        }
      );
      try {
        await withExecutionContextAsync(
          callerRole,
          async () => {
            expect(resolveRole()).toBe(callerRole);
            await sweepMissionStartCandidates({});
            expect(resolveRole()).toBe(callerRole);
            expect(resolveIdentityContext().tenantSlug).toBe('acme');
          },
          undefined,
          'acme',
          'org-1'
        );
        if (held) {
          expect(claim).not.toHaveBeenCalled();
          expect(execution).not.toHaveBeenCalled();
          expect(routing.missionMain).toHaveBeenCalledTimes(1);
          return;
        }
        expect(claim).toHaveBeenCalledWith(
          expect.objectContaining({
            itemId: item.item_id,
            requireNewLease: true,
            expectedVersion: item.version,
          })
        );
        expect(routing.missionMain).toHaveBeenCalledWith(
          expect.arrayContaining([
            'MSN-DOT-VALID',
            '--admission-work-item',
            item.item_id,
            '--organization-id',
            'org-1',
            ...(projectId ? ['--project-id', projectId] : []),
          ])
        );
        if (!projectId) expect(routing.missionMain.mock.calls[0][0]).not.toContain('--project-id');
        if (fail) {
          expect(release).toHaveBeenCalledWith(
            expect.objectContaining({
              itemId: item.item_id,
              leaseId: 'mission-lease',
              nextStatus: 'blocked',
            })
          );
          expect(release).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'done' }));
          expect(execution).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false }),
            expect.objectContaining({ tenantSlug: 'acme' })
          );
          return;
        }
        expect(release).toHaveBeenCalledWith(
          expect.objectContaining({
            itemId: item.item_id,
            leaseId: 'mission-lease',
            nextStatus: 'done',
            effectDisposition: 'completed',
          })
        );
        expect(execution).toHaveBeenCalledWith(
          expect.objectContaining({ receipt_id: 'mission-start:acme:MSN-DOT-VALID', ok: true }),
          expect.objectContaining({ tenantSlug: 'acme' })
        );
      } finally {
        routing.missionMain.mockReset();
        for (const spy of [
          list,
          resolver,
          scopeResolver,
          admission,
          gate,
          claim,
          release,
          state,
          execution,
        ])
          spy.mockRestore();
      }
    }
  );

  it('does not guess a tenant for unscoped mission proposals', async () => {
    const list = vi
      .spyOn(workCoordination, 'listWorkItems')
      .mockReturnValue([{ ...missionProposal }]);
    const gate = vi.spyOn(autonomyGate, 'evaluateAutonomousOpsAction');
    try {
      await sweepMissionStartCandidates({});
      expect(gate).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      gate.mockRestore();
    }
  });

  it('passes when configured daemons have fresh heartbeats', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    const now = new Date('2026-07-04T00:00:00.000Z');
    // EV-05: derived from DEFAULT_DAEMONS rather than a hardcoded pair, so
    // adding a daemon to the watch list cannot silently rot this test.
    DEFAULT_DAEMONS.forEach((daemonId, index) => {
      recordDaemonHeartbeat(
        daemonId,
        { pid: 100 + index, status: 'running' },
        { rootDir: ROOT, now }
      );
    });

    const report = checkDaemonHeartbeats({
      rootDir: ROOT,
      now: new Date('2026-07-04T00:01:00.000Z'),
      alertLogPath: ALERT_LOG,
      // Hermetic: no live dot charters join the default set in tests.
      dotHeartbeatSpecs: [],
      residentServiceView: ALL_INSTALLED,
    });

    expect(report.ok).toBe(true);
    expect(report.alert).toBeUndefined();
    expect(report.statuses.map((status) => status.status)).toEqual(
      DEFAULT_DAEMONS.map(() => 'healthy')
    );
  });

  it('watches the generation schedule daemon (EV-05)', () => {
    // It recorded no heartbeat and was absent from the watch list, so its
    // outages produced no signal at all — and with no cron catch-up at the time,
    // every firing during the outage was lost rather than late.
    expect(DEFAULT_DAEMONS).toContain('generation-schedule-daemon');
  });

  it('supervises active dot heartbeats with the charter staleness budget', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    const now = new Date('2026-07-04T00:00:00.000Z');
    DEFAULT_DAEMONS.forEach((daemonId, index) => {
      recordDaemonHeartbeat(
        daemonId,
        { pid: 100 + index, status: 'running' },
        { rootDir: ROOT, now }
      );
    });
    // Dot heartbeat is 10 minutes old — stale under the daemon default (3 min)
    // but fresh under the charter's own max_idle_wake_ms.
    recordDaemonHeartbeat(
      'dot-repo-guardian',
      { pid: 200, status: 'running' },
      { rootDir: ROOT, now: new Date(now.getTime() - 10 * 60 * 1000) }
    );

    const report = checkDaemonHeartbeats({
      rootDir: ROOT,
      now: new Date(now.getTime() + 60_000),
      alertLogPath: ALERT_LOG,
      dotHeartbeatSpecs: [{ heartbeat_id: 'dot-repo-guardian', stale_after_ms: 15 * 60 * 1000 }],
      residentServiceView: ALL_INSTALLED,
    });
    expect(report.ok).toBe(true);
    expect(report.statuses.map((status) => status.daemon_id)).toContain('dot-repo-guardian');
  });

  it('raises a governed recovery request per unhealthy daemon (EV-02)', async () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 101, status: 'running' },
      { rootDir: ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );

    const report = await checkDaemonHeartbeatsWithRecovery({
      daemons: ['chronos-daemon', 'agent-runtime-supervisor-daemon'],
      rootDir: ROOT,
      now: new Date('2026-07-04T00:10:00.000Z'),
      staleAfterMs: 3 * 60 * 1000,
      alertLogPath: ALERT_LOG,
      webhookUrl: '',
      triggerStorePath: TRIGGER_STORE,
    });

    expect(report.ok).toBe(false);
    expect(report.recovery).toHaveLength(2);
    for (const recovery of report.recovery ?? []) {
      // daemon_restart is reclassified to `notify`: reversible service-manager
      // restart with no secret exposure; still operator-gated until evidence
      // promotes it to auto.
      expect(recovery.decision).toBe('notify');
      expect(recovery.requires_operator).toBe(true);
    }
    expect(formatDaemonWatchdogReport(report).join('\n')).toContain('awaiting operator');
  });

  describe('HITL decision routing (opt-in)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      routing.routeAutonomousDecision.mockClear();
    });

    async function unhealthyReport() {
      safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
      return checkDaemonHeartbeatsWithRecovery({
        daemons: ['chronos-daemon'],
        rootDir: ROOT,
        now: new Date('2026-07-04T00:10:00.000Z'),
        alertLogPath: ALERT_LOG,
        webhookUrl: '',
        triggerStorePath: TRIGGER_STORE,
      });
    }

    it('keeps the report-only outcome when routing is not enabled', async () => {
      vi.stubEnv('KYBERION_AUTONOMY_DECISION_ROUTING', '');
      const report = await unhealthyReport();
      expect(routing.routeAutonomousDecision).not.toHaveBeenCalled();
      expect(report.recovery?.[0]).toMatchObject({ requires_operator: true });
      expect(report.recovery?.[0]?.decision_request_id).toBeUndefined();
    });

    it('routes an operator-bound recovery through the decision loop, once per daemon', async () => {
      vi.stubEnv('KYBERION_AUTONOMY_DECISION_ROUTING', '1');
      const report = await unhealthyReport();
      expect(routing.routeAutonomousDecision).toHaveBeenCalledTimes(1);
      expect(routing.routeAutonomousDecision.mock.calls[0]?.[0]).toMatchObject({
        dedupeKey: 'chronos-daemon',
        requestedBy: 'daemon_watchdog',
        gate: expect.objectContaining({ actionId: 'daemon_restart', decision: 'notify' }),
      });
      expect(report.recovery?.[0]).toMatchObject({
        requires_operator: true,
        decision_request_id: 'REQ-DAEMON-1',
      });
      expect(formatDaemonWatchdogReport(report).join('\n')).toContain('decision=REQ-DAEMON-1');
    });
  });

  it('warns on a first sighting and escalates a required daemon to critical on the next run', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 101, status: 'running' },
      { rootDir: ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );
    const run = (iso: string) =>
      checkDaemonHeartbeats({
        daemons: ['chronos-daemon', 'agent-runtime-supervisor-daemon'],
        rootDir: ROOT,
        now: new Date(iso),
        staleAfterMs: 3 * 60 * 1000,
        alertLogPath: ALERT_LOG,
        webhookUrl: '',
        residentServiceView: ALL_INSTALLED,
      });

    const first = run('2026-07-04T00:10:00.000Z');
    expect(first.ok).toBe(false);
    expect(first.grace_run).toBe(true);
    expect(first.statuses.map((status) => status.status)).toEqual(['stale', 'missing']);
    expect(first.alerts?.map((entry) => entry.severity)).toEqual(['warning', 'warning']);
    expect(safeExistsSync(daemonWatchdogRunStatePath(ROOT))).toBe(true);

    const second = run('2026-07-04T00:15:00.000Z');
    expect(second.grace_run).toBeUndefined();
    // Required chronos is confirmed → critical; optional supervisor stays a warning.
    expect(second.alerts?.map((entry) => [entry.daemon_id, entry.severity])).toEqual([
      ['chronos-daemon', 'critical'],
      ['agent-runtime-supervisor-daemon', 'warning'],
    ]);
    expect(second.alerts?.[0]?.receipt.suppressed).toBe(false);
    // The supervisor warning repeats within the hour → suppressed (per-daemon key).
    expect(second.alerts?.[1]?.receipt.suppressed).toBe(true);
    const records = String(safeReadFile(ALERT_LOG, { encoding: 'utf8' }))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.at(-2)).toMatchObject({
      severity: 'critical',
      title: 'Daemon heartbeat watchdog: chronos-daemon is stale',
    });
    expect(formatDaemonWatchdogReport(second).join('\n')).toContain(
      'Ops alert (chronos-daemon critical)'
    );

    // A continuing episode does not re-page within 60 minutes.
    const third = run('2026-07-04T00:20:00.000Z');
    expect(third.alerts?.[0]).toMatchObject({ severity: 'critical' });
    expect(third.alerts?.[0]?.receipt.suppressed).toBe(true);
  });

  it('treats a run after a sleep gap as a grace run (no critical)', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    const run = (iso: string) =>
      checkDaemonHeartbeats({
        daemons: ['chronos-daemon'],
        rootDir: ROOT,
        now: new Date(iso),
        alertLogPath: ALERT_LOG,
        webhookUrl: '',
        residentServiceView: ALL_INSTALLED,
      });
    run('2026-07-04T00:00:00.000Z');
    // Host slept for 8 hours: previous run is not the immediately preceding one.
    const afterWake = run('2026-07-04T08:00:00.000Z');
    expect(afterWake.grace_run).toBe(true);
    expect(afterWake.alerts?.[0]?.severity).toBe('warning');
  });

  it('records an info record when a daemon recovers', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    const run = (iso: string) =>
      checkDaemonHeartbeats({
        daemons: ['chronos-daemon'],
        rootDir: ROOT,
        now: new Date(iso),
        alertLogPath: ALERT_LOG,
        webhookUrl: '',
        residentServiceView: ALL_INSTALLED,
      });
    run('2026-07-04T00:00:00.000Z');
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 101, status: 'running' },
      { rootDir: ROOT, now: new Date('2026-07-04T00:04:30.000Z') }
    );
    const recovered = run('2026-07-04T00:05:00.000Z');
    expect(recovered.ok).toBe(true);
    expect(recovered.alerts).toEqual([
      expect.objectContaining({ daemon_id: 'chronos-daemon', severity: 'info' }),
    ]);
  });

  it('confirms an outage only within the confirm window', () => {
    const previous = { timestamp: '2026-07-04T00:00:00.000Z', unhealthy: { a: 'stale' } };
    const at = (ms: number) => new Date(Date.parse(previous.timestamp) + ms);
    expect(isConfirmedOutage('a', previous, at(5 * 60 * 1000))).toBe(true);
    expect(isConfirmedOutage('a', previous, at(DAEMON_WATCHDOG_CONFIRM_WINDOW_MS))).toBe(false);
    expect(isConfirmedOutage('b', previous, at(60_000))).toBe(false);
    expect(isConfirmedOutage('a', null, at(60_000))).toBe(false);
  });

  it('lets the baseline page chronos-dead only on a watchdog-confirmed outage', () => {
    const now = new Date('2026-07-04T00:05:00.000Z');
    const recent = {
      timestamp: '2026-07-04T00:01:00.000Z',
      unhealthy: {} as Record<string, string>,
    };
    expect(watchdogConfirmsOutage('chronos-daemon', null, now)).toBe(true);
    expect(watchdogConfirmsOutage('chronos-daemon', recent, now)).toBe(false);
    // First sighting (grace run) is recorded as unhealthy but not confirmed.
    expect(
      watchdogConfirmsOutage(
        'chronos-daemon',
        { ...recent, unhealthy: { 'chronos-daemon': 'stale' } },
        now
      )
    ).toBe(false);
    expect(
      watchdogConfirmsOutage(
        'chronos-daemon',
        { ...recent, unhealthy: { 'chronos-daemon': 'stale' }, confirmed: ['chronos-daemon'] },
        now
      )
    ).toBe(true);
    // Watchdog last ran before the host slept → not confirmed yet.
    expect(
      watchdogConfirmsOutage(
        'chronos-daemon',
        {
          timestamp: '2026-07-03T18:00:00.000Z',
          unhealthy: { 'chronos-daemon': 'stale' },
          confirmed: ['chronos-daemon'],
        },
        now
      )
    ).toBe(false);
  });

  it('watches optional daemons only when installed or surface-owned', () => {
    const base: ResidentServiceView = { ...ALL_INSTALLED, installedIds: new Set() };
    expect(resolveWatchedDaemons(base)).toEqual(['chronos-daemon']);
    expect(
      resolveWatchedDaemons({ ...base, enabledSurfaces: new Set(['generation-schedule']) })
    ).toEqual(['chronos-daemon', 'generation-schedule-daemon']);
    expect(resolveWatchedDaemons(ALL_INSTALLED)).toEqual(DEFAULT_DAEMONS);
  });

  describe('service unit identity (checkout-scoped)', () => {
    const instance = resolveDaemonInstance(pathResolver.rootDir());

    it('restarts the checkout-scoped label, not the legacy global one', () => {
      const spec = resolveWatchdogServiceSpec('chronos-daemon', { installedUnits: () => [] });
      expect(spec?.label).toBe(`com.kyberion.chronos.${instance.id}`);
      expect(spec?.instanceId).toBe(instance.id);
    });

    it("ignores another checkout's legacy unit", () => {
      const spec = resolveWatchdogServiceSpec('chronos-daemon', {
        installedUnits: () => [
          {
            id: 'chronos',
            label: 'com.kyberion.chronos',
            scope: 'legacy',
            repoRoot: '/elsewhere/kyberion',
            ownedByThisCheckout: false,
            loaded: true,
          },
        ],
      });
      expect(spec?.label).toBe(`com.kyberion.chronos.${instance.id}`);
    });

    it("falls back to this checkout's legacy unit only when no scoped unit exists", () => {
      const legacy = {
        id: 'chronos',
        label: 'com.kyberion.chronos',
        scope: 'legacy' as const,
        repoRoot: instance.repoRoot,
        ownedByThisCheckout: true,
        loaded: true,
      };
      expect(
        resolveWatchdogServiceSpec('chronos-daemon', { installedUnits: () => [legacy] })?.label
      ).toBe('com.kyberion.chronos');
      expect(
        resolveWatchdogServiceSpec('chronos-daemon', {
          installedUnits: () => [
            legacy,
            { ...legacy, label: `com.kyberion.chronos.${instance.id}`, scope: 'scoped' },
          ],
        })?.label
      ).toBe(`com.kyberion.chronos.${instance.id}`);
    });

    it('names the scoped label in the operator hint', () => {
      const hints = buildWatchdogRestartHints([
        'chronos-daemon',
        'agent-runtime-supervisor-daemon',
      ]);
      expect(hints).toContain('pnpm kyberion scheduler restart --apply');
      expect(hints).toContain(
        'pnpm kyberion scheduler restart --apply --daemon agent-runtime-supervisor'
      );
      expect(hints.join('\n')).toContain(
        `launchctl kickstart -k gui/$UID/com.kyberion.chronos.${instance.id}`
      );
      expect(hints.join('\n')).not.toMatch(/gui\/\$UID\/com\.kyberion\.<daemon>(?!\.)/);
    });
  });

  describe('recovery idempotency key', () => {
    const stale = {
      daemon_id: 'chronos-daemon',
      status: 'stale' as const,
      heartbeat: {
        daemon_id: 'chronos-daemon',
        pid: 1,
        status: 'running' as const,
        timestamp: '2026-07-04T00:00:00.000Z',
      },
    };

    it('retries a stale episode once per 15-minute bucket, then stops at the attempt cap', () => {
      const key = (minute: number) =>
        daemonRecoveryKey(
          stale,
          new Date(Date.parse('2026-07-04T00:00:00.000Z') + minute * 60_000)
        );
      const base = 'daemon-recovery:chronos-daemon:stale:since-2026-07-04T00:00:00.000Z';
      expect(key(5)).toBe(`${base}:attempt-1`);
      expect(key(14)).toBe(key(5));
      expect(key(15)).toBe(`${base}:attempt-2`);
      expect(key(30)).toBe(`${base}:attempt-3`);
      expect(key(45)).toBe(`${base}:attempt-${DAEMON_RECOVERY_MAX_ATTEMPTS_PER_EPISODE}`);
      // Past the cap every run maps to the last attempt: duplicates, no more restarts.
      expect(new Set([45, 60, 120, 24 * 60].map(key)).size).toBe(1);
      // A new heartbeat then a new outage is a new episode.
      expect(
        daemonRecoveryKey(
          { ...stale, heartbeat: { ...stale.heartbeat, timestamp: '2026-07-04T03:00:00.000Z' } },
          new Date('2026-07-04T03:10:00.000Z')
        )
      ).toBe('daemon-recovery:chronos-daemon:stale:since-2026-07-04T03:00:00.000Z:attempt-1');
    });

    it('anchors an overrunning in-progress tick on the tick start, not the refreshed heartbeat', () => {
      const overrun = {
        ...stale,
        heartbeat: {
          ...stale.heartbeat,
          timestamp: '2026-07-04T09:00:00.000Z',
          details: { phase: 'tick_in_progress', tick_started_at: '2026-07-04T00:00:00.000Z' },
        },
      };
      const refreshed = {
        ...overrun,
        heartbeat: { ...overrun.heartbeat, timestamp: '2026-07-04T09:01:00.000Z' },
      };
      expect(daemonRecoveryKey(overrun, new Date('2026-07-04T09:00:30.000Z'))).toBe(
        daemonRecoveryKey(refreshed, new Date('2026-07-04T09:01:30.000Z'))
      );
      expect(daemonRecoveryKey(overrun, new Date('2026-07-04T09:00:30.000Z'))).toContain(
        `since-2026-07-04T00:00:00.000Z:attempt-${DAEMON_RECOVERY_MAX_ATTEMPTS_PER_EPISODE}`
      );
    });

    it('treats a fresh in-progress heartbeat as alive and flags an overrunning tick', () => {
      safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
      const write = (iso: string) =>
        recordDaemonHeartbeat(
          'chronos-daemon',
          {
            pid: 101,
            status: 'running',
            details: { phase: 'tick_in_progress', tick_started_at: '2026-07-04T00:00:00.000Z' },
          },
          { rootDir: ROOT, now: new Date(iso) }
        );
      const check = (iso: string) =>
        checkDaemonHeartbeats({
          daemons: ['chronos-daemon'],
          rootDir: ROOT,
          now: new Date(iso),
          staleAfterMs: 3 * 60 * 1000,
          alertLogPath: ALERT_LOG,
          webhookUrl: '',
        });
      write('2026-07-04T02:00:00.000Z');
      expect(check('2026-07-04T02:00:30.000Z').ok).toBe(true);
      write('2026-07-04T09:00:00.000Z');
      const overrun = check('2026-07-04T09:00:30.000Z');
      expect(overrun.ok).toBe(false);
      expect(overrun.statuses[0]?.reason).toMatch(/tick in progress since/);
    });

    it('buckets missing heartbeats per 15 minutes and keeps status in the key', () => {
      const missing = { daemon_id: 'chronos-daemon', status: 'missing' as const };
      const at = (iso: string) => daemonRecoveryKey(missing, new Date(iso));
      expect(at('2026-07-04T00:01:00.000Z')).toBe(at('2026-07-04T00:14:59.000Z'));
      expect(at('2026-07-04T00:15:00.000Z')).not.toBe(at('2026-07-04T00:14:59.000Z'));
      expect(at('2026-07-04T00:01:00.000Z')).not.toBe(
        daemonRecoveryKey(stale, new Date('2026-07-04T00:01:00.000Z'))
      );
    });

    it('raises one recovery per episode across consecutive watchdog runs', async () => {
      safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
      recordDaemonHeartbeat(
        'chronos-daemon',
        { pid: 101, status: 'running' },
        { rootDir: ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
      );
      const run = (iso: string) =>
        checkDaemonHeartbeatsWithRecovery({
          daemons: ['chronos-daemon'],
          rootDir: ROOT,
          now: new Date(iso),
          staleAfterMs: 3 * 60 * 1000,
          alertLogPath: ALERT_LOG,
          webhookUrl: '',
          triggerStorePath: TRIGGER_STORE,
          residentServiceView: ALL_INSTALLED,
        });
      const first = await run('2026-07-04T00:10:00.000Z');
      const second = await run('2026-07-04T00:11:00.000Z');
      expect(first.recovery?.[0]?.trigger_status).not.toBe('duplicate');
      expect(second.recovery?.[0]?.trigger_status).toBe('duplicate');
      // The restart crash-looped before writing a heartbeat: the next bucket retries.
      const retry = await run('2026-07-04T00:16:00.000Z');
      expect(retry.recovery?.[0]?.trigger_status).not.toBe('duplicate');
    });
  });
});
