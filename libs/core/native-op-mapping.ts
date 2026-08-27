import { pathResolver } from './path-resolver.js';
import { loadJson } from './secure-io.js';
import { listKnownActuatorOps } from './actuator-op-registry.js';

export interface ObservationOpMapping {
  id: string;
  signals: string[];
  preferred_ops: string[];
  fallback_ops: string[];
}

interface MappingFile {
  schema_version: 'observation-to-op.v1';
  entries: ObservationOpMapping[];
}

function load(): MappingFile {
  const path = pathResolver.knowledge('product/orchestration/observation-to-op-map.json');
  return loadJson<MappingFile>(path);
}

function splitOp(op: string): { domain: string; action: string } {
  const [domain, ...rest] = op.split(':');
  return { domain, action: rest.join(':') };
}

export function validateObservationOpMappings(
  mappings: ObservationOpMapping[] = load().entries
): string[] {
  const errors: string[] = [];
  for (const mapping of mappings) {
    for (const op of [...mapping.preferred_ops, ...mapping.fallback_ops]) {
      const { domain, action } = splitOp(op);
      if (!domain || !action || !listKnownActuatorOps(domain).includes(action))
        errors.push(`${mapping.id}: unknown actuator op ${op}`);
    }
  }
  return errors;
}

export function assertObservationOpMappingsValid(): void {
  const errors = validateObservationOpMappings();
  if (errors.length > 0) throw new Error(`[native-op-mapping] ${errors.join('; ')}`);
}

export function chooseNativeOps(observation: string): {
  mapping_id: string;
  ops: string[];
  gui_fallback: boolean;
} {
  const normalized = observation.toLowerCase();
  const candidates = load().entries.filter((entry) =>
    entry.signals.some((signal) => {
      const needle = signal.toLowerCase();
      if (needle.length <= 3 && /^[a-z0-9]+$/.test(needle))
        return new RegExp(`(?:^|[^a-z0-9])${needle}(?:$|[^a-z0-9])`, 'i').test(normalized);
      return normalized.includes(needle);
    })
  );
  const selected =
    candidates[0] || load().entries.find((entry) => entry.id === 'unknown-web-form')!;
  const ops = selected.preferred_ops.length > 0 ? selected.preferred_ops : selected.fallback_ops;
  return { mapping_id: selected.id, ops, gui_fallback: selected.preferred_ops.length === 0 };
}
