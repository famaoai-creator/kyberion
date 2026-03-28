import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';

export interface ServiceBindingRecord {
  binding_id: string;
  service_type: string;
  scope: string;
  target: string;
  allowed_actions: string[];
  secret_refs: string[];
  approval_policy: Record<string, 'allowed' | 'approval_required' | 'denied'>;
  service_id?: string;
  auth_mode?: 'none' | 'secret-guard' | 'session';
  metadata?: Record<string, unknown>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const BINDING_SCHEMA_PATH = pathResolver.knowledge('public/schemas/service-binding-record.schema.json');
const BINDING_DIR = pathResolver.shared('runtime/service-bindings');
let bindingValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (bindingValidateFn) return bindingValidateFn;
  const raw = safeReadFile(BINDING_SCHEMA_PATH, { encoding: 'utf8' }) as string;
  bindingValidateFn = ajv.compile(JSON.parse(raw));
  return bindingValidateFn;
}

function bindingPath(bindingId: string): string {
  return `${BINDING_DIR}/${bindingId}.json`;
}

export function validateServiceBindingRecord(value: unknown): value is ServiceBindingRecord {
  return Boolean(ensureValidator()(value));
}

export function saveServiceBindingRecord(record: ServiceBindingRecord): string {
  if (!validateServiceBindingRecord(record)) {
    const errors = (ensureValidator().errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    throw new Error(`Invalid service binding record: ${errors.join('; ')}`);
  }
  if (!safeExistsSync(BINDING_DIR)) safeMkdir(BINDING_DIR, { recursive: true });
  const filePath = bindingPath(record.binding_id);
  safeWriteFile(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadServiceBindingRecord(bindingId: string): ServiceBindingRecord | null {
  const filePath = bindingPath(bindingId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as ServiceBindingRecord;
  return validateServiceBindingRecord(parsed) ? parsed : null;
}

export function listServiceBindingRecords(): ServiceBindingRecord[] {
  if (!safeExistsSync(BINDING_DIR)) return [];
  return safeReaddir(BINDING_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadServiceBindingRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is ServiceBindingRecord => Boolean(record))
    .sort((a, b) => a.binding_id.localeCompare(b.binding_id));
}
