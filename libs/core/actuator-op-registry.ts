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

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost
      );
    }
    for (let j = 0; j < current.length; j++) {
      previous[j] = current[j];
    }
  }
  return previous[b.length];
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

function formatSuggestions(action: string, candidates: string[]): string {
  if (candidates.length === 0) return '';

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score:
        candidate === action
          ? 0
          : candidate.includes(action) || action.includes(candidate)
            ? 1
            : levenshteinDistance(action, candidate),
    }))
    .filter(({ score }) => score <= Math.max(3, Math.ceil(action.length / 2)))
    .sort(
      (left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate)
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);

  if (ranked.length === 0) return '';
  return ` Did you mean: ${ranked.join(', ')}?`;
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

  const suggestions = formatSuggestions(
    action,
    collectKnownOps(domain, { shared_capture_ops, shared_transform_ops, shared_apply_ops, domains })
  );
  throw new Error(`[UNKNOWN_OP] Unknown op "${action}" for domain "${domain}".${suggestions}`);
}

export function listRegisteredDomainOps(domain: string): DomainOpRegistry {
  return loadActuatorOpRegistry().domains[domain] || {};
}
