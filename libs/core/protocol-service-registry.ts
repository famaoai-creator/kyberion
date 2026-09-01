import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

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
  principal_resolution: string;
  write_authority: string;
  nhi_binding: string;
  approval_classes: string[];
  data_residency: string;
  data_paths: string[];
  lifecycle_actions: string[];
  lifecycle_owner?: 'surface_runtime' | 'service';
  lifecycle_compatibility?: string;
}

interface ProtocolServiceRegistryFile {
  version: string;
  description: string;
  entries: ProtocolServiceRegistryEntry[];
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/protocol-service-registry.json');
const protocolServiceRegistryCatalog = defineCatalog<ProtocolServiceRegistryFile>({
  id: 'protocol-service-registry',
  path: REGISTRY_PATH,
  schema: pathResolver.knowledge('product/schemas/protocol-service-registry.schema.json'),
});

export function loadProtocolServiceRegistry(): ProtocolServiceRegistryEntry[] {
  try {
    return protocolServiceRegistryCatalog.load().entries;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[PROTOCOL_SERVICE_REGISTRY_INVALID] ${detail}`, { cause: error });
  }
}

export function getProtocolServiceRegistryEntry(id: string): ProtocolServiceRegistryEntry {
  const entry = loadProtocolServiceRegistry().find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`[PROTOCOL_SERVICE_NOT_REGISTERED] '${id}' is not registered`);
  return entry;
}

export function assertProtocolServiceRegistered(id: string): void {
  getProtocolServiceRegistryEntry(id);
}
