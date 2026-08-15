#!/usr/bin/env node

/**
 * Plan or apply the one-way move from flat tenant records to physical tenant
 * namespaces. Legacy records are quarantined instead of being assigned to a
 * tenant by inference.
 *
 * Usage:
 *   pnpm migrate:physical-namespaces -- --dry-run
 *   pnpm migrate:physical-namespaces -- --kind surface --apply
 */

import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  physicalScopedPath,
  resolveScopeForRecord,
  normalizeEventScope,
  type EventScope,
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
const MIGRATION_ROOT = 'active/shared/runtime/migrations/physical-namespace';
const QUARANTINE_ROOT = `${MIGRATION_ROOT}/quarantine`;
const SCHEDULE_ROOT = 'active/shared/runtime/media-generation/schedules';
const SURFACE_ROOT = 'active/shared/coordination/channels';
const PRESENCE_ROOT = 'active/shared/runtime/presence';

type MigrationKind = 'schedule' | 'surface';
type MigrationSelection = MigrationKind | 'all';
type PlanDisposition = 'unchanged' | 'move' | 'quarantine' | 'conflict';

interface Candidate {
  kind: MigrationKind;
  source: string;
  base: string;
  record_dir?: string;
  role: typeof AUTHORITY_ROLE;
}

interface PlanItem {
  kind: MigrationKind;
  source: string;
  destination: string;
  disposition: PlanDisposition;
  scope_disposition: string;
  tenant_slug?: string;
  sha256?: string;
  destination_sha256?: string;
  reason?: string;
  state?: 'planned' | 'applied';
}

interface MigrationPlan {
  migration_id: string;
  generated_at: string;
  apply: boolean;
  items: PlanItem[];
  status?: 'planned' | 'applying' | 'completed' | 'failed';
  completed_at?: string;
  failure?: string;
}

function listJsonFiles(root: string): string[] {
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root)
    .sort()
    .flatMap((name) => {
      if (name === '.quarantine' || name === 'tenants') return [];
      const logicalPath = path.join(root, name);
      const stat = safeStat(logicalPath);
      if (stat.isDirectory()) return listJsonFiles(logicalPath);
      return stat.isFile() && name.endsWith('.json') ? [logicalPath] : [];
    });
}

function listSurfaceFiles(): string[] {
  const files: string[] = [];
  if (safeExistsSync(SURFACE_ROOT)) {
    for (const surface of safeReaddir(SURFACE_ROOT)) {
      if (surface === 'tenants' || surface === '.quarantine') continue;
      const surfaceRoot = path.join(SURFACE_ROOT, surface);
      if (!safeExistsSync(surfaceRoot) || !safeStat(surfaceRoot).isDirectory()) continue;
      for (const recordKind of [
        'requests',
        'notifications',
        'outbox',
        'dead-letter',
        'dead-targets',
      ]) {
        const recordRoot = path.join(surfaceRoot, recordKind);
        files.push(...listJsonFiles(recordRoot));
      }
    }
  }
  for (const recordKind of ['requests', 'notifications']) {
    files.push(...listJsonFiles(path.join(PRESENCE_ROOT, recordKind)));
  }
  return files;
}

function candidates(kind: MigrationKind): Candidate[] {
  const roots =
    kind === 'schedule'
      ? [{ root: SCHEDULE_ROOT, files: listJsonFiles(SCHEDULE_ROOT) }]
      : [{ root: SURFACE_ROOT, files: listSurfaceFiles() }];
  return roots.flatMap(({ root, files }) =>
    files.map((source) => ({
      kind,
      source,
      base: kind === 'schedule' ? root : path.dirname(path.dirname(source)),
      ...(kind === 'surface' ? { record_dir: path.basename(path.dirname(source)) } : {}),
      role: AUTHORITY_ROLE,
    }))
  );
}

function safeRecordName(source: string): string {
  return path.basename(source).replace(/[^A-Za-z0-9._-]/g, '_');
}

function hashFile(source: string): string {
  return createHash('sha256')
    .update(String(safeReadFile(source, { encoding: 'utf8' })))
    .digest('hex');
}

function scopeFromRecord(record: unknown): ReturnType<typeof resolveScopeForRecord> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { disposition: 'invalid' };
  }
  return resolveScopeForRecord(record as Record<string, unknown>);
}

function destinationFor(item: Candidate, scope: EventScope): string {
  if (scope.tenant_slug) {
    return physicalScopedPath(
      item.base,
      scope,
      ...(item.record_dir ? [item.record_dir] : []),
      path.basename(item.source)
    );
  }
  return item.source;
}

function quarantineFor(item: Candidate, migrationId: string): string {
  const relativeSource = path.relative(item.base, item.source);
  const sourceLabel = relativeSource.replace(/[\\/]+/g, '-');
  return path.join(
    QUARANTINE_ROOT,
    item.kind,
    `${migrationId}-${safeRecordName(sourceLabel)}.quarantined`
  );
}

function buildPlan(kind: MigrationKind, apply: boolean): MigrationPlan {
  const migrationId = `physical-ns-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const items: PlanItem[] = [];
  for (const candidate of candidates(kind)) {
    let record: unknown;
    try {
      record = JSON.parse(String(safeReadFile(candidate.source, { encoding: 'utf8' })));
    } catch (error) {
      items.push({
        kind,
        source: candidate.source,
        destination: quarantineFor(candidate, migrationId),
        disposition: 'quarantine',
        scope_disposition: 'invalid',
        reason: `record unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const scopeResult = scopeFromRecord(record);
    if (scopeResult.disposition === 'canonical' || scopeResult.disposition === 'mission-derived') {
      const scope = normalizeEventScope(scopeResult.scope!);
      const destination = destinationFor(candidate, scope);
      const disposition: PlanDisposition =
        destination === candidate.source
          ? 'unchanged'
          : safeExistsSync(destination)
            ? 'conflict'
            : 'move';
      items.push({
        kind,
        source: candidate.source,
        destination,
        disposition,
        scope_disposition: scopeResult.disposition,
        ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
        sha256: hashFile(candidate.source),
        ...(disposition === 'conflict'
          ? { reason: 'destination already exists; no overwrite performed' }
          : {}),
      });
      continue;
    }

    items.push({
      kind,
      source: candidate.source,
      destination: quarantineFor(candidate, migrationId),
      disposition: 'quarantine',
      scope_disposition: scopeResult.disposition,
      reason: 'scope is absent or invalid; tenant ownership was not inferred',
    });
  }
  const plan: MigrationPlan = {
    migration_id: migrationId,
    generated_at: new Date().toISOString(),
    apply,
    status: 'planned',
    items,
  };
  if (apply) applyPlan(plan);
  return plan;
}

function migrationManifestPath(plan: MigrationPlan): string {
  return `${MIGRATION_ROOT}/manifests/${plan.migration_id}.json`;
}

function persistMigrationManifest(plan: MigrationPlan): void {
  const manifestPath = migrationManifestPath(plan);
  safeMkdir(path.dirname(manifestPath), { recursive: true });
  safeWriteFile(manifestPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8' });
}

function applyPlan(plan: MigrationPlan): void {
  withExecutionContext(AUTHORITY_ROLE, () => {
    plan.status = 'applying';
    persistMigrationManifest(plan);
    try {
      for (const item of plan.items) {
        if (item.disposition !== 'move' && item.disposition !== 'quarantine') continue;
        if (safeExistsSync(item.destination)) {
          throw new Error(`[PHYSICAL_NAMESPACE_DESTINATION_EXISTS] ${item.destination}`);
        }
        safeMkdir(path.dirname(item.destination), { recursive: true });
        safeMoveSync(item.source, item.destination);
        if (item.sha256) {
          item.destination_sha256 = hashFile(item.destination);
          if (item.destination_sha256 !== item.sha256) {
            throw new Error(`[PHYSICAL_NAMESPACE_HASH_MISMATCH] ${item.destination}`);
          }
        }
        item.state = 'applied';
        persistMigrationManifest(plan);
      }
      plan.status = 'completed';
      plan.completed_at = new Date().toISOString();
      persistMigrationManifest(plan);
    } catch (error) {
      plan.status = 'failed';
      plan.failure = error instanceof Error ? error.message : String(error);
      persistMigrationManifest(plan);
      throw error;
    }
  });
}

function parseArgs(argv: string[]): { kind: MigrationSelection; apply: boolean } {
  const kindValue = argv[argv.indexOf('--kind') + 1];
  if (kindValue && kindValue !== 'schedule' && kindValue !== 'surface' && kindValue !== 'all') {
    throw new Error(`Unsupported --kind: ${kindValue}`);
  }
  return {
    kind: kindValue === 'schedule' || kindValue === 'surface' ? kindValue : 'all',
    apply: argv.includes('--apply'),
  };
}

const isDirect = process.argv[1] && /migrate_physical_namespaces\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  const options = parseArgs(process.argv.slice(2));
  const kinds: MigrationKind[] = options.kind === 'all' ? ['schedule', 'surface'] : [options.kind];
  const plans = withExecutionContext(AUTHORITY_ROLE, () =>
    kinds.map((kind) => buildPlan(kind, options.apply))
  );
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', plans }, null, 2));
}

export { buildPlan, parseArgs };
