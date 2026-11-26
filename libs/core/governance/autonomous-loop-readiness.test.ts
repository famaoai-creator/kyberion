import { describe, expect, it } from 'vitest';
import type { MemoryLoopHealth } from '../knowledge/memory-loop-health.js';
import {
  evaluateAutonomousLoopReadiness,
  formatAutonomousLoopReadiness,
} from './autonomous-loop-readiness.js';

const NOW = new Date('2026-11-25T10:00:00Z');

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
});
