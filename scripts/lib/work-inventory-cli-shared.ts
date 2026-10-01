/**
 * WI-07: shared argv-parsing, scope-resolution, and formatting helpers for
 * `pnpm inventory` (scripts/work_inventory.ts). Kept separate from the
 * dispatcher and the per-area command modules so none of them grows past the
 * ~600 line guideline (docs/developer/improvement-plans-2026-08/
 * WORK_INVENTORY_PLAN_2026-09-22.ja.md §3 WI-07).
 */
import { resolveIdentityContext, withExecutionContext } from '@agent/core/authority';
import { humanActor, HUMAN_ACTOR_PREFIX } from '@agent/core/actor';
import { auditChain } from '@agent/core/governance/audit-chain';
import { resolveTenant } from '@agent/core/organization/tenant-registry';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { currentExecutionScope, getRegisteredEnvText, isCiProcess } from '@agent/core/foundation';
import type { HumanDecidedBy } from '@agent/core/mission/mission-types';
import type {
  WorkFrequencyPer,
  WorkInventoryFrequency,
  WorkInventoryScope,
} from '@agent/core/workforce/work-inventory';
import { getOptionValue, parseCsvOption } from '../refactor/mission-cli-args.js';
import { resolveDecidedByFromArgv } from './decided-by-args.js';

export class WorkInventoryCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkInventoryCliUsageError';
  }
}

/** Positional argv (subcommand chain) mirroring `context.positional`. */
export function getFlag(argv: string[], flag: string): string | undefined {
  return getOptionValue(flag, argv);
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export function csv(argv: string[], flag: string): string[] {
  return parseCsvOption(flag, argv) ?? [];
}

/** Test-only escape hatch: an isolated storage root, never documented to operators. */
export function resolveRootDir(argv: string[]): string | undefined {
  const raw = getFlag(argv, '--root-dir');
  return raw ? raw : undefined;
}

/** `--tenant <slug>` -> tenant scope; absent -> personal scope. */
export function resolveScope(argv: string[]): WorkInventoryScope {
  const tenant = getFlag(argv, '--tenant');
  return tenant ? { tenant_slug: tenant } : {};
}

const FREQUENCY_PATTERN = /^(day|week|month|quarter|year):([0-9]+(?:\.[0-9]+)?)$/;

/** `--frequency week:3` -> `{ per: 'week', count: 3 }`. */
export function parseFrequencyFlag(
  argv: string[],
  flag = '--frequency'
): WorkInventoryFrequency | undefined {
  const raw = getFlag(argv, flag);
  if (!raw) return undefined;
  const match = FREQUENCY_PATTERN.exec(raw.trim());
  if (!match) {
    throw new WorkInventoryCliUsageError(
      `${flag} must look like <day|week|month|quarter|year>:<count>, got "${raw}"`
    );
  }
  return { per: match[1] as WorkFrequencyPer, count: Number(match[2]) };
}

export function parseEffortMinutesFlag(
  argv: string[],
  flag = '--effort-minutes'
): number | undefined {
  const raw = getFlag(argv, flag);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new WorkInventoryCliUsageError(`${flag} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

export function parseDaysFlag(argv: string[], flag = '--days', fallback = 28): number {
  const raw = getFlag(argv, flag);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new WorkInventoryCliUsageError(`${flag} must be a positive number, got "${raw}"`);
  }
  return value;
}

export function parseLimitFlag(argv: string[], flag = '--limit'): number | undefined {
  const raw = getFlag(argv, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkInventoryCliUsageError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/** Requires `--decided-by user:<member-id>`; throws a one-line usage error when absent/malformed. */
export function requireDecidedBy(argv: string[]): HumanDecidedBy {
  let decidedBy: HumanDecidedBy | undefined;
  try {
    decidedBy = resolveDecidedByFromArgv(argv);
  } catch (error) {
    throw new WorkInventoryCliUsageError(error instanceof Error ? error.message : String(error));
  }
  if (!decidedBy) {
    throw new WorkInventoryCliUsageError('--decided-by user:<member-id> is required');
  }
  return decidedBy;
}

/** `user:<member-id>` -> `<member-id>` (the bare id consent/observation actors are keyed by). */
export function bareMemberId(decidedBy: HumanDecidedBy): string {
  return decidedBy.id.startsWith(HUMAN_ACTOR_PREFIX)
    ? decidedBy.id.slice(HUMAN_ACTOR_PREFIX.length)
    : decidedBy.id;
}

export function requireFlag(argv: string[], flag: string, subcommand: string): string {
  const value = getFlag(argv, flag);
  if (!value) throw new WorkInventoryCliUsageError(`${subcommand} requires ${flag}`);
  return value;
}

// ---------------------------------------------------------------------------
// Human-readable formatting (used only when --json is not passed)
// ---------------------------------------------------------------------------

export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): string {
  if (rows.length === 0) return '(none)';
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length))
  );
  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, index) => (cell ?? '').padEnd(widths[index])).join('  ');
  return [
    renderRow(headers),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map(renderRow),
  ].join('\n');
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * Knowledge under `knowledge/personal/` and `knowledge/confidential/<tenant>/`
 * is tier-guarded. The operator CLI reads and writes it as the concierge acting
 * for the human operator — the same governed seam `pnpm tenant` uses. The
 * context is synchronous, so wrap each disk-touching call, never an await.
 */
export function governed<T>(fn: () => T): T {
  return withExecutionContext('sovereign_concierge', fn);
}

/**
 * Govern one explicit tenant operation from the operator CLI. The registry is
 * the authority for tenant existence/status; an already-bound execution may
 * only select that same tenant. Bind the validated scope while the operation
 * runs so downstream writers cannot infer it from signal payloads.
 */
export function governedTenant<T>(
  tenantSlug: string,
  fn: () => T,
  options: { rootDir?: string; decidedBy?: HumanDecidedBy }
): T {
  const activeTenantSlug = resolveIdentityContext().tenantSlug?.trim();
  if (activeTenantSlug && activeTenantSlug !== tenantSlug) {
    throw new Error(
      `[TENANT_SCOPE_MISMATCH] requested tenant '${tenantSlug}' does not match active tenant '${activeTenantSlug}'`
    );
  }
  if (
    !activeTenantSlug &&
    (isCiProcess() ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY ||
      ['SYSTEM_ROLE', 'MISSION_ROLE', 'KYBERION_DELEGATED_ROLE', 'KYBERION_NHI_ID'].some((name) =>
        getRegisteredEnvText(name)?.trim()
      ))
  ) {
    throw new Error(
      '[TENANT_SCOPE_SELECTION_DENIED] an automated execution cannot select a tenant; use an active tenant scope or approved broker context'
    );
  }
  if (!activeTenantSlug && !options.decidedBy) {
    throw new WorkInventoryCliUsageError(
      'Usage: inventory learn --tenant <slug> --decided-by user:<member-id>'
    );
  }
  const decidedBy = options.decidedBy;
  if (!activeTenantSlug && decidedBy) {
    const member = withExecutionContext('sovereign_concierge', () =>
      resolveMemberByPrincipal(
        { source: 'loopback' },
        options.rootDir ? { rootDir: options.rootDir } : {}
      )
    );
    if (!member || decidedBy.id !== `${HUMAN_ACTOR_PREFIX}${member.member_id}`) {
      throw new Error(
        '[TENANT_SCOPE_SELECTION_DENIED] --decided-by must identify the authenticated local owner'
      );
    }
    const membership = member?.memberships.find(
      (entry) =>
        entry.tenant_slug === tenantSlug && ['owner', 'approver', 'operator'].includes(entry.role)
    );
    if (!member || member.status !== 'active' || !membership) {
      throw new Error(
        `[TENANT_SCOPE_SELECTION_DENIED] active owner/operator/approver membership for '${tenantSlug}' is required`
      );
    }
  }
  const tenant = withExecutionContext('sovereign_concierge', () =>
    resolveTenant(tenantSlug, options.rootDir ? { rootDir: options.rootDir } : {})
  );
  if (!activeTenantSlug) {
    const receipt = auditChain.record({
      agentId: decidedBy.id,
      actor: humanActor(bareMemberId(decidedBy)),
      action: 'work_inventory.tenant_scope_selected',
      operation: 'inventory learn',
      result: 'allowed',
      metadata: {
        command: 'inventory learn',
        target_tenant: tenant.profile.tenant_slug,
        scope_source: '--tenant',
      },
    });
    if (
      !auditChain
        .loadAll()
        .some((entry) => entry.id === receipt.id && entry.currentHash === receipt.currentHash)
    ) {
      throw new Error(
        `[TENANT_SCOPE_AUDIT_REQUIRED] failed to persist tenant selection audit for '${tenant.profile.tenant_slug}'`
      );
    }
  }
  const organizationId = currentExecutionScope()?.organizationId;
  return withExecutionContext(
    'sovereign_concierge',
    fn,
    undefined,
    tenant.profile.tenant_slug,
    organizationId
  );
}

export function optionalDecidedBy(argv: string[]): HumanDecidedBy | undefined {
  return resolveDecidedByFromArgv(argv);
}
