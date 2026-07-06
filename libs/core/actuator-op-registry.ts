import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { recordConfigFallback } from './config-fallback-registry.js';
import { suggestClosestStrings } from './op-suggestions.js';

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
const DEFAULT_CONTROL_OPS = ['if', 'while'];

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function collectKnownOps(domain: string, registry: ActuatorOpRegistryFile): string[] {
  const domainRegistry = registry.domains[domain];
  return unique([
    ...(domainRegistry?.capture ?? []),
    ...(domainRegistry?.transform ?? []),
    ...(domainRegistry?.apply ?? []),
    ...registry.shared_capture_ops,
    ...registry.shared_transform_ops,
    ...registry.shared_apply_ops,
  ]);
}

function loadActuatorOpRegistry(): ActuatorOpRegistryFile {
  if (_cachedOpRegistry) return _cachedOpRegistry;
  try {
    const filePath = pathResolver.knowledge('product/governance/actuator-op-registry.json');
    _cachedOpRegistry = JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as ActuatorOpRegistryFile;
  } catch (err) {
    const defaults: ActuatorOpRegistryFile = {
      shared_capture_ops: [],
      shared_transform_ops: [],
      shared_apply_ops: [],
      domains: {},
    };
    recordConfigFallback({
      knowledgePath: 'product/governance/actuator-op-registry.json',
      error: err,
      defaults,
    });
    _cachedOpRegistry = defaults;
  }
  return _cachedOpRegistry;
}

export function listKnownActuatorOps(domain: string, extraOps: string[] = []): string[] {
  const registry = loadActuatorOpRegistry();
  return unique([...collectKnownOps(domain, registry), ...extraOps]);
}

export function buildUnknownActuatorOpError(
  domain: string,
  action: string,
  extraOps: string[] = DEFAULT_CONTROL_OPS
): Error {
  const candidates = listKnownActuatorOps(domain, extraOps);
  const suggestions = suggestClosestStrings(action, candidates);
  return new Error(
    suggestions.length > 0
      ? `[UNKNOWN_OP] Unknown op "${action}" for domain "${domain}". Did you mean: ${suggestions.join(', ')}?`
      : `[UNKNOWN_OP] Unknown op "${action}" for domain "${domain}"`
  );
}

export function determineActuatorStepType(domain: string, action: string): PipelineStepType {
  const { shared_capture_ops, shared_transform_ops, shared_apply_ops, domains } =
    loadActuatorOpRegistry();
  const registry = domains[domain];
  if (registry?.apply?.includes(action)) return 'apply';
  if (registry?.capture?.includes(action)) return 'capture';
  if (registry?.transform?.includes(action)) return 'transform';

  if (shared_capture_ops.includes(action)) return 'capture';
  if (shared_transform_ops.includes(action)) return 'transform';
  if (shared_apply_ops.includes(action)) return 'apply';

  throw buildUnknownActuatorOpError(domain, action);
}

export function listRegisteredDomainOps(domain: string): DomainOpRegistry {
  return loadActuatorOpRegistry().domains[domain] || {};
}
