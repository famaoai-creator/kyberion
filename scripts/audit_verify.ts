#!/usr/bin/env node
// LE-03: the report collection/formatting now lives in @agent/core report-ops
// and is exposed in-process as the `system:audit_verify` op. This shell
// remains for direct CLI use and the SA-01 warn-observation exit-code policy.
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  collectAuditVerifyReport,
  formatAuditVerifyReport,
  type AuditVerifyCliReport,
} from '@agent/core/report-ops';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export { collectAuditVerifyReport, formatAuditVerifyReport, type AuditVerifyCliReport };

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

function readArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1];
  }
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function hasArg(args: string[], name: string): boolean {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

async function main(args: string[] = []) {
  const argv = await createStandardYargs(['node', 'audit_verify', ...args])
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
    since: validateSince(
      argv.since ?? readArgValue(args, '--since'),
      argv.days
        ? Number(argv.days)
        : readArgValue(args, '--days')
          ? Number(readArgValue(args, '--days'))
          : undefined
    ),
    ledgers: parseLedgerArgs(argv.ledger ?? readArgValue(args, '--ledger')),
  });
  // TODO(SA-01): historical chain data written before HMAC hardening (and by
  // concurrent appenders) fails verification. Per README §5, fail-closed
  // switches go through a warn observation period first. Set
  // KYBERION_AUDIT_CONTINUITY_ENFORCE=true (or drop --warn-only) to enforce.
  const warnOnly =
    (argv.warnOnly || hasArg(args, '--warn-only')) &&
    getRegisteredEnvText('KYBERION_AUDIT_CONTINUITY_ENFORCE') !== 'true';
  return {
    report,
    status: !report.ok && !warnOnly ? 1 : 0,
    warnOnly,
  };
}

if (
  isDirectScript(import.meta.url, 'audit_verify.ts') ||
  isDirectScript(import.meta.url, 'audit_verify.js')
)
  void defineScript({
    name: 'audit:verify',
    flags: ['json'],
    async run(context) {
      const result = await main(context.argv);
      if (context.json) {
        context.print(result.report);
      } else {
        const lines = formatAuditVerifyReport(result.report);
        if (result.warnOnly && !result.report.ok) {
          lines.push(
            '[audit:verify] findings detected but running in warn observation mode (SA-01); exiting 0.'
          );
        }
        context.print(lines.join('\n'));
      }
      if (result.status !== 0) throw new ScriptExitError(result.status, '', true);
      return result.report;
    },
  })();
