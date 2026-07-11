/**
 * egress_warn_report.ts — SA-04/SA-05: the warn→enforce decision needs
 * evidence. Aggregates egress_request records from the audit chain into a
 * per-hostname summary (warned vs denied) and prints an enforce-readiness
 * recommendation: flip to enforce once every warned hostname is either
 * allowlisted or confirmed unwanted.
 *
 * Usage:
 *   pnpm egress:report              # summary + recommendation
 *   pnpm egress:report -- --json    # machine-readable
 */

import * as path from 'node:path';
import {
  loadEgressPolicy,
  logger,
  pathResolver,
  safeExistsSync,
  safeReaddir,
  safeReadFile,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

export interface EgressHostSummary {
  hostname: string;
  warned: number;
  denied: number;
  first_seen: string;
  last_seen: string;
}

export interface EgressWarnReport {
  mode: string;
  files_scanned: number;
  hosts: EgressHostSummary[];
  recommendation: string;
}

export function summarizeEgressRecords(lines: string[]): Map<string, EgressHostSummary> {
  const hosts = new Map<string, EgressHostSummary>();
  for (const line of lines) {
    let record: {
      action?: string;
      timestamp?: string;
      result?: string;
      metadata?: { hostname?: string; verdict?: string };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.action !== 'egress_request') continue;
    const hostname = record.metadata?.hostname;
    if (!hostname) continue;
    const at = String(record.timestamp || '');
    let entry = hosts.get(hostname);
    if (!entry) {
      entry = { hostname, warned: 0, denied: 0, first_seen: at, last_seen: at };
      hosts.set(hostname, entry);
    }
    if (record.result === 'failed') entry.denied += 1;
    else entry.warned += 1;
    if (at < entry.first_seen) entry.first_seen = at;
    if (at > entry.last_seen) entry.last_seen = at;
  }
  return hosts;
}

export function buildEgressWarnReport(auditDir?: string): EgressWarnReport {
  const dir = auditDir ?? pathResolver.active('audit');
  const lines: string[] = [];
  let filesScanned = 0;
  if (safeExistsSync(dir)) {
    for (const entry of safeReaddir(dir)) {
      if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) continue;
      filesScanned += 1;
      const raw = String(safeReadFile(path.join(dir, entry), { encoding: 'utf8' }) || '');
      lines.push(...raw.split('\n').filter(Boolean));
    }
  }
  const hosts = [...summarizeEgressRecords(lines).values()].sort(
    (a, b) => b.warned + b.denied - (a.warned + a.denied)
  );
  const mode = loadEgressPolicy().mode ?? 'warn';
  const warnedHosts = hosts.filter((host) => host.warned > 0);

  let recommendation: string;
  if (mode === 'enforce') {
    recommendation = 'Already enforcing.';
  } else if (filesScanned === 0 || hosts.length === 0) {
    recommendation =
      'No egress observations recorded yet — keep warn mode and let the durable warn records accumulate before deciding.';
  } else if (warnedHosts.length === 0) {
    recommendation =
      'No warned hostnames in the observation window — every egress hit the allowlist. Safe to set mode: enforce in egress-policy.json.';
  } else {
    recommendation =
      `${warnedHosts.length} hostname(s) still hit warn: ` +
      `${warnedHosts
        .slice(0, 5)
        .map((host) => host.hostname)
        .join(
          ', '
        )}. Allowlist the legitimate ones (manual_allowed_domains), then flip to enforce.`;
  }

  return { mode, files_scanned: filesScanned, hosts, recommendation };
}

function main(): number {
  const argv = createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .parseSync();
  const report = buildEgressWarnReport();
  if (argv.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`Egress policy mode: ${report.mode} (audit files scanned: ${report.files_scanned})`);
  for (const host of report.hosts.slice(0, 15)) {
    console.log(
      `  ${host.hostname}: warned=${host.warned} denied=${host.denied} last=${host.last_seen}`
    );
  }
  if (report.hosts.length === 0) console.log('  (no egress records)');
  logger.info(`[egress-report] ${report.recommendation}`);
  return 0;
}

const isDirect = process.argv[1] && /egress_warn_report\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  process.exit(main());
}
