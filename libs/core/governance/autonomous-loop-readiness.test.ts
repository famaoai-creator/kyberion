import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { recordDaemonHeartbeat } from '../daemon/daemon-heartbeat.js';
import type { MemoryLoopHealth } from '../knowledge/memory-loop-health.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  evaluateAutonomousLoopReadiness,
  formatAutonomousLoopReadiness,
} from './autonomous-loop-readiness.js';

const NOW = new Date('2026-11-25T10:00:00Z');
const FIXTURE_ROOT = pathResolver.sharedTmp(`autonomous-loop-readiness-test-${process.pid}`);

afterAll(() => {
  safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

function closedMemoryLoop(): MemoryLoopHealth {
  return {
    window_days: 7,
    window_start: '2026-11-18T10:00:00.000Z',
    promoted: 2,
    retrieved: 2,
    used: 1,
    loop_status: 'closed',
    retrieval_rate: 1,
    utilization_rate: 0.5,
  };
}

describe('autonomous-loop-readiness', () => {
  it('reports READY when heartbeats, charters, wake ledger, memory loop, and factory are all clean', () => {
    const report = evaluateAutonomousLoopReadiness({
      now: NOW,
      tenant_slug: 'acme',
      listActiveDotHeartbeatsFn: () => ['dot-ops'],
      listHeartbeatStatuses: () => [{ daemon_id: 'dot-ops', status: 'healthy', age_ms: 5_000 }],
      listDotChartersFn: () => [{} as never],
      readWakeLedgerFn: () => [
        {
          dot_id: 'ops',
          trigger_key: 'cron@10:00',
          kind: 'cron',
          fired_at: '2026-11-25T09:50:00Z',
          outcome: 'delivered',
        },
      ],
      computeMemoryLoopFn: closedMemoryLoop,
      evaluateFactoryFn: () => ({
        ready: true,
        tenant_slug: 'acme',
        halted: false,
        tenant_enabled: true,
        graduated_actions: ['pr_auto_merge'],
        active_mandate_count: 1,
        actions: [],
        blockers: [],
      }),
    });

    expect(report.status).toBe('ready');
    expect(report.ready_for_unattended_loop).toBe(true);
    expect(report.findings).toEqual([]);
    const formatted = formatAutonomousLoopReadiness(report);
    expect(formatted).toContain('Autonomous loop readiness: READY (unattended OK)');
    expect(formatted).toContain('[closed; retrieval=100%, utilization=50%]');
  });

  it('reports BLOCKED when an active dot heartbeat is missing or stale, and DEGRADED when memory utilization is partial', () => {
    const blocked = evaluateAutonomousLoopReadiness({
      now: NOW,
      listActiveDotHeartbeatsFn: () => ['dot-ops'],
      listHeartbeatStatuses: () => [],
      listDotChartersFn: () => [{} as never],
      readWakeLedgerFn: () => [],
      computeMemoryLoopFn: closedMemoryLoop,
    });
    expect(blocked.status).toBe('blocked');
    expect(blocked.heartbeats.unhealthy_ids).toEqual(['dot-ops:missing']);

    const degraded = evaluateAutonomousLoopReadiness({
      now: NOW,
      listActiveDotHeartbeatsFn: () => ['dot-ops'],
      listHeartbeatStatuses: () => [{ daemon_id: 'dot-ops', status: 'healthy', age_ms: 1_000 }],
      listDotChartersFn: () => [{} as never],
      readWakeLedgerFn: () => [],
      computeMemoryLoopFn: () => ({
        window_days: 7,
        window_start: '2026-11-18T10:00:00.000Z',
        promoted: 3,
        retrieved: 2,
        used: 0,
        loop_status: 'usage_open',
        retrieval_rate: 0.67,
        utilization_rate: 0,
        usage_warning:
          'Promoted knowledge was retrieved 2 time(s) in 7d but never recorded as used.',
      }),
    });
    expect(degraded.status).toBe('degraded');
    expect(degraded.ready_for_unattended_loop).toBe(false);
    expect(degraded.findings.some((f) => f.includes('memory loop usage open'))).toBe(true);
  });

  it('applies per-dot max_idle_wake_ms to real heartbeat files while keeping daemon defaults strict', () => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
    const heartbeatDir = path.join(FIXTURE_ROOT, 'active/shared/runtime/heartbeats');
    recordDaemonHeartbeat(
      'dot-repo-guardian',
      { pid: 201, status: 'running' },
      { rootDir: heartbeatDir, now: new Date('2026-11-25T09:45:00Z') }
    );
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 202, status: 'running' },
      { rootDir: heartbeatDir, now: new Date('2026-11-25T09:59:00Z') }
    );

    const healthyAt15m = evaluateAutonomousLoopReadiness({
      rootDir: FIXTURE_ROOT,
      now: NOW,
      listActiveDotHeartbeatSpecsFn: () => [
        { heartbeat_id: 'dot-repo-guardian', stale_after_ms: 4_500_000 },
      ],
      listDotChartersFn: () => [{} as never],
      listTenantsFn: () => [],
      readWakeLedgerFn: () => [],
      computeMemoryLoopFn: closedMemoryLoop,
    });
    expect(healthyAt15m.status).toBe('ready');
    expect(healthyAt15m.heartbeats.unhealthy_ids).toEqual([]);

    const staleAt90m = evaluateAutonomousLoopReadiness({
      rootDir: FIXTURE_ROOT,
      now: new Date('2026-11-25T11:15:00Z'),
      listActiveDotHeartbeatSpecsFn: () => [
        { heartbeat_id: 'dot-repo-guardian', stale_after_ms: 4_500_000 },
      ],
      listDotChartersFn: () => [{} as never],
      listTenantsFn: () => [],
      readWakeLedgerFn: () => [],
      computeMemoryLoopFn: closedMemoryLoop,
    });
    expect(staleAt90m.status).toBe('blocked');
    expect(staleAt90m.heartbeats.unhealthy_ids).toContain('dot-repo-guardian:stale');
    expect(staleAt90m.heartbeats.unhealthy_ids).toContain('chronos-daemon:stale');

    // A regular daemon aged 15m still fails the 3-minute default even when the dot is healthy.
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 202, status: 'running' },
      { rootDir: heartbeatDir, now: new Date('2026-11-25T09:45:00Z') }
    );
    const daemonStaleAt15m = evaluateAutonomousLoopReadiness({
      rootDir: FIXTURE_ROOT,
      now: NOW,
      listActiveDotHeartbeatSpecsFn: () => [
        { heartbeat_id: 'dot-repo-guardian', stale_after_ms: 4_500_000 },
      ],
      listDotChartersFn: () => [{} as never],
      listTenantsFn: () => [],
      readWakeLedgerFn: () => [],
      computeMemoryLoopFn: closedMemoryLoop,
    });
    expect(daemonStaleAt15m.status).toBe('blocked');
    expect(daemonStaleAt15m.heartbeats.unhealthy_ids).toEqual(['chronos-daemon:stale']);
  });

  it('passes registered tenants when unscoped and isolates to the requested tenant when scoped', () => {
    const computeSpy = vi.fn(() => closedMemoryLoop());
    const listTenantsSpy = vi.fn(() => ['aoi-dynamics']);

    evaluateAutonomousLoopReadiness({
      now: NOW,
      listActiveDotHeartbeatSpecsFn: () => [],
      listHeartbeatStatuses: () => [],
      listDotChartersFn: () => [],
      listTenantsFn: listTenantsSpy,
      readWakeLedgerFn: () => [],
      computeMemoryLoopFn: computeSpy,
    });
    expect(listTenantsSpy).toHaveBeenCalledTimes(1);
    expect(computeSpy).toHaveBeenCalledWith(expect.objectContaining({ tenants: ['aoi-dynamics'] }));

    listTenantsSpy.mockClear();
    computeSpy.mockClear();

    evaluateAutonomousLoopReadiness({
      now: NOW,
      tenant_slug: 'acme',
      listActiveDotHeartbeatSpecsFn: () => [],
      listHeartbeatStatuses: () => [],
      listDotChartersFn: () => [],
      listTenantsFn: listTenantsSpy,
      readWakeLedgerFn: () => [],
      computeMemoryLoopFn: computeSpy,
      evaluateFactoryFn: () => ({
        ready: true,
        tenant_slug: 'acme',
        halted: false,
        tenant_enabled: true,
        graduated_actions: [],
        active_mandate_count: 1,
        actions: [],
        blockers: [],
      }),
    });
    expect(listTenantsSpy).not.toHaveBeenCalled();
    expect(computeSpy).toHaveBeenCalledWith(expect.objectContaining({ tenants: ['acme'] }));
  });

  it('discovers tenant slugs from fixture files through workspace_tenant_registry_index_reader when listTenantsFn is omitted', () => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
    const tenantsDir = path.join(FIXTURE_ROOT, 'knowledge/personal/tenants');
    safeMkdir(tenantsDir, { recursive: true });
    safeWriteFile(path.join(tenantsDir, 'demo-tenant.json'), '{"tenant_slug":"demo-tenant"}\n');
    const computeSpy = vi.fn(() => closedMemoryLoop());

    evaluateAutonomousLoopReadiness({
      rootDir: FIXTURE_ROOT,
      now: NOW,
      listActiveDotHeartbeatSpecsFn: () => [],
      listHeartbeatStatuses: () => [],
      listDotChartersFn: () => [],
      readWakeLedgerFn: () => [],
      computeMemoryLoopFn: computeSpy,
    });

    expect(computeSpy).toHaveBeenCalledWith(expect.objectContaining({ tenants: ['demo-tenant'] }));
  });
});
