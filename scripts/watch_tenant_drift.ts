/**
 * Tenant Drift Watchdog (IP-6)
 *
 * Compensating control for the period before tier-guard tenant enforcement
 * is fully wired. Walks confidential tier paths, infers each path's
 * "expected" tenant from its prefix, and reports any file whose mission-
 * state declares a different tenant_slug. Designed to run on cron (e.g.
 * every 15 minutes) and write an alert digest that an audit-forwarder
 * shell sink can ship to chat.
 *
 * Usage:
 *   node dist/scripts/watch_tenant_drift.js
 *   node dist/scripts/watch_tenant_drift.js --json
 *   node dist/scripts/watch_tenant_drift.js --quiet  # exit 1 only on drift
 *
 * Cron example:
 *   *\/15 * * * * cd /opt/kyberion && node dist/scripts/watch_tenant_drift.js \
 *      --quiet || /opt/kyberion/scripts/notify-slack.sh tenant-drift
 *
 * The watchdog is intentionally read-only and never mutates anything.
 */

import * as path from 'node:path';
import {
  logger,
  pathResolver,
  safeExistsSync,
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { auditChain } from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

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

function detectExpectedTenantFromPath(relPath: string): string | null {
  const segments = relPath.split('/');
  const idx = segments.indexOf('confidential');
  if (idx === -1) return null;
  const candidate = segments[idx + 1];
  if (!candidate) return null;
  return TENANT_SLUG_RE.test(candidate) ? candidate : null;
}

function readMissionState(missionDirRel: string): { tenant_slug?: string; mission_id?: string } | null {
  const statePath = pathResolver.rootResolve(`${missionDirRel}/mission-state.json`);
  if (!safeExistsSync(statePath)) return null;
  try {
    return readJsonFile(statePath);
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

function main(): number {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  const report = scan();

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

  if (report.findings.length > 0) {
    try {
      auditChain.record({
        agentId: 'watch_tenant_drift',
        action: 'integrity_check',
        operation: 'tenant_drift_scan',
        result: 'denied',
        reason: `${report.findings.length} drift finding(s); see report`,
        metadata: { findings: report.findings, scanned_paths: report.scanned_paths },
      });
    } catch (err) {
      logger.warn(`[tenant-drift] failed to append audit entry: ${(err as Error).message ?? err}`);
    }
    return 1;
  }
  return 0;
}

const isDirect = process.argv[1] && /watch_tenant_drift\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  process.exit(main());
}

export { scan as scanTenantDrift };
export type { DriftFinding, DriftReport };
