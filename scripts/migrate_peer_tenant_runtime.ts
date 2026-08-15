#!/usr/bin/env node

/**
 * One-way migration for the legacy flat peer / Mesh Hub runtime roots.
 *
 * The legacy roots are not read by the tenant-aware runtime. This command
 * splits JSONL records by their explicit tenant id, moves JSON records to the
 * tenant namespace, and quarantines the original source. Records without a
 * trustworthy tenant are never inferred; they remain in the quarantined
 * source unless an operator supplies an explicit --tenant-id override.
 */

import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  isValidTenantSlug,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';

const AUTHORITY_ROLE = 'physical_namespace_migration';
const DEFAULT_MIGRATION_ROOT = 'active/shared/runtime/migrations/peer-tenant';

export type PeerTenantMigrationKind =
  'peer-messaging' | 'peer-conversations' | 'mesh-hub-runtime' | 'mesh-hub-observability';

export interface PeerTenantMigrationRoot {
  kind: PeerTenantMigrationKind;
  root: string;
}

export interface PeerTenantMigrationOptions {
  apply?: boolean;
  tenantIdOverride?: string;
  migrationId?: string;
  migrationRoot?: string;
  legacyRoots?: PeerTenantMigrationRoot[];
  planPath?: string;
}

interface ParsedRow {
  raw: string;
  record?: unknown;
}

interface SourceItem {
  source: string;
  source_quarantine: string;
  kind: PeerTenantMigrationKind;
  source_sha256: string;
  action: 'migrate' | 'quarantine';
  unknown_record_count: number;
  records: number;
  destinations: Array<{
    tenant_id: string;
    destination: string;
    record_count: number;
    disposition: 'move' | 'conflict';
    destination_sha256?: string;
  }>;
  state: 'planned' | 'applied';
  reason?: string;
}

export interface PeerTenantMigrationPlan {
  format: 'kyberion-peer-tenant-migration-v1';
  migration_id: string;
  generated_at: string;
  apply_requested: boolean;
  tenant_id_override?: string;
  migration_root: string;
  sources: SourceItem[];
  status: 'planned' | 'applying' | 'completed' | 'failed';
  completed_at?: string;
  failure?: string;
}

const DEFAULT_ROOTS: PeerTenantMigrationRoot[] = [
  { kind: 'peer-messaging', root: 'active/shared/runtime/peer-messaging' },
  { kind: 'peer-conversations', root: 'active/shared/runtime/peer-conversations' },
  { kind: 'mesh-hub-runtime', root: 'active/shared/runtime/mesh-hub' },
  { kind: 'mesh-hub-observability', root: 'active/shared/observability/mesh-hub' },
];

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'record';
}

function normalizeTenant(value: string | undefined): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (!isValidTenantSlug(normalized)) {
    throw new Error(`peer_migration_invalid_tenant_override:${normalized}`);
  }
  return normalized;
}

function listLegacyFiles(root: string, relative = ''): string[] {
  const current = relative ? path.join(root, relative) : root;
  if (!safeExistsSync(current) || !safeStat(current).isDirectory()) return [];
  return safeReaddir(current)
    .filter((entry) => entry !== 'tenants' && entry !== '.quarantine')
    .sort()
    .flatMap((entry) => {
      const childRelative = relative ? path.join(relative, entry) : entry;
      const child = path.join(root, childRelative);
      const stat = safeStat(child);
      if (stat.isDirectory()) return listLegacyFiles(root, childRelative);
      return stat.isFile() && /\.(json|jsonl)$/u.test(entry) ? [child] : [];
    });
}

function parseRows(source: string): ParsedRow[] {
  const raw = String(safeReadFile(source, { encoding: 'utf8' }) || '');
  if (source.endsWith('.jsonl')) {
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return { raw: line, record: JSON.parse(line) as unknown };
        } catch {
          return { raw: line };
        }
      });
  }
  try {
    return [{ raw: raw.trim(), record: JSON.parse(raw) as unknown }];
  } catch {
    return [{ raw: raw.trim() }];
  }
}

function nested(record: unknown, ...keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function recordTenant(record: unknown): string | undefined {
  const candidates = [
    nested(record, 'tenant_id'),
    nested(record, 'tenant_scope', 'tenant_id'),
    nested(record, 'envelope', 'tenant_id'),
    nested(record, 'message', 'tenant_id'),
    nested(record, 'session', 'tenant_id'),
    nested(record, 'request', 'tenant_scope', 'tenant_id'),
    nested(record, 'payload', 'tenant_id'),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1 || !isValidTenantSlug(unique[0])) return undefined;
  return unique[0];
}

function relativeSource(root: string, source: string): string {
  return path.relative(root, source).split(path.sep).join('/');
}

function destinationFor(root: PeerTenantMigrationRoot, source: string, tenantId: string): string {
  const parts = relativeSource(root.root, source).split('/').filter(Boolean);
  if (root.kind === 'peer-messaging' || root.kind === 'peer-conversations') {
    const peerId = parts.shift() || 'legacy-peer';
    return path.join(root.root, 'tenants', tenantId, 'peers', peerId, ...parts);
  }

  const namespace = parts.length > 1 ? parts.shift() : undefined;
  return path.join(root.root, ...(namespace ? [namespace] : []), 'tenants', tenantId, ...parts);
}

function sourceQuarantinePath(
  migrationRoot: string,
  migrationId: string,
  root: PeerTenantMigrationRoot,
  source: string
): string {
  const relative = relativeSource(root.root, source);
  return path.join(
    migrationRoot,
    'quarantine',
    migrationId,
    root.kind,
    `${safeName(relative)}.legacy`
  );
}

function buildSourceItem(
  root: PeerTenantMigrationRoot,
  source: string,
  options: Required<Pick<PeerTenantMigrationOptions, 'migrationId' | 'migrationRoot'>> & {
    tenantIdOverride?: string;
  }
): SourceItem {
  const raw = String(safeReadFile(source, { encoding: 'utf8' }) || '');
  const rows = parseRows(source);
  const byTenant = new Map<string, ParsedRow[]>();
  let unknown = 0;
  for (const row of rows) {
    const tenant = recordTenant(row.record) || options.tenantIdOverride;
    if (!tenant) {
      unknown += 1;
      continue;
    }
    const bucket = byTenant.get(tenant) || [];
    bucket.push(row);
    byTenant.set(tenant, bucket);
  }

  const sourceQuarantine = sourceQuarantinePath(
    options.migrationRoot,
    options.migrationId,
    root,
    source
  );
  const destinations = [...byTenant.entries()].map(([tenantId, bucket]) => {
    const destination = destinationFor(root, source, tenantId);
    return {
      tenant_id: tenantId,
      destination,
      record_count: bucket.length,
      disposition: safeExistsSync(destination) ? ('conflict' as const) : ('move' as const),
    };
  });

  return {
    source,
    source_quarantine: sourceQuarantine,
    kind: root.kind,
    source_sha256: sha256(raw),
    action: destinations.length ? 'migrate' : 'quarantine',
    unknown_record_count: unknown,
    records: rows.length,
    destinations,
    state: 'planned',
    ...(unknown && !options.tenantIdOverride
      ? { reason: 'tenant_id_missing_or_conflicting; source remains quarantined' }
      : {}),
  };
}

export function buildPeerTenantMigrationPlan(
  options: PeerTenantMigrationOptions = {}
): PeerTenantMigrationPlan {
  const migrationId =
    options.migrationId || `peer-tenant-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const migrationRoot = options.migrationRoot || DEFAULT_MIGRATION_ROOT;
  const tenantIdOverride = normalizeTenant(options.tenantIdOverride);
  const roots = options.legacyRoots || DEFAULT_ROOTS;
  const sources = roots.flatMap((root) =>
    listLegacyFiles(root.root).map((source) =>
      buildSourceItem(root, source, { migrationId, migrationRoot, tenantIdOverride })
    )
  );
  return {
    format: 'kyberion-peer-tenant-migration-v1',
    migration_id: migrationId,
    generated_at: nowIso(),
    apply_requested: Boolean(options.apply),
    ...(tenantIdOverride ? { tenant_id_override: tenantIdOverride } : {}),
    migration_root: migrationRoot,
    sources,
    status: 'planned',
  };
}

function manifestPath(plan: PeerTenantMigrationPlan): string {
  return path.join(plan.migration_root, 'manifests', `${plan.migration_id}.json`);
}

function persistPlan(plan: PeerTenantMigrationPlan): void {
  safeMkdir(path.dirname(manifestPath(plan)), { recursive: true });
  safeWriteFile(manifestPath(plan), `${JSON.stringify(plan, null, 2)}\n`);
}

function rowsForTenant(source: string, tenantId: string, override?: string): string[] {
  return parseRows(source)
    .filter((row) => (recordTenant(row.record) || override) === tenantId)
    .map((row) => row.raw);
}

export function applyPeerTenantMigrationPlan(
  plan: PeerTenantMigrationPlan
): PeerTenantMigrationPlan {
  return withExecutionContext(AUTHORITY_ROLE, () => {
    plan.status = 'applying';
    persistPlan(plan);
    try {
      for (const item of plan.sources) {
        if (!safeExistsSync(item.source))
          throw new Error(`peer_migration_source_missing:${item.source}`);
        const currentRaw = String(safeReadFile(item.source, { encoding: 'utf8' }) || '');
        if (sha256(currentRaw) !== item.source_sha256) {
          throw new Error(`peer_migration_source_changed:${item.source}`);
        }
        if (item.destinations.some((destination) => destination.disposition === 'conflict')) {
          throw new Error(`peer_migration_destination_conflict:${item.source}`);
        }
        if (item.action === 'migrate') {
          for (const destination of item.destinations) {
            const rows = rowsForTenant(item.source, destination.tenant_id, plan.tenant_id_override);
            safeMkdir(path.dirname(destination.destination), { recursive: true });
            const content = item.source.endsWith('.jsonl')
              ? `${rows.join('\n')}\n`
              : `${rows[0] || ''}\n`;
            safeWriteFile(destination.destination, content);
            destination.destination_sha256 = sha256(content);
          }
        }
        safeMkdir(path.dirname(item.source_quarantine), { recursive: true });
        safeMoveSync(item.source, item.source_quarantine);
        item.state = 'applied';
        persistPlan(plan);
      }
      plan.status = 'completed';
      plan.completed_at = nowIso();
      persistPlan(plan);
      return plan;
    } catch (error) {
      plan.status = 'failed';
      plan.failure = error instanceof Error ? error.message : String(error);
      persistPlan(plan);
      throw error;
    }
  });
}

export function runPeerTenantMigration(
  options: PeerTenantMigrationOptions = {}
): PeerTenantMigrationPlan {
  let plan: PeerTenantMigrationPlan;
  if (options.planPath) {
    try {
      plan = JSON.parse(
        String(safeReadFile(options.planPath, { encoding: 'utf8' }) || '')
      ) as PeerTenantMigrationPlan;
    } catch {
      throw new Error(`peer_migration_plan_invalid:${options.planPath}`);
    }
    if (plan.format !== 'kyberion-peer-tenant-migration-v1') {
      throw new Error(`peer_migration_plan_format_invalid:${options.planPath}`);
    }
  } else {
    plan = buildPeerTenantMigrationPlan(options);
  }
  if (options.apply) return applyPeerTenantMigrationPlan(plan);
  if (!options.planPath) withExecutionContext(AUTHORITY_ROLE, () => persistPlan(plan));
  return plan;
}

function parseArgs(argv: string[]): PeerTenantMigrationOptions {
  const tenantIndex = argv.indexOf('--tenant-id');
  const tenantIdOverride = tenantIndex >= 0 ? argv[tenantIndex + 1] : undefined;
  const rootIndex = argv.indexOf('--migration-root');
  const migrationRoot = rootIndex >= 0 ? argv[rootIndex + 1] : undefined;
  const planIndex = argv.indexOf('--plan');
  const planPath = planIndex >= 0 ? argv[planIndex + 1] : undefined;
  return {
    apply: argv.includes('--apply'),
    ...(tenantIdOverride ? { tenantIdOverride } : {}),
    ...(migrationRoot ? { migrationRoot } : {}),
    ...(planPath ? { planPath } : {}),
  };
}

const isDirect = process.argv[1] && /migrate_peer_tenant_runtime\.(ts|js)$/u.test(process.argv[1]);
if (isDirect) {
  try {
    const plan = runPeerTenantMigration(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { parseArgs };
