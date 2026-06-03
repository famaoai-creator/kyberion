import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { recordConfigFallback } from './config-fallback-registry.js';

export type PipelineStepType = 'capture' | 'transform' | 'apply' | 'control';

interface DomainOpRegistry {
  capture?: string[];
  transform?: string[];
  apply?: string[];
}

interface ActuatorOpRegistryFile {
  shared_capture_ops: string[];
  shared_transform_ops: string[];
  shared_apply_ops: string[];
  domains: Record<string, DomainOpRegistry>;
}

let _cachedOpRegistry: ActuatorOpRegistryFile | null = null;

function loadActuatorOpRegistry(): ActuatorOpRegistryFile {
  if (_cachedOpRegistry) return _cachedOpRegistry;
  try {
    const filePath = pathResolver.knowledge('product/governance/actuator-op-registry.json');
    _cachedOpRegistry = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as ActuatorOpRegistryFile;
  } catch (err) {
    const defaults: ActuatorOpRegistryFile = { shared_capture_ops: [], shared_transform_ops: [], shared_apply_ops: [], domains: {} };
    recordConfigFallback({ knowledgePath: 'product/governance/actuator-op-registry.json', error: err, defaults });
    _cachedOpRegistry = defaults;
  }
  return _cachedOpRegistry;
}

export function determineActuatorStepType(domain: string, action: string): PipelineStepType {
  const { shared_capture_ops, shared_transform_ops, shared_apply_ops, domains } = loadActuatorOpRegistry();
  const registry = domains[domain];
  if (registry?.apply?.includes(action)) return 'apply';
  if (registry?.capture?.includes(action)) return 'capture';
  if (registry?.transform?.includes(action)) return 'transform';

  if (shared_capture_ops.includes(action)) return 'capture';
  if (shared_transform_ops.includes(action)) return 'transform';
  if (shared_apply_ops.includes(action)) return 'apply';

  return 'apply';
}

export function listRegisteredDomainOps(domain: string): DomainOpRegistry {
  return loadActuatorOpRegistry().domains[domain] || {};
}
