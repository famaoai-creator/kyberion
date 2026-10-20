import { randomUUID, createHash } from 'node:crypto';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import type { OrganizationWorkLoopSummary } from '../workforce/work-design.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import { physicalScopedPath, assertPhysicalScopeSegment } from '../physical-namespace.js';
import { isValidTenantSlug } from '../entity-scope.js';
import * as path from 'node:path';

export interface DistillCandidateRecord {
  candidate_id: string;
  source_type: 'task_session' | 'mission' | 'artifact';
  tier?: 'personal' | 'confidential' | 'public';
  project_id?: string;
  track_id?: string;
  track_name?: string;
  mission_id?: string;
  task_session_id?: string;
  artifact_ids?: string[];
  title: string;
  summary: string;
  status: 'proposed' | 'promoted' | 'archived';
  target_kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template' | 'procedure';
  specialist_id?: string;
  locale?: string;
  work_loop?: OrganizationWorkLoopSummary;
  promoted_ref?: string;
  evidence_refs?: string[];
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
  /** Canonical scope; absent only for legacy candidates. */
  scope?: MemoryScopeEnvelope;
}

const SCHEMA_PATH = pathResolver.knowledge('product/schemas/distill-candidate-record.schema.json');
const DISTILL_DIR = pathResolver.shared('runtime/distill-candidates');

export function distillCandidateRecordPath(
  candidateId: string,
  scope?: MemoryScopeEnvelope
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(candidateId))
    throw new Error('[DISTILL_CANDIDATE_INVALID] Invalid candidate id');
  if (!scope) return path.join(DISTILL_DIR, candidateId + '.json');
  const canonical = assertMemoryScope(scope);
  if (
    Object.entries(scope).some(
      ([field, value]) => value !== undefined && !Object.hasOwn(canonical, field)
    )
  )
    throw new Error('[DISTILL_SCOPE_UNSUPPORTED] Unknown scope fields cannot be dropped');
  const key = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  if (canonical.tier === 'personal') {
    if (!canonical.owner_nhi)
      throw new Error('[DISTILL_SCOPE_REQUIRED] Scoped records require a tenant or personal owner');
    const ownerKey = createHash('sha256').update(canonical.owner_nhi).digest('hex');
    return pathResolver.rootResolve(
      path.join(
        'active/personal/owners',
        ownerKey,
        'distill-candidates',
        key,
        candidateId + '.json'
      )
    );
  }
  if (!canonical.tenant_slug)
    throw new Error('[DISTILL_SCOPE_REQUIRED] Scoped records require a tenant or personal owner');
  return pathResolver.rootResolve(
    physicalScopedPath(
      'active/shared/runtime',
      canonical,
      'distill-candidates',
      canonical.tier,
      key,
      candidateId + '.json'
    )
  );
}

const distillCandidateRecordCatalog = defineCatalog<DistillCandidateRecord>({
  id: 'distill-candidate-record',
  path: DISTILL_DIR,
  schema: SCHEMA_PATH,
});

function distillCandidateRecordCatalogAtPath(filePath: string) {
  return defineCatalog<DistillCandidateRecord>({
    id: 'distill-candidate-record',
    path: filePath,
    schema: SCHEMA_PATH,
  });
}

let distillCandidateListCache: {
  fingerprint: string;
  records: DistillCandidateRecord[];
} | null = null;

function distillCandidateListFingerprint(entries: string[]): string {
  return entries
    .map((entry) => {
      const stats = safeLstat(`${DISTILL_DIR}/${entry}`);
      return `${entry}:${stats.mode}:${stats.size}:${stats.mtimeMs}`;
    })
    .join('|');
}

export function createDistillCandidateRecord(
  input: Omit<DistillCandidateRecord, 'candidate_id' | 'created_at' | 'updated_at'> & {
    candidate_id?: string;
  }
): DistillCandidateRecord {
  const now = nowIso();
  return {
    candidate_id:
      input.candidate_id ||
      `DSC-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    created_at: now,
    updated_at: now,
    ...input,
  };
}

export function validateDistillCandidateRecord(value: unknown): value is DistillCandidateRecord {
  try {
    distillCandidateRecordCatalog.validate(value);
    return true;
  } catch {
    return false;
  }
}

export function saveDistillCandidateRecord(record: DistillCandidateRecord): string {
  if (record.scope && record.tier && record.tier !== record.scope.tier)
    throw new Error('[DISTILL_SCOPE_MISMATCH] Record tier must match its storage scope');
  const filePath = distillCandidateRecordPath(record.candidate_id, record.scope);
  const updated: DistillCandidateRecord = {
    ...record,
    updated_at: nowIso(),
  };
  let validated: DistillCandidateRecord;
  try {
    validated = distillCandidateRecordCatalogAtPath(filePath).validate(updated, filePath);
  } catch (error) {
    throw new Error(
      `Invalid distill candidate record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!safeExistsSync(path.dirname(filePath)))
    safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  distillCandidateListCache = null;
  return filePath;
}

export function loadDistillCandidateRecord(
  candidateId: string,
  scope?: MemoryScopeEnvelope
): DistillCandidateRecord | null {
  const filePath = distillCandidateRecordPath(candidateId, scope);
  try {
    const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safeFilePath)) return null;
    if (!safeLstat(safeFilePath).isFile()) {
      throw new Error(`[DISTILL_CANDIDATE] record must be a regular file: ${filePath}`);
    }
    const row = distillCandidateRecordCatalogAtPath(safeFilePath).load();
    if (row.candidate_id !== candidateId || Boolean(row.scope) !== Boolean(scope)) return null;
    if (
      scope &&
      JSON.stringify(row.scope ? assertMemoryScope(row.scope) : null) !==
        JSON.stringify(assertMemoryScope(scope))
    )
      return null;
    return row;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid catalog ')) return null;
    throw error;
  }
}

export function listDistillCandidateRecords(scope?: MemoryScopeEnvelope): DistillCandidateRecord[] {
  if (scope) {
    const dir = path.dirname(distillCandidateRecordPath('scope-list', scope));
    if (!safeExistsSync(dir)) return [];
    return safeReaddir(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => loadDistillCandidateRecord(name.slice(0, -5), scope))
      .filter((row): row is DistillCandidateRecord => Boolean(row))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  if (!safeExistsSync(DISTILL_DIR)) {
    distillCandidateListCache = null;
    return [];
  }
  const entries = safeReaddir(DISTILL_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const fingerprint = distillCandidateListFingerprint(entries);
  if (distillCandidateListCache?.fingerprint === fingerprint) {
    return distillCandidateListCache.records.map((record) => structuredClone(record));
  }

  const records = entries
    .map((entry) => loadDistillCandidateRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is DistillCandidateRecord => Boolean(record))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  distillCandidateListCache = { fingerprint, records };
  return records.map((record) => structuredClone(record));
}

export function updateDistillCandidateRecord(
  candidateId: string,
  patch: Partial<Omit<DistillCandidateRecord, 'candidate_id' | 'created_at'>>,
  scope?: MemoryScopeEnvelope
): DistillCandidateRecord | null {
  const current = loadDistillCandidateRecord(candidateId, scope);
  if (!current) return null;
  if (
    Object.hasOwn(patch, 'scope') &&
    (!patch.scope ||
      JSON.stringify(assertMemoryScope(patch.scope)) !==
        JSON.stringify(current.scope ? assertMemoryScope(current.scope) : null))
  )
    throw new Error('[DISTILL_SCOPE_MISMATCH] Scope cannot change during update');
  const next: DistillCandidateRecord = {
    ...current,
    ...patch,
    ...(current.scope ? { scope: current.scope } : {}),
    candidate_id: current.candidate_id,
    created_at: current.created_at,
    updated_at: nowIso(),
  };
  saveDistillCandidateRecord(next);
  return next;
}

/** Explicit bounded discovery, separate from the legacy global reader.
 * Callers must derive these limits from a server-authenticated viewer; this is
 * a storage reader, not an authorization grant. Owner/audience checks remain
 * the caller's responsibility. Personal records are never enumerated here.
 */
export interface DistillCandidateTenantReadScope {
  tenantSlugs: readonly string[];
  organizationIds?: readonly string[] | 'all';
  projectIds?: readonly string[] | 'all';
  tierAccess: readonly ('public' | 'confidential' | 'personal')[];
}
export function listDistillCandidateRecordsForTenants(
  access: DistillCandidateTenantReadScope
): DistillCandidateRecord[] {
  const tenants = [...new Set(access.tenantSlugs)];
  if (tenants.some((tenant) => !isValidTenantSlug(tenant)))
    throw new Error('[DISTILL_SCOPE_INVALID] Invalid tenant boundary');
  const permits = (allowed: readonly string[] | 'all' | undefined, value?: string): boolean =>
    allowed === undefined || allowed === 'all' || Boolean(value && allowed.includes(value));
  for (const ids of [access.organizationIds, access.projectIds])
    if (ids && ids !== 'all') for (const id of ids) assertPhysicalScopeSegment(id, 'scope id');
  const tiers = [...new Set(access.tierAccess)].filter((tier) => tier !== 'personal');
  if (tiers.some((tier) => tier !== 'public' && tier !== 'confidential'))
    throw new Error('[DISTILL_SCOPE_INVALID] Invalid tier');
  const rows: DistillCandidateRecord[] = [];
  const directory = (file: string): boolean => {
    if (!safeExistsSync(file)) return false;
    const stat = safeLstat(file);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    assertSafeRepositoryPath(file, { allowMissingLeaf: true });
    return true;
  };
  const levels = [
    ['organization_id', 'organizations'],
    ['project_id', 'projects'],
    ['mission_id', 'missions'],
    ['task_id', 'tasks'],
    ['session_id', 'sessions'],
  ] as const;
  const walk = (dir: string, context: MemoryScopeEnvelope, firstLevel: number): void => {
    if (!directory(dir)) return;
    if (
      permits(access.organizationIds, context.organization_id) &&
      permits(access.projectIds, context.project_id)
    ) {
      const candidates = path.join(dir, 'distill-candidates');
      if (directory(candidates))
        for (const tier of tiers) {
          const tierDir = path.join(candidates, tier);
          if (!directory(tierDir)) continue;
          for (const key of safeReaddir(tierDir)) {
            if (!/^[a-f0-9]{64}$/.test(key)) continue;
            const scopeDir = path.join(tierDir, key);
            if (!directory(scopeDir)) continue;
            for (const name of safeReaddir(scopeDir)) {
              if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}\.json$/.test(name)) continue;
              const file = path.join(scopeDir, name);
              const stat = safeLstat(file);
              if (stat.isSymbolicLink() || !stat.isFile()) continue;
              let row: DistillCandidateRecord;
              try {
                row = distillCandidateRecordCatalogAtPath(file).load();
              } catch (error) {
                if (error instanceof Error && error.message.startsWith('Invalid catalog '))
                  continue;
                throw error;
              }
              if (
                !row.scope ||
                row.scope.tier !== tier ||
                row.scope.tenant_slug !== context.tenant_slug ||
                !permits(access.organizationIds, row.scope.organization_id) ||
                !permits(access.projectIds, row.scope.project_id)
              )
                continue;
              // Reject copied, forged, wrong-id, wrong-hash, and wrong-entity files.
              let expected: string;
              try {
                expected = distillCandidateRecordPath(row.candidate_id, row.scope);
              } catch {
                continue;
              }
              if (path.resolve(file) !== path.resolve(expected)) continue;
              rows.push(row);
            }
          }
        }
    }
    for (let index = firstLevel; index < levels.length; index++) {
      const [field, collection] = levels[index]!;
      const collectionDir = path.join(dir, collection);
      if (!directory(collectionDir)) continue;
      for (const id of safeReaddir(collectionDir)) {
        try {
          assertPhysicalScopeSegment(id, field);
        } catch {
          continue;
        }
        if (field === 'organization_id' && !permits(access.organizationIds, id)) continue;
        if (field === 'project_id' && !permits(access.projectIds, id)) continue;
        walk(path.join(collectionDir, id), { ...context, [field]: id }, index + 1);
      }
    }
  };
  for (const tenant_slug of tenants)
    walk(
      pathResolver.rootResolve(physicalScopedPath('active/shared/runtime', { tenant_slug })),
      { tier: 'confidential', tenant_slug },
      0
    );
  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
