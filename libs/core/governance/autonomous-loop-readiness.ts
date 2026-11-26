/**
 * Unified Autonomous Loop Readiness diagnostics.
 *
 * Composes daemon supervision heartbeats, active dot charter triggers & recent
 * wake failures, memory loop health, and factory autonomy readiness into a
 * single operator diagnostic report. Read-only: never modifies state or grants
 * authority.
 */

import { pathResolver } from '../path-resolver.js';
import { withStoreGrant } from '../authority.js';
import { isValidTenantSlug } from '../entity-scope.js';
import {
  listDaemonHeartbeatStatuses,
  repoHeartbeatDir,
  type DaemonHeartbeatStatus,
} from '../daemon/daemon-heartbeat.js';
import { listDotCharters } from '../dot/dot-charter.js';
import {
  listActiveDotHeartbeatIds,
  listActiveDotHeartbeatSpecs,
  type DotHeartbeatSpec,
} from '../dot/dot-runtime.js';
import { readDotWakeLedger, type DotWakeLedgerEntry } from '../dot/dot-wake-ledger.js';
import {
  computeMemoryLoopHealth,
  formatMemoryLoopHealthDetail,
  type MemoryLoopHealth,
} from '../knowledge/memory-loop-health.js';
import { tenantProfileDir } from '../organization/tenant-registry.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from '../secure-io.js';
import {
  evaluateFactoryReadiness,
  type FactoryReadinessInput,
  type FactoryReadinessReport,
} from './factory-readiness.js';

export type AutonomousLoopStatus = 'ready' | 'degraded' | 'blocked';

export interface AutonomousLoopReadinessInput extends FactoryReadinessInput {
  rootDir?: string;
  now?: Date;
  windowDays?: number;
  heartbeatStaleAfterMs?: number;
  /** Test seams. */
  listHeartbeatStatuses?: () => DaemonHeartbeatStatus[];
  listDotChartersFn?: typeof listDotCharters;
  listActiveDotHeartbeatsFn?: typeof listActiveDotHeartbeatIds;
  listActiveDotHeartbeatSpecsFn?: typeof listActiveDotHeartbeatSpecs;
  listTenantsFn?: (options?: { rootDir?: string }) => string[];
  readWakeLedgerFn?: () => DotWakeLedgerEntry[];
  computeMemoryLoopFn?: typeof computeMemoryLoopHealth;
  evaluateFactoryFn?: typeof evaluateFactoryReadiness;
}

export interface AutonomousLoopHeartbeatSummary {
  total: number;
  healthy: number;
  unhealthy_ids: string[];
}

export interface AutonomousLoopDotSummary {
  active_charters: number;
  charter_load_errors: number;
  recent_delivered: number;
  recent_failed: number;
  recent_rejected: number;
}

export interface AutonomousLoopReadinessReport {
  status: AutonomousLoopStatus;
  ready_for_unattended_loop: boolean;
  evaluated_at: string;
  heartbeats: AutonomousLoopHeartbeatSummary;
  dots: AutonomousLoopDotSummary;
  memory_loop: MemoryLoopHealth;
  factory?: FactoryReadinessReport;
  findings: string[];
}

const DEFAULT_WAKE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function listRegisteredTenantSlugs(options: { rootDir?: string } = {}): string[] {
  return withStoreGrant('workspace_tenant_registry_index_reader', () => {
    const dir = tenantProfileDir(options);
    const safeDir = assertSafeRepositoryPath(dir, {
      allowMissingLeaf: true,
      rootDir: options.rootDir,
    });
    if (!safeExistsSync(safeDir)) return [];
    return safeReaddir(safeDir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter(isValidTenantSlug)
      .sort();
  });
}

/**
 * Evaluate the end-to-end health of Kyberion's unattended autonomous loop.
 */
export function evaluateAutonomousLoopReadiness(
  input: AutonomousLoopReadinessInput = {}
): AutonomousLoopReadinessReport {
  const rootDir = input.rootDir ?? pathResolver.rootDir();
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? DEFAULT_WAKE_WINDOW_DAYS;
  const cutoffMs = now.getTime() - windowDays * DAY_MS;

  const dotSpecs: DotHeartbeatSpec[] = input.listActiveDotHeartbeatSpecsFn
    ? input.listActiveDotHeartbeatSpecsFn(rootDir)
    : input.listActiveDotHeartbeatsFn
      ? input.listActiveDotHeartbeatsFn(rootDir).map((heartbeat_id) => ({ heartbeat_id }))
      : listActiveDotHeartbeatSpecs(rootDir);
  const dotStaleAfter = new Map<string, number>();
  for (const spec of dotSpecs) {
    if (spec.stale_after_ms !== undefined) {
      dotStaleAfter.set(spec.heartbeat_id, spec.stale_after_ms);
    }
  }
  const statuses = (
    input.listHeartbeatStatuses ??
    (() =>
      listDaemonHeartbeatStatuses({
        ...(input.rootDir ? { rootDir: repoHeartbeatDir(input.rootDir) } : {}),
        now,
        staleAfterMs: input.heartbeatStaleAfterMs,
        staleAfterMsByDaemonId: dotStaleAfter,
      }))
  )();
  const statusById = new Map(statuses.map((entry) => [entry.daemon_id, entry]));
  for (const spec of dotSpecs) {
    if (!statusById.has(spec.heartbeat_id)) {
      statusById.set(spec.heartbeat_id, {
        daemon_id: spec.heartbeat_id,
        status: 'missing',
        reason: 'active dot heartbeat missing',
      });
    }
  }
  const allStatuses = [...statusById.values()];
  const unhealthyIds = allStatuses
    .filter((entry) => entry.status !== 'healthy')
    .map((entry) => `${entry.daemon_id}:${entry.status}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const charterErrors: Array<{ path: string; error: string }> = [];
  const activeCharters = (input.listDotChartersFn ?? listDotCharters)(rootDir, {
    status: 'active',
    errors: charterErrors,
  });

  const ledgerRows = (input.readWakeLedgerFn ?? (() => readDotWakeLedger({ rootDir })))().filter(
    (row) => {
      const firedMs = Date.parse(row.fired_at);
      return Number.isFinite(firedMs) && firedMs >= cutoffMs;
    }
  );
  let recentDelivered = 0;
  let recentFailed = 0;
  let recentRejected = 0;
  for (const row of ledgerRows) {
    if (row.outcome === 'delivered') recentDelivered += 1;
    else if (row.outcome === 'failed') recentFailed += 1;
    else if (row.outcome === 'rejected') recentRejected += 1;
  }

  let memoryLoopTenants: string[];
  if (input.tenant_slug) {
    memoryLoopTenants = [input.tenant_slug];
  } else {
    try {
      memoryLoopTenants = (input.listTenantsFn ?? listRegisteredTenantSlugs)(
        input.rootDir ? { rootDir: input.rootDir } : {}
      );
    } catch {
      memoryLoopTenants = [];
    }
  }
  const memoryLoop = (input.computeMemoryLoopFn ?? computeMemoryLoopHealth)({
    now,
    rootDir,
    windowDays,
    tenants: memoryLoopTenants.length > 0 ? memoryLoopTenants : undefined,
  });

  const factory = input.tenant_slug
    ? (input.evaluateFactoryFn ?? evaluateFactoryReadiness)(input)
    : undefined;

  const findings: string[] = [];
  if (unhealthyIds.length > 0) {
    findings.push(`unhealthy daemon heartbeats: ${unhealthyIds.join(', ')}`);
  }
  if (charterErrors.length > 0) {
    findings.push(`${charterErrors.length} dot charter(s) failed validation`);
  }
  if (recentFailed > 0) {
    findings.push(`${recentFailed} dot wake failure(s) in the last ${windowDays}d`);
  }
  if (memoryLoop.loop_status === 'delivery_open' && memoryLoop.warning) {
    findings.push(`memory loop delivery open: ${memoryLoop.warning}`);
  } else if (memoryLoop.loop_status === 'usage_open' && memoryLoop.usage_warning) {
    findings.push(`memory loop usage open: ${memoryLoop.usage_warning}`);
  }
  if (factory && !factory.ready) {
    findings.push(...factory.blockers);
  }

  const blocked =
    (factory ? factory.halted || !factory.ready : false) ||
    charterErrors.length > 0 ||
    unhealthyIds.length > 0;
  const degraded = !blocked && findings.length > 0;
  const status: AutonomousLoopStatus = blocked ? 'blocked' : degraded ? 'degraded' : 'ready';

  return {
    status,
    ready_for_unattended_loop: status === 'ready',
    evaluated_at: now.toISOString(),
    heartbeats: {
      total: allStatuses.length,
      healthy: allStatuses.length - unhealthyIds.length,
      unhealthy_ids: unhealthyIds,
    },
    dots: {
      active_charters: activeCharters.length,
      charter_load_errors: charterErrors.length,
      recent_delivered: recentDelivered,
      recent_failed: recentFailed,
      recent_rejected: recentRejected,
    },
    memory_loop: memoryLoop,
    ...(factory ? { factory } : {}),
    findings,
  };
}

/** Human-readable multi-line summary for operator status and CLI output. */
export function formatAutonomousLoopReadiness(report: AutonomousLoopReadinessReport): string {
  const lines = [
    `Autonomous loop readiness: ${report.status.toUpperCase()} (${report.ready_for_unattended_loop ? 'unattended OK' : 'attention required'})`,
    `  heartbeats: ${report.heartbeats.healthy}/${report.heartbeats.total} healthy${report.heartbeats.unhealthy_ids.length ? ` (unhealthy: ${report.heartbeats.unhealthy_ids.join(', ')})` : ''}`,
    `  dots: ${report.dots.active_charters} active charter(s), ${report.dots.recent_delivered} delivered / ${report.dots.recent_failed} failed / ${report.dots.recent_rejected} rejected (last ${report.memory_loop.window_days}d)`,
    `  ${formatMemoryLoopHealthDetail(report.memory_loop)}`,
  ];
  if (report.factory) {
    lines.push(
      `  factory (${report.factory.tenant_slug ?? 'global'}): ${report.factory.ready ? 'READY' : 'NOT READY'} (${report.factory.active_mandate_count} mandate(s), ${report.factory.graduated_actions.length} graduated)`
    );
  }
  for (const finding of report.findings) {
    lines.push(`  finding: ${finding}`);
  }
  return lines.join('\n');
}
