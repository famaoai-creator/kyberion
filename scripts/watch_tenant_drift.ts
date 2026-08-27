/**
 * Tenant Drift Watchdog (IP-6)
 *
 * Compensating control for the period before tier-guard tenant enforcement
 * is fully wired. Walks confidential tier paths, infers each path's
 * "expected" tenant from its prefix, and reports any file whose mission-
 * state declares a different tenant_slug. Designed to run on cron and,
 * when --alert is supplied, record/dispatch an ops alert through the
 * repository-managed alert sink.
 *
 * Usage:
 *   node dist/scripts/watch_tenant_drift.js
 *   node dist/scripts/watch_tenant_drift.js --json
 *   node dist/scripts/watch_tenant_drift.js --quiet  # exit 1 only on drift
 *   node dist/scripts/watch_tenant_drift.js --quiet --alert
 *
 * Cron example:
 *   *\/15 * * * * cd /opt/kyberion && node dist/scripts/watch_tenant_drift.js --quiet --alert
 *
 * The watchdog is intentionally read-only and never mutates anything.
 */

import * as path from 'node:path';
import {
  logger,
  pathResolver,
  safeExistsSync,
  sendOpsAlert,
  isValidTenantSlug,
  type OpsAlertInput,
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { auditChain } from '@agent/core';
import { readJson } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

interface DriftFinding {
  path: string;
  expected_tenant: string;
  declared_tenant: string | null;
  mission_id?: string;
  reason: string;
}

interface DriftReport {
  timestamp: string;
  scanned_paths: number;
  findings: DriftFinding[];
}

function buildTenantDriftAlert(report: DriftReport): OpsAlertInput {
  return {
    severity: 'critical',
    title: 'Tenant drift detected in confidential mission state',
    context: {
      finding_count: report.findings.length,
      scanned_paths: report.scanned_paths,
      timestamp: report.timestamp,
    },
    recommendation:
      'Stop unattended processing for the affected tenant scope, inspect the confidential mission state paths locally, and repair the tenant_slug metadata before resuming.',
    options: [
      'Run pnpm watch:tenant-drift -- --json on the host to inspect full findings',
      'Repair or quarantine the affected mission directories under active/missions/confidential',
      'Escalate if the finding crosses tenant boundaries or cannot be repaired immediately',
    ],
    dedupe_key: 'tenant-drift',
  };
}

function detectExpectedTenantFromPath(relPath: string): string | null {
  const segments = relPath.split('/');
  const idx = segments.indexOf('confidential');
  if (idx === -1) return null;
  const candidate = segments[idx + 1];
  if (!candidate) return null;
  return isValidTenantSlug(candidate) ? candidate : null;
}

function readMissionState(
  missionDirRel: string
): { tenant_slug?: string; mission_id?: string } | null {
  const statePath = pathResolver.rootResolve(`${missionDirRel}/mission-state.json`);
  if (!safeExistsSync(statePath)) return null;
  try {
    return readJson(statePath);
  } catch {
    return null;
  }
}

function* walkConfidentialMissionDirs(): Generator<{ relPath: string; expectedTenant: string }> {
  const root = pathResolver.rootResolve('active/missions/confidential');
  if (!safeExistsSync(root)) return;
  const all = getAllFiles(root);
  const seen = new Set<string>();
  for (const absFile of all) {
    if (!absFile.endsWith('mission-state.json')) continue;
    const missionDir = path.dirname(absFile);
    const rel = path.relative(pathResolver.rootDir(), missionDir);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const expected = detectExpectedTenantFromPath(rel);
    if (expected) yield { relPath: rel, expectedTenant: expected };
  }
}

function scan(): DriftReport {
  const findings: DriftFinding[] = [];
  let scanned = 0;
  for (const { relPath, expectedTenant } of walkConfidentialMissionDirs()) {
    scanned += 1;
    const state = readMissionState(relPath);
    const declared = state?.tenant_slug ? String(state.tenant_slug).trim() : null;
    if (!declared) {
      findings.push({
        path: relPath,
        expected_tenant: expectedTenant,
        declared_tenant: null,
        ...(state?.mission_id ? { mission_id: state.mission_id } : {}),
        reason: 'mission-state.json has no tenant_slug; expected by path prefix',
      });
      continue;
    }
    if (declared !== expectedTenant) {
      findings.push({
        path: relPath,
        expected_tenant: expectedTenant,
        declared_tenant: declared,
        ...(state?.mission_id ? { mission_id: state.mission_id } : {}),
        reason: `path prefix says '${expectedTenant}' but mission-state declares '${declared}'`,
      });
    }
  }
  return {
    timestamp: new Date().toISOString(),
    scanned_paths: scanned,
    findings,
  };
}

export function recordTenantDriftAudit(report: DriftReport): void {
  auditChain.record({
    agentId: 'watch_tenant_drift',
    action: 'integrity_check',
    operation: 'tenant_drift_scan',
    result: 'denied',
    reason: `${report.findings.length} drift finding(s); see report`,
    metadata: {
      finding_count: report.findings.length,
      scanned_paths: report.scanned_paths,
    },
  });
}

export interface TenantDriftWatchOptions {
  alert?: boolean;
  failOnDrift?: boolean;
}

export function runTenantDriftWatch(options: TenantDriftWatchOptions = {}): {
  report: DriftReport;
  status: number;
  alert: ReturnType<typeof sendOpsAlert> | null;
} {
  const report = scan();
  let alertReceipt: ReturnType<typeof sendOpsAlert> | null = null;
  if (report.findings.length > 0) {
    try {
      recordTenantDriftAudit(report);
    } catch (err) {
      logger.warn(`[tenant-drift] failed to append audit entry: ${(err as Error).message ?? err}`);
    }
    if (options.alert) alertReceipt = sendOpsAlert(buildTenantDriftAlert(report));
  }
  return {
    report,
    status: report.findings.length > 0 && options.failOnDrift !== false ? 1 : 0,
    alert: alertReceipt,
  };
}

function main(args: string[] = []): number {
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  const alert = args.includes('--alert');
  const result = runTenantDriftWatch({ alert });
  const report = result.report;

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!quiet) {
    logger.info(`[tenant-drift] scanned ${report.scanned_paths} confidential mission(s)`);
    if (report.findings.length === 0) {
      logger.success('[tenant-drift] no drift detected');
    } else {
      logger.warn(`[tenant-drift] ${report.findings.length} finding(s)`);
      for (const f of report.findings) {
        logger.warn(`  ${f.path}`);
        logger.warn(`    → ${f.reason}`);
      }
    }
  }

  if (report.findings.length > 0 && alert && !quiet && result.alert) {
    logger.warn(
      `[tenant-drift] ops alert recorded at ${result.alert.recorded_path}; webhook=${result.alert.webhook_delivered ? 'delivered' : 'not-delivered'}`
    );
  }
  return result.status;
}

if (
  isDirectScript(import.meta.url, 'watch_tenant_drift.ts') ||
  isDirectScript(import.meta.url, 'watch_tenant_drift.js')
) {
  void defineScript({
    name: 'watch:tenant-drift',
    flags: [],
    run: ({ argv }) => {
      const status = main(argv);
      if (status !== 0) throw new ScriptExitError(status, 'tenant drift detected');
    },
  })();
}

export { buildTenantDriftAlert, scan as scanTenantDrift };
export type { DriftFinding, DriftReport };
