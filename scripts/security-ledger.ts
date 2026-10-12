/**
 * security:ledger — promote an external-asset ledger DRAFT into the tenant's
 * governed security registry (append-only JSONL), verify entries, retire
 * services, or list the registry.
 *
 * The registry lives at knowledge/confidential/{tenant}/security/
 * external-assets.jsonl per external-asset-inventory.md Phase 2. Every write
 * is an appended version — history is never rewritten.
 *
 *   pnpm security:ledger --tenant <slug> --draft <file> [options]
 *   pnpm security:ledger --tenant <slug> --retire svc:<id> [options]
 *   pnpm security:ledger --tenant <slug> --list
 */

import * as path from 'node:path';

import {
  CHECK_STALE_DAYS,
  checkStatusFor,
  listSecurityAssets,
  promoteSecurityLedger,
  recordCheckResults,
  requiredChecksFor,
  retireSecurityAsset,
  serviceLineage,
  type PromoteOptions,
  type SecurityAssetEntry,
  type SecurityCheckResult,
} from '@agent/core/security-asset-ledger';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { createApprovalRequest, listApprovalRequests } from '@agent/core/governance/approval-store';
import { pathResolver } from '@agent/core/path-resolver';
import { tenantProfilePath } from '@agent/core/organization/tenant-registry';
import { validateReadPermission } from '@agent/core/tier-guard';
import { readJson } from '@agent/core/foundation';
import { safeExistsSync } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

const USAGE = `security:ledger — governed external-asset registry ceremony.

Usage:
  pnpm security:ledger --tenant <slug> --draft <draft.json> [options]
  pnpm security:ledger --tenant <slug> --retire svc:<service_id> [options]
  pnpm security:ledger --tenant <slug> --list

Required:
  --tenant <slug>          Registered tenant slug (or 'common' for the shared namespace)

Actions (pick one):
  --draft <file>           Ledger draft JSON (modeling:asset_inventory_to_ledger output)
  --record-checks <file>   Apply check results JSON ({checks: [{service_id, check_id, result, evidence?, checked_at?}]})
  --retire <service_id>    Logical deletion: append a 'retired' record (governed ceremony)
  --list                   Print latest record per service_id
  --report                 Print the risk matrix (exposure × data_classification) + shadow summary
  --request-approvals      Phase 5: file one approval request covering all shadow entries

Options:
  --verify <ids>           Comma-separated service_ids promoted with review_status 'verified'
  --as-of <YYYY-MM-DD>     Verification date for --verify (default: promotion date)
  --set <key=value>        Governance-field correction applied to every promoted entry —
                           repeatable (owner, department, contract_ref, auth_method,
                           mfa_status, log_access, account_admin, data_classification)
  --approval-id <id>       Approval reference recorded on appended records
  --promoted-by <who>      Ceremony identity (default: KYBERION_PERSONA, then MISSION_ROLE;
                           refused when none is resolvable)
  --lineage <service_id>   Print the full version chain of one service_id
  --dry-run                Print what would be appended and stop before any write
  --root-dir <path>        Test seam: fixture root for tenant registry / ledger
  --help                   Show this help
`;

interface CliArgs {
  tenant?: string;
  draft?: string;
  recordChecks?: string;
  retire?: string;
  list: boolean;
  report: boolean;
  requestApprovals: boolean;
  lineage?: string;
  verify?: string;
  asOf?: string;
  set: string[];
  approvalId?: string;
  promotedBy?: string;
  dryRun: boolean;
  rootDir?: string;
  help: boolean;
}

const GOVERNANCE_KEYS = new Set([
  'owner',
  'department',
  'contract_ref',
  'auth_method',
  'mfa_status',
  'log_access',
  'account_admin',
  'data_classification',
]);

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    list: false,
    report: false,
    requestApprovals: false,
    dryRun: false,
    help: false,
    set: [],
  };
  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--tenant':
        args.tenant = takeValue('--tenant', i);
        i += 1;
        break;
      case '--draft':
        args.draft = takeValue('--draft', i);
        i += 1;
        break;
      case '--record-checks':
        args.recordChecks = takeValue('--record-checks', i);
        i += 1;
        break;
      case '--report':
        args.report = true;
        break;
      case '--request-approvals':
        args.requestApprovals = true;
        break;
      case '--retire':
        args.retire = takeValue('--retire', i);
        i += 1;
        break;
      case '--list':
        args.list = true;
        break;
      case '--lineage':
        args.lineage = takeValue('--lineage', i);
        i += 1;
        break;
      case '--verify':
        args.verify = takeValue('--verify', i);
        i += 1;
        break;
      case '--set': {
        const kv = takeValue('--set', i);
        const eq = kv.indexOf('=');
        if (eq <= 0) throw new Error('--set expects key=value');
        const key = kv.slice(0, eq);
        if (!GOVERNANCE_KEYS.has(key)) {
          throw new Error(`--set only accepts governance keys: ${[...GOVERNANCE_KEYS].join(', ')}`);
        }
        args.set.push(kv);
        i += 1;
        break;
      }
      case '--as-of':
        args.asOf = takeValue('--as-of', i);
        i += 1;
        break;
      case '--approval-id':
        args.approvalId = takeValue('--approval-id', i);
        i += 1;
        break;
      case '--promoted-by':
        args.promotedBy = takeValue('--promoted-by', i);
        i += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--root-dir':
        args.rootDir = takeValue('--root-dir', i);
        i += 1;
        break;
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function resolveIdentity(args: CliArgs): string {
  const explicit = String(args.promotedBy || '').trim();
  if (explicit) return explicit;
  const persona = String(getRegisteredEnvText('KYBERION_PERSONA') || '').trim();
  if (persona) return persona;
  const role = String(getRegisteredEnvText('MISSION_ROLE') || '').trim();
  if (role) return role;
  throw new Error(
    'no ceremony identity — pass --promoted-by <who> or run with KYBERION_PERSONA / MISSION_ROLE set. ' +
      'The ledger records WHO performed every promotion; anonymous writes are refused.'
  );
}

function assertCeremonyIdentity(tenant: string): void {
  if (tenant === 'common') return;
  const profile = tenantProfilePath(tenant);
  const decision = validateReadPermission(profile);
  if (decision.allowed) return;
  throw new Error(
    `the current identity cannot read the tenant profile (${path.relative(pathResolver.rootDir(), profile)}): ` +
      `${String(decision.reason || 'denied').replace(/[.\s]+$/, '')}. Run the ceremony as ` +
      '`KYBERION_PERSONA=ecosystem_architect MISSION_ROLE=mission_controller pnpm security:ledger …`. ' +
      'Nothing was read or written.'
  );
}

/** Phase 5 report: risk matrix + shadow summary over the ledger heads. */
function buildReport(tenant: string, pathOptions: Record<string, unknown>) {
  const assets = listSecurityAssets(tenant, pathOptions).filter((r) => r.status === 'active');
  const byExposure: Record<string, number> = {};
  const riskMatrix: Record<string, number> = {};
  const critical: string[] = [];
  const unclassifiedPublic: string[] = [];
  const shadow: string[] = [];
  const pending: string[] = [];
  const coverageGaps: Array<{ service_id: string; missing: string[] }> = [];
  const coverageByCheck: Record<string, { done: number; missing: number }> = {};
  const staleChecks: Array<{ service_id: string; check_id: string; checked_at: string }> = [];
  for (const r of assets) {
    const e = r.entry;
    byExposure[e.exposure] = (byExposure[e.exposure] || 0) + 1;
    const cell = `${e.exposure} × ${e.data_classification}`;
    riskMatrix[cell] = (riskMatrix[cell] || 0) + 1;
    if (
      e.exposure === 'public' &&
      (e.data_classification === 'personal' || e.data_classification === 'confidential')
    ) {
      critical.push(e.service_id);
    }
    // public + unknown classification is the most urgent gap: the risk is
    // literally unquantified until a human classifies the data.
    if (e.exposure === 'public' && e.data_classification === 'unknown')
      unclassifiedPublic.push(e.service_id);
    if (e.shadow) shadow.push(e.service_id);
    if (e.review_status === 'pending') pending.push(e.service_id);
    // IPA checklist coverage: required checks per category vs recorded
    // check_results on the head. 'stale' counts as missing — a re-check is due.
    const byCheckId = new Map((e.check_results ?? []).map((c) => [c.check_id, c]));
    const statusOf = (id: string) => checkStatusFor(byCheckId.get(id));
    const needsWork = requiredChecksFor(e).filter((id) => statusOf(id) !== 'done');
    if (needsWork.length) coverageGaps.push({ service_id: e.service_id, missing: needsWork });
    for (const id of requiredChecksFor(e)) {
      const cellStats = (coverageByCheck[id] ||= { done: 0, missing: 0 });
      cellStats[statusOf(id) === 'done' ? 'done' : 'missing'] += 1;
    }
    for (const c of e.check_results ?? []) {
      if (checkStatusFor(c) === 'stale') {
        staleChecks.push({
          service_id: e.service_id,
          check_id: c.check_id,
          checked_at: c.checked_at ?? 'undated',
        });
      }
    }
  }
  return {
    kind: 'security_ledger_report',
    tenant,
    generated_at: nowIso(),
    totals: { entries: assets.length, pending: pending.length, shadow: shadow.length },
    exposure_breakdown: byExposure,
    risk_matrix: riskMatrix,
    critical_public_sensitive: critical.sort(),
    public_unclassified: unclassifiedPublic.sort(),
    shadow_entries: shadow.sort(),
    pending_review: pending.sort(),
    ipa_check_coverage: coverageByCheck,
    coverage_gaps: coverageGaps.sort((a, b) => (a.service_id < b.service_id ? -1 : 1)),
    stale_checks: staleChecks.sort((a, b) =>
      a.service_id === b.service_id
        ? a.check_id < b.check_id
          ? -1
          : 1
        : a.service_id < b.service_id
          ? -1
          : 1
    ),
    stale_threshold_days: CHECK_STALE_DAYS,
  };
}

export function main(argv: string[] = [], print: Print = () => undefined): void {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) {
    print(USAGE);
    return;
  }
  if (!args.tenant) throw new Error('--tenant is required (see --help)');

  const rootDir = args.rootDir ? path.resolve(args.rootDir) : pathResolver.rootDir();
  const pathOptions = args.rootDir ? { rootDir, env: {} as NodeJS.ProcessEnv } : {};
  // The ledger reveals the tenant's security posture — reads and writes both
  // go through the same identity gate as the ingest ceremony.
  if (!args.rootDir) assertCeremonyIdentity(args.tenant);
  if (!args.draft && (args.verify || args.asOf || args.set.length)) {
    throw new Error('--verify/--as-of/--set apply to --draft promotions only');
  }
  const actions = [
    args.draft,
    args.recordChecks,
    args.retire,
    args.list,
    args.report,
    args.requestApprovals,
    args.lineage,
  ].filter(Boolean).length;
  if (actions > 1) {
    throw new Error(
      'actions are mutually exclusive — pick one of --draft, --record-checks, --retire, --list, --report, --request-approvals, --lineage'
    );
  }

  if (args.list) {
    const assets = listSecurityAssets(args.tenant, pathOptions);
    print(JSON.stringify(assets, null, 2));
    return;
  }
  if (args.lineage) {
    print(JSON.stringify(serviceLineage(args.tenant, args.lineage, pathOptions), null, 2));
    return;
  }
  if (args.report) {
    print(JSON.stringify(buildReport(args.tenant, pathOptions), null, 2));
    return;
  }
  if (args.requestApprovals) {
    const promotedBy = resolveIdentity(args);
    const assets = listSecurityAssets(args.tenant, pathOptions).filter(
      (r) => r.status === 'active'
    );
    const shadow = assets.filter((r) => r.entry.shadow);
    if (shadow.length === 0) {
      print('[security-ledger] no shadow entries — nothing to request');
      return;
    }
    const summary =
      `${shadow.length} ledger entries are shadow-flagged (unknown owner or contract). ` +
      'Approve a disposition for each: retire (stop the service), supply governance via ' +
      '--set owner=… contract_ref=…, or accept with recorded justification.';
    const details = shadow
      .map(
        (r) =>
          `- ${r.service_id}: ${r.entry.name} (${r.entry.category}, exposure=${r.entry.exposure}, sources=${r.entry.discovery_sources.join('+')})`
      )
      .join('\n');
    if (args.dryRun || args.rootDir) {
      // Approval records live in the global governed store — fixture/test runs
      // only preview; never file a real request from a scratch root.
      print(
        JSON.stringify({ dry_run: true, shadow_count: shadow.length, summary, details }, null, 2)
      );
      print('[security-ledger] DRY RUN — no approval request filed');
      return;
    }
    const correlationId = `security-ledger:${args.tenant}:shadow-review`;
    // Idempotent filing: an existing pending request for the same correlation
    // is returned, not duplicated.
    const existing = listApprovalRequests({
      storageChannels: ['terminal'],
      status: 'pending',
    }).find((r) => r.correlationId === correlationId);
    if (existing) {
      print(
        `[security-ledger] pending approval request already filed: ${existing.id} (${correlationId})`
      );
      return;
    }
    const request = createApprovalRequest('mission_controller', {
      channel: 'terminal',
      threadTs: `security-ledger-shadow-review-${args.tenant}`,
      correlationId,
      requestedBy: promotedBy,
      kind: 'mission_gate',
      draft: {
        title: `External-asset shadow review (${args.tenant})`,
        summary,
        details,
        severity: 'high',
      },
      requestedByContext: {
        surface: 'terminal',
        actorId: promotedBy,
        actorRole: 'mission_controller',
      },
    });
    print(`[security-ledger] approval request filed: ${request.id}`);
    print(
      `[security-ledger] when approved, apply dispositions via --retire <id> --approval-id ${request.id} or --draft … --set owner=… --approval-id ${request.id}`
    );
    return;
  }
  if (args.recordChecks) {
    const promotedBy = resolveIdentity(args);
    const absFile = path.isAbsolute(args.recordChecks)
      ? args.recordChecks
      : path.resolve(rootDir, args.recordChecks);
    if (!safeExistsSync(absFile)) throw new Error(`--record-checks not found: ${absFile}`);
    const parsed = readJson<{ checks?: unknown[] } | unknown[]>(absFile);
    const rawChecks = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.checks)
        ? parsed.checks
        : undefined;
    if (!rawChecks) {
      throw new Error('--record-checks expects {checks: [{service_id, check_id, result, ...}]}');
    }
    const checks = rawChecks.map(
      (c: {
        service_id: string;
        check_id: string;
        result: string;
        evidence?: string;
        checked_at?: string;
      }) => ({
        service_id: c.service_id,
        check: {
          check_id: c.check_id,
          result: c.result,
          ...(c.evidence ? { evidence: c.evidence } : {}),
          ...(c.checked_at ? { checked_at: c.checked_at } : {}),
          checker: promotedBy,
        } satisfies { check_id: string; result: string } & Partial<SecurityCheckResult>,
      })
    );
    if (args.dryRun) {
      print(
        `[security-ledger] DRY RUN — would record ${checks.length} check(s) (tenant ${args.tenant})`
      );
      print(JSON.stringify(checks, null, 2));
      return;
    }
    const result = recordCheckResults(args.tenant, checks, {
      ...pathOptions,
      promotedBy,
      ...(args.approvalId ? { approvalId: args.approvalId } : {}),
    });
    print(`[security-ledger] recorded ${result.applied.length} check(s) → ${result.ledger_path}`);
    print(JSON.stringify(result, null, 2));
    return;
  }
  if (args.retire) {
    const promotedBy = resolveIdentity(args);
    if (args.dryRun) {
      print(`[security-ledger] DRY RUN — would retire ${args.retire} (tenant ${args.tenant})`);
      return;
    }
    const head = listSecurityAssets(args.tenant, pathOptions).find(
      (r) => r.service_id === args.retire
    );
    if (head?.entry.shadow && !args.approvalId) {
      // Shadow disposal is the Phase 5 approval-gated path — allow the call
      // (the operator may be acting on an out-of-band approval), but make the
      // missing audit link loud.
      print(
        `[security-ledger] WARN: '${args.retire}' is shadow-flagged — retiring without --approval-id. ` +
          'Run --request-approvals first and pass the request id for an auditable disposition.'
      );
    }
    const record = retireSecurityAsset(args.tenant, args.retire, {
      ...pathOptions,
      promotedBy,
      ...(args.approvalId ? { approvalId: args.approvalId } : {}),
    });
    print(`[security-ledger] retired ${record.service_id} → ${record.asset_id}@v${record.version}`);
    return;
  }

  if (!args.draft)
    throw new Error(
      'one action is required: --draft, --record-checks, --retire, --list, --report, --request-approvals, or --lineage'
    );
  const absDraft = path.isAbsolute(args.draft) ? args.draft : path.resolve(rootDir, args.draft);
  if (!safeExistsSync(absDraft)) throw new Error(`--draft not found: ${absDraft}`);
  const draft = readJson<{ entries?: SecurityAssetEntry[] }>(absDraft);
  if (!draft || !Array.isArray(draft.entries)) {
    throw new Error('--draft must be a ledger draft object with an entries array');
  }
  const promotedBy = resolveIdentity(args);
  const verifyIds = String(args.verify || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const overrides = Object.fromEntries(
    args.set.map((kv) => {
      const eq = kv.indexOf('=');
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    })
  ) as NonNullable<PromoteOptions['overrides']>;

  const result = promoteSecurityLedger(args.tenant, draft as { entries: SecurityAssetEntry[] }, {
    ...pathOptions,
    promotedBy,
    asOf: args.asOf,
    verifyIds,
    dryRun: args.dryRun,
    ...(args.set.length > 0 ? { overrides } : {}),
    ...(args.approvalId ? { approvalId: args.approvalId } : {}),
  });
  print(
    args.dryRun
      ? '[security-ledger] DRY RUN — nothing was appended'
      : `[security-ledger] promoted → ${result.ledger_path}`
  );
  print(JSON.stringify(result, null, 2));
}

const script = defineScript({
  name: 'security:ledger',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'security-ledger.ts') ||
  isDirectScript(import.meta.url, 'security-ledger.js')
) {
  void script();
}
