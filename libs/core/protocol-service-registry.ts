import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

export type ProtocolServiceClassification =
  'protocol-gateway' | 'control-plane-worker' | 'artifact-review-port';

export interface ProtocolServiceRegistryEntry {
  id: string;
  classification: ProtocolServiceClassification;
  process_scope: 'system' | 'tenant-service';
  request_scope_mode: string;
  health: string;
  owner: string;
  binding: string;
  approval: string;
  data_paths: string[];
  lifecycle_compatibility?: string;
}

interface ProtocolServiceRegistryFile {
  version: string;
  entries: ProtocolServiceRegistryEntry[];
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/protocol-service-registry.json');

export function loadProtocolServiceRegistry(): ProtocolServiceRegistryEntry[] {
  const raw = safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as ProtocolServiceRegistryFile;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error('[PROTOCOL_SERVICE_REGISTRY_INVALID] entries must be an array');
  }
  for (const entry of parsed.entries) {
    if (
      !entry.id ||
      !entry.classification ||
      !entry.process_scope ||
      !entry.request_scope_mode ||
      !entry.health ||
      !entry.owner ||
      !entry.binding ||
      !entry.approval ||
      !Array.isArray(entry.data_paths) ||
      entry.data_paths.length === 0
    ) {
      throw new Error(
        `[PROTOCOL_SERVICE_REGISTRY_INVALID] entry '${String(entry?.id || 'unknown')}' is incomplete`
      );
    }
  }
  return parsed.entries;
}

export function getProtocolServiceRegistryEntry(id: string): ProtocolServiceRegistryEntry {
  const entry = loadProtocolServiceRegistry().find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`[PROTOCOL_SERVICE_NOT_REGISTERED] '${id}' is not registered`);
  return entry;
}

export function assertProtocolServiceRegistered(id: string): void {
  getProtocolServiceRegistryEntry(id);
}
