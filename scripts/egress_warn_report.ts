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
import { defineScript, isDirectScript } from './lib/harness.js';
import { loadEgressPolicy } from '@agent/core/egress-policy';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { readJsonLines } from '@agent/core/foundation';
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

type EgressAuditRecord = {
  action: 'egress_request';
  timestamp: string;
  result: 'allowed' | 'denied' | 'error' | 'completed' | 'failed';
  metadata: { hostname: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEgressAuditValue(value: unknown): EgressAuditRecord | undefined {
  if (!isRecord(value)) return undefined;
  const hasDangerousKey = (entry: unknown): boolean => {
    if (Array.isArray(entry)) return entry.some(hasDangerousKey);
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return (
      Object.keys(record).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)) ||
      Object.values(record).some(hasDangerousKey)
    );
  };
  if (hasDangerousKey(value) || value.action !== 'egress_request') return undefined;
  if (typeof value.timestamp !== 'string' || value.timestamp.trim() === '') return undefined;
  if (
    value.result !== 'allowed' &&
    value.result !== 'denied' &&
    value.result !== 'error' &&
    value.result !== 'completed' &&
    value.result !== 'failed'
  ) {
    return undefined;
  }
  if (!isRecord(value.metadata) || typeof value.metadata.hostname !== 'string') return undefined;
  const hostname = value.metadata.hostname.trim();
  if (!hostname) return undefined;
  return {
    action: 'egress_request',
    timestamp: value.timestamp,
    result: value.result,
    metadata: { hostname },
  };
}

function parseEgressAuditRecord(line: string): EgressAuditRecord | undefined {
  try {
    return parseEgressAuditValue(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function summarizeEgressRecords(lines: string[]): Map<string, EgressHostSummary> {
  return summarizeParsedEgressRecords(
    lines.map(parseEgressAuditRecord).filter(isEgressAuditRecord)
  );
}

function isEgressAuditRecord(value: EgressAuditRecord | undefined): value is EgressAuditRecord {
  return value !== undefined;
}

function summarizeParsedEgressRecords(
  records: EgressAuditRecord[]
): Map<string, EgressHostSummary> {
  const hosts = new Map<string, EgressHostSummary>();
  for (const record of records) {
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
  const dir = assertSafeRepositoryPath(auditDir ?? pathResolver.active('audit'), {
    allowMissingLeaf: true,
  });
  const records: EgressAuditRecord[] = [];
  let filesScanned = 0;
  if (safeExistsSync(dir) && safeLstat(dir).isDirectory()) {
    for (const entry of safeReaddir(dir)) {
      if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) continue;
      let filePath: string;
      try {
        filePath = assertSafeRepositoryPath(path.join(dir, entry), {
          allowMissingLeaf: true,
        });
        if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) continue;
      } catch {
        continue;
      }
      filesScanned += 1;
      records.push(
        ...readJsonLines<EgressAuditRecord>(filePath, {
          onMalformed: 'skip',
          map(value) {
            const record = parseEgressAuditValue(value);
            if (!record) throw new Error('malformed egress audit record');
            return record;
          },
        })
      );
    }
  }
  const hosts = [...summarizeParsedEgressRecords(records).values()].sort(
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

export function formatEgressWarnReport(report: EgressWarnReport): string[] {
  const lines = [
    `Egress policy mode: ${report.mode} (audit files scanned: ${report.files_scanned})`,
  ];
  for (const host of report.hosts.slice(0, 15)) {
    lines.push(
      `  ${host.hostname}: warned=${host.warned} denied=${host.denied} last=${host.last_seen}`
    );
  }
  if (report.hosts.length === 0) lines.push('  (no egress records)');
  lines.push(`[egress-report] ${report.recommendation}`);
  return lines;
}

function main(args: string[] = []): EgressWarnReport {
  createStandardYargs(['node', 'egress_warn_report', ...args])
    .option('json', { type: 'boolean', default: false })
    .parseSync();
  return buildEgressWarnReport();
}

if (
  isDirectScript(import.meta.url, 'egress_warn_report.ts') ||
  isDirectScript(import.meta.url, 'egress_warn_report.js')
) {
  void defineScript({
    name: 'egress:report',
    flags: ['json'],
    run(context) {
      const report = main(context.argv);
      context.print(context.json ? report : formatEgressWarnReport(report).join('\n'));
      return report;
    },
  })();
}
