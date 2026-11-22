/**
 * Read the governed actuator op registry
 * (`knowledge/product/governance/actuator-op-registry.json`). It is generated
 * from the actuator op catalogs, so the CLI can expose op vocabulary and step
 * kinds without importing actuator packages.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { loadJson } from '@agent/core/foundation/json';

const REGISTRY_REL = 'knowledge/product/governance/actuator-op-registry.json';

export type OpKind = 'capture' | 'transform' | 'apply' | 'control';

export interface ActuatorOpDomain {
  kinds: Record<string, OpKind>;
  byKind: Record<OpKind, string[]>;
}

export function listOpDomains(): string[] {
  return Object.keys(loadRegistry());
}

export function loadOpDomain(domain: string): ActuatorOpDomain | null {
  const section = loadRegistry()[domain];
  if (!section) return null;
  const kinds: Record<string, OpKind> = {};
  const byKind: Record<OpKind, string[]> = {
    capture: [],
    transform: [],
    apply: [],
    control: [],
  };
  for (const kind of ['capture', 'transform', 'apply', 'control'] as const) {
    for (const op of section[kind] ?? []) {
      kinds[op] = kind;
      byKind[kind].push(op);
    }
  }
  return { kinds, byKind };
}

function loadRegistry(): Record<string, Record<string, string[]>> {
  const file = assertSafeRepositoryPath(pathResolver.rootResolve(REGISTRY_REL));
  const registry = loadJson<{ domains?: Record<string, Record<string, string[]>> }>(file);
  return registry.domains ?? {};
}
