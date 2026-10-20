import { afterEach, describe, expect, it, vi } from 'vitest';

const routing = vi.hoisted(() => ({
  routeAutonomousDecision: vi.fn((_input: unknown) => ({ requestId: 'REQ-DAEMON-1' })),
  missionMain: vi.fn(),
}));
vi.mock('./mission_controller.js', () => ({ main: routing.missionMain }));
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
} from './daemon_watchdog.js';
import * as workCoordination from '@agent/core/workforce/work-coordination';
import * as autonomyGate from '@agent/core/governance/autonomous-ops-gate';
import * as autonomyState from '@agent/core/governance/autonomy-action-state';
import * as mandates from '@agent/core/governance/mandate-shadow';
import * as missionAdmission from '@agent/core/mission/mission-admission';
import * as missionState from '@agent/core/mission/mission-state';
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

  it.each([undefined, 'default', 'proj-1'])(
    'claims typed intake with actual project %s and settles only after an active receipt',
    async (projectId) => {
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
        .spyOn(missionState, 'loadState')
        .mockReturnValue({ status: 'active', tenant_slug: 'acme' } as never);
      const execution = vi
        .spyOn(autonomyState, 'recordAutonomyExecution')
        .mockImplementation(() => undefined);
      routing.missionMain.mockClear();
      try {
        await sweepMissionStartCandidates({});
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

  it('records an ops alert when any heartbeat is stale or missing', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 101, status: 'running' },
      { rootDir: ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );

    const report = checkDaemonHeartbeats({
      daemons: ['chronos-daemon', 'agent-runtime-supervisor-daemon'],
      rootDir: ROOT,
      now: new Date('2026-07-04T00:10:00.000Z'),
      staleAfterMs: 3 * 60 * 1000,
      alertLogPath: ALERT_LOG,
      webhookUrl: '',
    });

    expect(report.ok).toBe(false);
    expect(report.statuses.map((status) => status.status)).toEqual(['stale', 'missing']);
    expect(report.alert?.recorded_path).toBe(ALERT_LOG);
    expect(safeExistsSync(ALERT_LOG)).toBe(true);
    const line = String(safeReadFile(ALERT_LOG, { encoding: 'utf8' }))
      .trim()
      .split('\n')[0]!;
    expect(JSON.parse(line)).toMatchObject({
      severity: 'critical',
      title: 'Daemon heartbeat watchdog detected unhealthy daemon(s)',
    });
    expect(formatDaemonWatchdogReport(report).join('\n')).toContain('Ops alert: recorded=');
  });
});
