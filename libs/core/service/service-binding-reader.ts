/** Governed connection record reads, independent of tenant execution admission. */
import * as path from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from '../secure-io.js';
import type { ServiceBindingRecord } from './service-binding-registry.js';
const BINDING_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/service-binding-record.schema.json'
);
export const BINDING_DIR = pathResolver.shared('runtime/service-bindings');

const serviceBindingRecordCatalog = defineCatalog<ServiceBindingRecord>({
  id: 'service-binding-record',
  path: BINDING_DIR,
  schema: BINDING_SCHEMA_PATH,
});

export function serviceBindingRecordPath(bindingId: string): string {
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
const bindingPath = serviceBindingRecordPath;

export function serviceBindingRecordCatalogAtPath(filePath: string) {
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
