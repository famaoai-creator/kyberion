#!/usr/bin/env node

/**
 * Plan or apply the one-way move from flat tenant records to physical tenant
 * namespaces. Legacy records are quarantined instead of being assigned to a
 * tenant by inference.
 *
 * Usage:
 *   pnpm migrate:physical-namespaces -- --dry-run
 *   pnpm migrate:physical-namespaces -- --kind surface --apply
 *   pnpm migrate:physical-namespaces -- --kind intent --dry-run
 *   pnpm migrate:physical-namespaces -- --kind promotion --apply
 */

import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { physicalScopedPath } from '@agent/core/physical-namespace';
import { resolveScopeForRecord } from '@agent/core/scope-migration';
import { normalizeEventScope, type EventScope } from '@agent/core/event-scope';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  assertSafeRepositoryPath,
  safeMkdir,
  safeMoveSync,
  safeReaddir,
  safeLstat,
  safeWriteFile,
} from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { isRecord, nowIso, readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from './lib/json-input.js';

type Print = (value: unknown) => void;

const AUTHORITY_ROLE = 'physical_namespace_migration';
const MIGRATION_ROOT = 'active/shared/runtime/migrations/physical-namespace';
const QUARANTINE_ROOT = `${MIGRATION_ROOT}/quarantine`;
const SCHEDULE_ROOT = 'active/shared/runtime/media-generation/schedules';
const SURFACE_ROOT = 'active/shared/coordination/channels';
const PRESENCE_ROOT = 'active/shared/runtime/presence';
const FEEDBACK_ROOT = 'active/shared/runtime/feedback-loop';
const INTENT_ROOT = 'active/shared/runtime';
const INTENT_FILE = 'intent-contract-memory.json';
const PROMOTION_FILE = 'promotion-queue.jsonl';
const LEDGER_ROOT = 'knowledge/confidential';
const LEDGER_FILE = '_ledger/assets.jsonl';

type MigrationKind = 'schedule' | 'surface' | 'feedback' | 'intent' | 'ledger' | 'promotion';
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
  summary: {
    by_disposition: Record<PlanDisposition, number>;
    by_scope_disposition: Record<string, number>;
  };
  status?: 'planned' | 'applying' | 'completed' | 'failed';
  completed_at?: string;
  failure?: string;
}

function listJsonFiles(root: string): string[] {
  const safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true });
  if (!safeExistsSync(safeRoot) || !safeLstat(safeRoot).isDirectory()) return [];
  return safeReaddir(safeRoot)
    .sort()
    .flatMap((name) => {
      if (name === '.quarantine' || name === 'tenants') return [];
      const logicalPath = path.join(safeRoot, name);
      try {
        const safePath = assertSafeRepositoryPath(logicalPath);
        const stat = safeLstat(safePath);
        if (stat.isDirectory()) return listJsonFiles(safePath);
        return stat.isFile() && name.endsWith('.json') ? [safePath] : [];
      } catch {
        return [];
      }
    });
}

function listSurfaceFiles(): string[] {
  const files: string[] = [];
  const surfaceRoot = assertSafeRepositoryPath(SURFACE_ROOT, { allowMissingLeaf: true });
  if (safeExistsSync(surfaceRoot) && safeLstat(surfaceRoot).isDirectory()) {
    for (const surface of safeReaddir(surfaceRoot)) {
      if (surface === 'tenants' || surface === '.quarantine') continue;
      const surfacePath = path.join(surfaceRoot, surface);
      let safeSurfacePath: string;
      try {
        safeSurfacePath = assertSafeRepositoryPath(surfacePath);
      } catch {
        continue;
      }
      if (!safeExistsSync(safeSurfacePath) || !safeLstat(safeSurfacePath).isDirectory()) continue;
      for (const recordKind of [
        'requests',
        'notifications',
        'outbox',
        'dead-letter',
        'dead-targets',
      ]) {
        const recordRoot = path.join(safeSurfacePath, recordKind);
        files.push(...listJsonFiles(recordRoot));
      }
    }
  }
  for (const recordKind of ['requests', 'notifications']) {
    files.push(...listJsonFiles(path.join(PRESENCE_ROOT, recordKind)));
  }
  return files;
}

function listFeedbackFiles(root: string): string[] {
  const safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true });
  if (!safeExistsSync(safeRoot) || !safeLstat(safeRoot).isDirectory()) return [];
  return safeReaddir(safeRoot)
    .sort()
    .flatMap((name) => {
      if (name === 'tenants' || name === '.quarantine') return [];
      const logicalPath = path.join(safeRoot, name);
      try {
        const safePath = assertSafeRepositoryPath(logicalPath);
        const stat = safeLstat(safePath);
        if (stat.isDirectory()) return listFeedbackFiles(safePath);
        return stat.isFile() && name.endsWith('.jsonl') ? [safePath] : [];
      } catch {
        return [];
      }
    });
}

function listIntentFiles(): string[] {
  const source = path.join(INTENT_ROOT, INTENT_FILE);
  try {
    const safeSource = assertSafeRepositoryPath(source);
    return safeLstat(safeSource).isFile() ? [safeSource] : [];
  } catch {
    return [];
  }
}

function listLedgerFiles(): string[] {
  const source = path.join(LEDGER_ROOT, LEDGER_FILE);
  try {
    const safeSource = assertSafeRepositoryPath(source);
    return safeLstat(safeSource).isFile() ? [safeSource] : [];
  } catch {
    return [];
  }
}

function listPromotionFiles(): string[] {
  const source = pathResolver.rootResolve(`active/shared/runtime/memory/${PROMOTION_FILE}`);
  try {
    const safeSource = assertSafeRepositoryPath(source);
    return safeLstat(safeSource).isFile() ? [safeSource] : [];
  } catch {
    return [];
  }
}

function requireRegularMigrationFile(source: string): string {
  const safeSource = assertSafeRepositoryPath(source);
  if (!safeLstat(safeSource).isFile()) {
    throw new Error(`[physical-namespace-migration] source must be a regular file: ${source}`);
  }
  return safeSource;
}

function candidates(kind: MigrationKind): Candidate[] {
  const roots =
    kind === 'schedule'
      ? [{ root: SCHEDULE_ROOT, files: listJsonFiles(SCHEDULE_ROOT) }]
      : kind === 'surface'
        ? [{ root: SURFACE_ROOT, files: listSurfaceFiles() }]
        : kind === 'feedback'
          ? [{ root: FEEDBACK_ROOT, files: listFeedbackFiles(FEEDBACK_ROOT) }]
          : kind === 'intent'
            ? [{ root: INTENT_ROOT, files: listIntentFiles() }]
            : kind === 'ledger'
              ? [{ root: LEDGER_ROOT, files: listLedgerFiles() }]
              : [
                  {
                    root: path.dirname(pathResolver.rootResolve('active/shared/runtime/memory')),
                    files: listPromotionFiles(),
                  },
                ];
  return roots.flatMap(({ root, files }) =>
    files.map((source) => ({
      kind,
      source,
      base:
        kind === 'schedule' || kind === 'intent'
          ? root
          : kind === 'ledger'
            ? LEDGER_ROOT
            : kind === 'promotion'
              ? path.dirname(pathResolver.rootResolve('active/shared/runtime/memory'))
              : path.dirname(path.dirname(source)),
      ...(kind === 'surface' ? { record_dir: path.basename(path.dirname(source)) } : {}),
      ...(kind === 'ledger' ? { record_dir: '_ledger' } : {}),
      role: AUTHORITY_ROLE,
    }))
  );
}

function safeRecordName(source: string): string {
  return path.basename(source).replace(/[^A-Za-z0-9._-]/g, '_');
}

function hashFile(source: string): string {
  return createHash('sha256')
    .update(readTextFile(requireRegularMigrationFile(source)))
    .digest('hex');
}

function parseMigrationJsonObject(raw: string, label: string): Record<string, unknown> {
  return parseSafeJsonObjectValue(parseSafeJsonInput(raw, label), label);
}

function scopeFromRecord(record: unknown): ReturnType<typeof resolveScopeForRecord> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { disposition: 'invalid' };
  }
  return resolveScopeForRecord(record as Record<string, unknown>);
}

function destinationFor(item: Candidate, scope: EventScope): string {
  if (scope.tenant_slug) {
    // Knowledge tenant roots are the canonical logical namespace
    // knowledge/confidential/{tenant}; runtime/surface records use the
    // physical `tenants/{tenant}` namespace instead.
    if (item.kind === 'ledger') {
      return path.posix.join(
        LEDGER_ROOT,
        scope.tenant_slug,
        ...(item.record_dir ? [item.record_dir] : []),
        path.basename(item.source)
      );
    }
    return physicalScopedPath(
      item.base,
      scope,
      ...(item.record_dir ? [item.record_dir] : []),
      path.basename(item.source)
    );
  }
  return item.source;
}

function feedbackScopes(source: string): {
  disposition: 'canonical' | 'unscoped-legacy' | 'invalid';
  scope?: EventScope;
  reason?: string;
} {
  const lines = readTextFile(requireRegularMigrationFile(source))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { disposition: 'invalid', reason: 'feedback file is empty' };
  const scopes: EventScope[] = [];
  let unscoped = 0;
  for (const line of lines) {
    try {
      const record = parseMigrationJsonObject(line, 'feedback record');
      const result = scopeFromRecord(record);
      if (result.disposition === 'canonical' || result.disposition === 'mission-derived') {
        if (!result.scope?.tenant_slug) {
          return {
            disposition: 'invalid',
            reason: 'feedback record has a scope but no tenant_slug',
          };
        }
        scopes.push(normalizeEventScope(result.scope));
      } else if (result.disposition === 'unscoped-legacy') {
        unscoped += 1;
      } else {
        return { disposition: 'invalid', reason: 'feedback record has invalid scope' };
      }
    } catch (error) {
      return {
        disposition: 'invalid',
        reason: `feedback record unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (unscoped > 0 && scopes.length > 0) {
    return {
      disposition: 'invalid',
      reason: 'feedback file mixes scoped and unscoped records; refusing partial migration',
    };
  }
  if (unscoped === lines.length) {
    return {
      disposition: 'unscoped-legacy',
      reason: 'legacy feedback has no authoritative tenant scope; quarantine required',
    };
  }
  const tenantSlugs = new Set(scopes.map((scope) => scope.tenant_slug));
  if (tenantSlugs.size !== 1) {
    return {
      disposition: 'invalid',
      reason: 'feedback file contains multiple tenants; refusing to merge them into one file',
    };
  }
  return { disposition: 'canonical', scope: scopes[0] };
}

function intentScopes(source: string): {
  disposition: 'canonical' | 'unscoped-legacy' | 'invalid';
  scope?: EventScope;
  reason?: string;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseMigrationJsonObject(
      readTextFile(requireRegularMigrationFile(source)),
      'intent memory'
    );
  } catch (error) {
    return {
      disposition: 'invalid',
      reason: `intent memory unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!Array.isArray(parsed.entries)) {
    return { disposition: 'invalid', reason: 'intent memory entries array is missing' };
  }
  const entries = parsed.entries;
  if (entries.length === 0) {
    return {
      disposition: 'unscoped-legacy',
      reason: 'intent memory has no tenant-bearing entries; global seed remains authoritative',
    };
  }
  const scopes: EventScope[] = [];
  let unscoped = 0;
  for (const entry of entries) {
    const result = scopeFromRecord(entry);
    if (result.disposition === 'canonical' || result.disposition === 'mission-derived') {
      if (!result.scope?.tenant_slug) {
        return { disposition: 'invalid', reason: 'intent entry scope has no tenant_slug' };
      }
      scopes.push(normalizeEventScope(result.scope));
    } else if (result.disposition === 'unscoped-legacy') {
      unscoped += 1;
    } else {
      return { disposition: 'invalid', reason: 'intent entry has invalid scope' };
    }
  }
  if (unscoped > 0 && scopes.length > 0) {
    return { disposition: 'invalid', reason: 'intent memory mixes scoped and unscoped entries' };
  }
  if (unscoped === entries.length) {
    return {
      disposition: 'unscoped-legacy',
      reason: 'intent memory entries have no authoritative tenant scope; quarantine required',
    };
  }
  const tenants = new Set(scopes.map((scope) => scope.tenant_slug));
  if (tenants.size !== 1) {
    return { disposition: 'invalid', reason: 'intent memory contains multiple tenants' };
  }
  return { disposition: 'canonical', scope: scopes[0] };
}

function ledgerScopes(source: string): {
  disposition: 'canonical' | 'unscoped-legacy' | 'invalid';
  scope?: EventScope;
  reason?: string;
} {
  const lines = readTextFile(requireRegularMigrationFile(source))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { disposition: 'invalid', reason: 'ledger is empty' };
  const scopes: EventScope[] = [];
  let unscoped = 0;
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = parseMigrationJsonObject(line, 'ledger record');
    } catch (error) {
      return {
        disposition: 'invalid',
        reason: `ledger record unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const target = typeof record.target_path === 'string' ? record.target_path : '';
    const match = target.replace(/\\/g, '/').match(/^knowledge\/confidential\/([^/]+)\//u);
    if (
      record.visible_to !== undefined &&
      (!Array.isArray(record.visible_to) ||
        !record.visible_to.every((value) => typeof value === 'string'))
    ) {
      return { disposition: 'invalid', reason: 'ledger visible_to must be a string array' };
    }
    const visibleTo = Array.isArray(record.visible_to)
      ? record.visible_to.map((value) => value.trim()).filter(Boolean)
      : [];
    const tenant = match?.[1] || (visibleTo.length === 1 ? visibleTo[0] : undefined);
    if (tenant) {
      scopes.push(normalizeEventScope({ tier: 'confidential', tenant_slug: tenant }));
    } else {
      unscoped += 1;
    }
  }
  if (unscoped > 0 && scopes.length > 0) {
    return { disposition: 'invalid', reason: 'ledger mixes scoped and unscoped records' };
  }
  if (unscoped === lines.length) {
    return {
      disposition: 'unscoped-legacy',
      reason: 'ledger records have no authoritative tenant scope',
    };
  }
  const tenants = new Set(scopes.map((scope) => scope.tenant_slug));
  if (tenants.size !== 1)
    return { disposition: 'invalid', reason: 'ledger contains multiple tenants' };
  return { disposition: 'canonical', scope: scopes[0] };
}

function promotionScopes(source: string): {
  disposition: 'canonical' | 'unscoped-legacy' | 'invalid';
  scope?: EventScope;
  reason?: string;
} {
  const lines = readTextFile(requireRegularMigrationFile(source))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { disposition: 'invalid', reason: 'promotion queue is empty' };
  let unscoped = 0;
  let scoped = 0;
  for (const line of lines) {
    try {
      const candidate = parseMigrationJsonObject(line, 'promotion record');
      if (candidate.scope !== undefined && !isRecord(candidate.scope)) {
        return { disposition: 'invalid', reason: 'promotion scope must be a JSON object' };
      }
      if (candidate.scope !== undefined) scoped += 1;
      else unscoped += 1;
    } catch (error) {
      return {
        disposition: 'invalid',
        reason: `promotion record unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (unscoped > 0 && scoped > 0) {
    return {
      disposition: 'invalid',
      reason: 'promotion queue mixes scoped and unscoped records; refusing partial migration',
    };
  }
  return unscoped > 0
    ? {
        disposition: 'unscoped-legacy',
        reason: 'promotion candidates have no authoritative tenant scope; quarantine required',
      }
    : { disposition: 'canonical' };
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
    if (
      candidate.kind === 'feedback' ||
      candidate.kind === 'intent' ||
      candidate.kind === 'ledger' ||
      candidate.kind === 'promotion'
    ) {
      const result =
        candidate.kind === 'feedback'
          ? feedbackScopes(candidate.source)
          : candidate.kind === 'intent'
            ? intentScopes(candidate.source)
            : candidate.kind === 'ledger'
              ? ledgerScopes(candidate.source)
              : promotionScopes(candidate.source);
      if (candidate.kind === 'promotion' && result.disposition === 'canonical') {
        items.push({
          kind,
          source: candidate.source,
          destination: candidate.source,
          disposition: 'unchanged',
          scope_disposition: result.disposition,
          sha256: hashFile(candidate.source),
          reason: 'all promotion candidates already carry a scope envelope',
        });
        continue;
      }
      if (result.disposition === 'canonical' && result.scope) {
        const scope = result.scope;
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
          scope_disposition: result.disposition,
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
        scope_disposition: result.disposition,
        sha256: hashFile(candidate.source),
        reason: result.reason || `${candidate.kind} scope could not be migrated safely`,
      });
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = parseMigrationJsonObject(
        readTextFile(requireRegularMigrationFile(candidate.source)),
        `${candidate.kind} record`
      );
    } catch (error) {
      items.push({
        kind,
        source: candidate.source,
        destination: quarantineFor(candidate, migrationId),
        disposition: 'quarantine',
        scope_disposition: 'invalid',
        sha256: hashFile(candidate.source),
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
      sha256: hashFile(candidate.source),
      reason: 'scope is absent or invalid; tenant ownership was not inferred',
    });
  }
  const plan: MigrationPlan = {
    migration_id: migrationId,
    generated_at: nowIso(),
    apply,
    status: 'planned',
    items,
    summary: {
      by_disposition: {
        unchanged: items.filter((item) => item.disposition === 'unchanged').length,
        move: items.filter((item) => item.disposition === 'move').length,
        quarantine: items.filter((item) => item.disposition === 'quarantine').length,
        conflict: items.filter((item) => item.disposition === 'conflict').length,
      },
      by_scope_disposition: items.reduce<Record<string, number>>((counts, item) => {
        counts[item.scope_disposition] = (counts[item.scope_disposition] || 0) + 1;
        return counts;
      }, {}),
    },
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
      plan.completed_at = nowIso();
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
  if (
    kindValue &&
    kindValue !== 'schedule' &&
    kindValue !== 'surface' &&
    kindValue !== 'feedback' &&
    kindValue !== 'intent' &&
    kindValue !== 'ledger' &&
    kindValue !== 'promotion' &&
    kindValue !== 'all'
  ) {
    throw new Error(`Unsupported --kind: ${kindValue}`);
  }
  return {
    kind:
      kindValue === 'schedule' ||
      kindValue === 'surface' ||
      kindValue === 'feedback' ||
      kindValue === 'intent' ||
      kindValue === 'ledger'
        ? kindValue
        : kindValue === 'promotion'
          ? kindValue
          : 'all',
    apply: argv.includes('--apply'),
  };
}

export function main(argv: string[], print: Print = () => undefined): void {
  const options = parseArgs(argv);
  const kinds: MigrationKind[] =
    options.kind === 'all'
      ? ['schedule', 'surface', 'feedback', 'intent', 'ledger', 'promotion']
      : [options.kind];
  const plans = withExecutionContext(AUTHORITY_ROLE, () =>
    kinds.map((kind) => buildPlan(kind, options.apply))
  );
  print(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', plans }, null, 2));
}

const script = defineScript({
  name: 'migrate:physical-namespaces',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'migrate_physical_namespaces.ts') ||
  isDirectScript(import.meta.url, 'migrate_physical_namespaces.js')
) {
  void script();
}

export { buildPlan, feedbackScopes, intentScopes, ledgerScopes, promotionScopes, parseArgs };
