import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReaddir, safeWriteFile } from './secure-io.js';

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
  return `${BINDING_DIR}/${bindingId}.json`;
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
  try {
    serviceBindingRecordCatalog.validate(record);
  } catch (error) {
    throw new Error(
      `Invalid service binding record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!safeExistsSync(BINDING_DIR)) safeMkdir(BINDING_DIR, { recursive: true });
  const filePath = bindingPath(record.binding_id);
  safeWriteFile(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadServiceBindingRecord(bindingId: string): ServiceBindingRecord | null {
  const filePath = bindingPath(bindingId);
  if (!safeExistsSync(filePath)) return null;
  try {
    return defineCatalog<ServiceBindingRecord>({
      id: 'service-binding-record',
      path: filePath,
      schema: BINDING_SCHEMA_PATH,
    }).load();
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
