#!/usr/bin/env node
import { safeExistsSync } from '@agent/core';
import { createStandardYargs } from '@agent/core';
import { auditChain } from '@agent/core';
import { GLOBAL_LEDGER_PATH, verifyLedgerIntegrityDetailed } from '@agent/core';

export interface AuditVerifyCliReport {
  ok: boolean;
  audit: ReturnType<typeof auditChain.verify>;
  ledgers: Array<{
    path: string;
    ok: boolean;
    total: number;
    corrupted: string[];
    missingKey: boolean;
  }>;
  tenantMirrors: {
    ok: boolean;
    findings: string[];
  };
}

function parseLedgerArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateSince(value: unknown, days?: number): string | undefined {
  if (days !== undefined) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split('T')[0];
  }
  if (value === undefined || value === null || value === '') return undefined;
  const since = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error('--since must be YYYY-MM-DD');
  }
  return since;
}

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name) || process.argv.some((arg) => arg.startsWith(`${name}=`));
}

export function collectAuditVerifyReport(
  input: {
    since?: string;
    ledgers?: string[];
  } = {}
): AuditVerifyCliReport {
  const audit = auditChain.verify({ since: input.since });
  const ledgerPaths = [GLOBAL_LEDGER_PATH, ...(input.ledgers ?? [])].filter(
    (item, index, all) => all.indexOf(item) === index
  );
  const ledgers = ledgerPaths.map((ledgerPath) => {
    const report = verifyLedgerIntegrityDetailed(ledgerPath);
    return {
      path: ledgerPath,
      ok: report.ok,
      total: report.total,
      corrupted: report.corrupted,
      missingKey: report.missingKey,
      ...(safeExistsSync(ledgerPath) ? {} : { missing: true }),
    };
  });
  const tenantMirrors = auditChain.verifyTenantMirrors();
  return {
    ok: audit.corrupted.length === 0 && ledgers.every((ledger) => ledger.ok) && tenantMirrors.ok,
    audit,
    ledgers,
    tenantMirrors,
  };
}

export function formatAuditVerifyReport(report: AuditVerifyCliReport): string[] {
  const lines = [
    `Audit chain: ${report.audit.corrupted.length === 0 ? 'ok' : 'failed'}; entries=${report.audit.total}; corrupted=${report.audit.corrupted.length}`,
  ];
  if (report.audit.boundaryLimited) {
    lines.push('  - since-boundary: earlier chain continuity was not checked');
  }
  if (report.audit.corrupted.length > 0) {
    lines.push(`  - findings: ${report.audit.corrupted.join(', ')}`);
  }
  for (const ledger of report.ledgers) {
    lines.push(
      `Ledger: ${ledger.ok ? 'ok' : 'failed'}; entries=${ledger.total}; path=${ledger.path}`
    );
    if (ledger.corrupted.length > 0) {
      lines.push(`  - findings: ${ledger.corrupted.join(', ')}`);
    }
    if (ledger.missingKey) {
      lines.push('  - missing HMAC key for one or more ledger entries');
    }
  }
  lines.push(`Tenant mirrors: ${report.tenantMirrors.ok ? 'ok' : 'failed'}`);
  if (report.tenantMirrors.findings.length > 0) {
    lines.push(`  - findings: ${report.tenantMirrors.findings.join(', ')}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .option('since', { type: 'string', describe: 'Audit file lower bound in YYYY-MM-DD form' })
    .option('days', { type: 'number', describe: 'Verify only the last N days (overrides --since)' })
    .option('ledger', {
      type: 'array',
      describe: 'Additional ledger path(s), repeatable or comma-separated',
    })
    .option('warn-only', {
      type: 'boolean',
      default: false,
      describe: 'Report findings but exit 0 (SA-01 warn observation mode)',
    })
    .parseSync();

  const report = collectAuditVerifyReport({
    since: validateSince(argv.since ?? readArgValue('--since'), argv.days ? Number(argv.days) : (readArgValue('--days') ? Number(readArgValue('--days')) : undefined)),
    ledgers: parseLedgerArgs(argv.ledger ?? readArgValue('--ledger')),
  });
  if (argv.json || hasArg('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatAuditVerifyReport(report)) console.log(line);
  }
  // TODO(SA-01): historical chain data written before HMAC hardening (and by
  // concurrent appenders) fails verification. Per README §5, fail-closed
  // switches go through a warn observation period first. Set
  // KYBERION_AUDIT_CONTINUITY_ENFORCE=true (or drop --warn-only) to enforce.
  const warnOnly =
    (argv.warnOnly || hasArg('--warn-only')) &&
    process.env.KYBERION_AUDIT_CONTINUITY_ENFORCE !== 'true';
  if (!report.ok && warnOnly) {
    console.warn(
      '[audit:verify] findings detected but running in warn observation mode (SA-01); exiting 0.'
    );
    process.exit(0);
  }
  process.exit(report.ok ? 0 : 1);
}

const isDirect = process.argv[1] && /audit_verify\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
