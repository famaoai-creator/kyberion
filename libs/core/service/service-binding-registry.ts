import * as path from 'node:path';
import {
  resolveBindingOwner,
  validateBindingOwner,
  type BindingOwnerKind,
} from './service-binding-owner.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '../secure-io.js';

export interface ServiceBindingRecord {
  binding_id: string;
  service_type: string;
  scope: string;
  target: string;
  allowed_actions: string[];
  secret_refs: string[];
  approval_policy: Record<string, 'allowed' | 'approval_required' | 'denied'>;
  tenant_slug?: string;
  /** Who owns the connection; see service-binding-owner.ts. Backfilled on save when absent. */
  owner_kind?: BindingOwnerKind;
  owner_ref?: string;
  project_id?: string;
  service_id?: string;
  auth_mode?: 'none' | 'secret-guard' | 'session';
  metadata?: Record<string, unknown>;
}

const BINDING_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/service-binding-record.schema.json'
);
const BINDING_DIR = pathResolver.shared('runtime/service-bindings');

const serviceBindingRecordCatalog = defineCatalog<ServiceBindingRecord>({
  id: 'service-binding-record',
  path: BINDING_DIR,
  schema: BINDING_SCHEMA_PATH,
});

function bindingPath(bindingId: string): string {
  const directory = path.resolve(BINDING_DIR);
  const candidate = path.resolve(directory, `${bindingId}.json`);
  const relative = path.relative(directory, candidate).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(
      `[RESOURCE_PATH_SCOPE] service binding path escapes its directory: ${bindingId}`
    );
  }
  return assertSafeRepositoryPath(candidate, {
    allowMissingLeaf: true,
  });
}

function serviceBindingRecordCatalogAtPath(filePath: string) {
  return defineCatalog<ServiceBindingRecord>({
    id: 'service-binding-record',
    path: filePath,
    schema: BINDING_SCHEMA_PATH,
  });
}

export function validateServiceBindingRecord(value: unknown): value is ServiceBindingRecord {
  try {
    serviceBindingRecordCatalog.validate(value);
    return true;
  } catch {
    return false;
  }
}

export function saveServiceBindingRecord(input: ServiceBindingRecord): string {
  const ownerProblems = validateBindingOwner(input);
  if (ownerProblems.length > 0) {
    throw new Error(`Invalid service binding record: ${ownerProblems.join('; ')}`);
  }
  // Ownership is made explicit when it can be known: an organization connection names its tenant.
  // A legacy person connection has no member to name, so it stays unmarked until the owner
  // migration (scripts/migrate_binding_owners.ts) is given one.
  const owner = resolveBindingOwner(input);
  const record: ServiceBindingRecord =
    owner.derived && owner.owner_kind !== 'organization'
      ? input
      : {
          ...input,
          owner_kind: owner.owner_kind,
          ...(owner.owner_ref ? { owner_ref: owner.owner_ref } : {}),
        };
  const filePath = bindingPath(record.binding_id);
  let validated: ServiceBindingRecord;
  try {
    validated = serviceBindingRecordCatalogAtPath(filePath).validate(record, filePath);
  } catch (error) {
    throw new Error(
      `Invalid service binding record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!safeExistsSync(BINDING_DIR)) safeMkdir(BINDING_DIR, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  return filePath;
}

export function loadServiceBindingRecord(bindingId: string): ServiceBindingRecord | null {
  const filePath = bindingPath(bindingId);
  if (!safeExistsSync(filePath)) return null;
  try {
    return serviceBindingRecordCatalogAtPath(filePath).load();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid catalog ')) return null;
    throw error;
  }
}

export function listServiceBindingRecords(): ServiceBindingRecord[] {
  if (!safeExistsSync(BINDING_DIR)) return [];
  return safeReaddir(BINDING_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadServiceBindingRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is ServiceBindingRecord => Boolean(record))
    .sort((a, b) => a.binding_id.localeCompare(b.binding_id));
}

// ---------------------------------------------------------------------------
// Owner migration — dry-run by default, backup before apply, rollback on demand
// ---------------------------------------------------------------------------

export type BindingOwnerMigrationAction =
  'already_explicit' | 'backfill_organization' | 'assign_person' | 'needs_decision' | 'invalid';

export interface BindingOwnerMigrationEntry {
  binding_id: string;
  action: BindingOwnerMigrationAction;
  problems?: string[];
}

export interface BindingOwnerMigrationResult {
  applied: boolean;
  entries: BindingOwnerMigrationEntry[];
  backup_dir?: string;
}

const BINDING_BACKUP_ROOT = pathResolver.shared('runtime/service-bindings-backup');

/**
 * Make every connection's owner explicit.
 *  - organization (has tenant_slug): backfilled automatically.
 *  - person without an owner: needs a decision. Pass `assignPerson: 'user:<member>'` to claim them
 *    all for one member (the single-operator case); otherwise they are reported and left untouched.
 *  - operator connections are never inferred: declare them explicitly.
 * Without `apply`, nothing is written. With it, the directory is copied to a timestamped backup
 * first; `rollbackBindingOwners(backup_dir)` restores it.
 */
export function migrateBindingOwners(
  options: { apply?: boolean; assignPerson?: string; now?: Date } = {}
): BindingOwnerMigrationResult {
  const records = listServiceBindingRecords();
  const entries: BindingOwnerMigrationEntry[] = [];
  const writes: ServiceBindingRecord[] = [];
  for (const record of records) {
    if (record.owner_kind) {
      const problems = validateBindingOwner(record);
      entries.push({
        binding_id: record.binding_id,
        action: problems.length > 0 ? 'invalid' : 'already_explicit',
        ...(problems.length > 0 ? { problems } : {}),
      });
      continue;
    }
    if (record.tenant_slug) {
      entries.push({ binding_id: record.binding_id, action: 'backfill_organization' });
      writes.push(record);
      continue;
    }
    if (options.assignPerson) {
      const claimed: ServiceBindingRecord = {
        ...record,
        owner_kind: 'person',
        owner_ref: options.assignPerson,
      };
      const problems = validateBindingOwner(claimed);
      if (problems.length > 0) {
        entries.push({ binding_id: record.binding_id, action: 'invalid', problems });
      } else {
        entries.push({ binding_id: record.binding_id, action: 'assign_person' });
        writes.push(claimed);
      }
      continue;
    }
    entries.push({ binding_id: record.binding_id, action: 'needs_decision' });
  }
  if (!options.apply || writes.some((w) => validateBindingOwner(w).length > 0)) {
    return { applied: false, entries };
  }
  if (writes.length === 0) return { applied: true, entries };
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BINDING_BACKUP_ROOT, stamp);
  safeMkdir(backupDir, { recursive: true });
  for (const record of records) {
    safeWriteFile(
      path.join(backupDir, `${record.binding_id}.json`),
      JSON.stringify(record, null, 2)
    );
  }
  for (const record of writes) saveServiceBindingRecord(record);
  return { applied: true, entries, backup_dir: backupDir };
}

/** Restore the records saved by a previous `migrateBindingOwners({ apply: true })`. */
export function rollbackBindingOwners(backupDir: string): number {
  const dir = path.resolve(backupDir);
  const root = path.resolve(BINDING_BACKUP_ROOT);
  if (!dir.startsWith(root + path.sep)) {
    throw new Error('[RESOURCE_PATH_SCOPE] rollback source must be a service-bindings backup');
  }
  let restored = 0;
  for (const entry of safeReaddir(dir).filter((f) => f.endsWith('.json'))) {
    const filePath = bindingPath(entry.replace(/\.json$/, ''));
    safeWriteFile(filePath, String(safeReadFile(path.join(dir, entry), { encoding: 'utf8' })));
    restored += 1;
  }
  return restored;
}
