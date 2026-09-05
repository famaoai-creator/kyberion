import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';

export interface ServiceBindingRecord {
  binding_id: string;
  service_type: string;
  scope: string;
  target: string;
  allowed_actions: string[];
  secret_refs: string[];
  approval_policy: Record<string, 'allowed' | 'approval_required' | 'denied'>;
  tenant_slug?: string;
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

export function saveServiceBindingRecord(record: ServiceBindingRecord): string {
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
