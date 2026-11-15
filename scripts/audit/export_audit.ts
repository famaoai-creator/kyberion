#!/usr/bin/env node
/**
 * export_audit — export or verify the governed audit chain.
 *
 *   node dist/scripts/audit/export_audit.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tenant <slug>]
 *   node dist/scripts/audit/export_audit.js --verify-only [--tenant <slug>]
 *
 * Consumed by the MCP tools kyberion.audit.export / kyberion.audit.verify
 * (libs/shared-network/src/mcp-server-engine.ts), which return stdout verbatim,
 * so output stays machine-readable: JSONL for export, one JSON object for
 * --verify-only. A completed verification always exits 0 — the verdict travels
 * in the report's `ok` field, because a nonzero exit would surface to the tool
 * as an opaque exec failure and drop the findings.
 */
import { createStandardYargs } from '@agent/core/cli-utils';
import { auditChain, type AuditEntry } from '@agent/core/governance/audit-chain';
import { defineScript, isDirectScript } from '../lib/harness.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(value: unknown, flag: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = String(value);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !DATE_RE.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`${flag} must be a valid YYYY-MM-DD date`);
  }
  return date;
}

function entryDate(entry: AuditEntry): string {
  return String(entry.timestamp ?? '').slice(0, 10);
}

function exportEntries(from: string | undefined, to: string | undefined, tenant?: string): string {
  const entries = tenant ? auditChain.loadForScope({ tenant_slug: tenant }) : auditChain.loadAll();
  return entries
    .filter((entry) => {
      const date = entryDate(entry);
      if (from && date && date < from) return false;
      if (to && date && date > to) return false;
      return true;
    })
    .map((entry) => JSON.stringify(entry))
    .join('\n');
}

function verifyReport(): Record<string, unknown> {
  const chain = auditChain.verify();
  const mirrors = auditChain.verifyTenantMirrors();
  return {
    ok: chain.corrupted.length === 0 && mirrors.ok,
    valid: chain.valid,
    total: chain.total,
    corrupted: chain.corrupted,
    checked_files: chain.checkedFiles?.length ?? 0,
    tenant_mirrors: { ok: mirrors.ok, findings: mirrors.findings },
  };
}

export async function main(args: string[] = []): Promise<Record<string, unknown> | string> {
  const argv = await createStandardYargs(['node', 'export_audit', ...args])
    .option('from', { type: 'string', describe: 'Start date filter YYYY-MM-DD' })
    .option('to', { type: 'string', describe: 'End date filter YYYY-MM-DD' })
    .option('tenant', { type: 'string', describe: 'Restrict export to a tenant slug' })
    .option('verify-only', {
      type: 'boolean',
      default: false,
      describe: 'Verify hash-chain integrity instead of exporting',
    })
    .parseSync();

  if (argv.verifyOnly) return verifyReport();
  const from = validateDate(argv.from, '--from');
  const to = validateDate(argv.to, '--to');
  if (from && to && from > to) throw new Error('--from must not be after --to');
  return exportEntries(from, to, argv.tenant ? String(argv.tenant) : undefined);
}

if (
  isDirectScript(import.meta.url, 'export_audit.ts') ||
  isDirectScript(import.meta.url, 'export_audit.js')
)
  void defineScript({
    name: 'audit:export',
    flags: [],
    async run(context) {
      const result = await main(context.argv);
      context.print(result);
      return result;
    },
  })();
