import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export type CapabilityRestrictionStatus = 'restricted' | 'active';

export interface CapabilityRestrictionRecord {
  name: string;
  status: CapabilityRestrictionStatus;
  reason: string;
  allow_override: boolean;
}

export interface CapabilityRestrictionPolicy {
  version: string | number;
  last_updated: string;
  restrictions: CapabilityRestrictionRecord[];
}

export interface CapabilityRestrictionDecision {
  allowed: boolean;
  matched_name?: string;
  reason?: string;
}

const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/restricted-capabilities.schema.json'
);
const catalogs = new Map<string, GovernedCatalog<CapabilityRestrictionPolicy>>();

function policyPath(rootDir?: string): string {
  return rootDir
    ? path.join(rootDir, 'knowledge', 'product', 'governance', 'restricted-capabilities.json')
    : pathResolver.knowledge('product/governance/restricted-capabilities.json');
}

function getCatalog(rootDir?: string): GovernedCatalog<CapabilityRestrictionPolicy> {
  const filePath = policyPath(rootDir);
  let catalog = catalogs.get(filePath);
  if (!catalog) {
    catalog = defineCatalog<CapabilityRestrictionPolicy>({
      id: 'restricted-capabilities',
      path: filePath,
      schema: POLICY_SCHEMA_PATH,
    });
    catalogs.set(filePath, catalog);
  }
  return catalog;
}

export function loadCapabilityRestrictionPolicy(rootDir?: string): CapabilityRestrictionPolicy {
  return getCatalog(rootDir).load();
}

export function evaluateCapabilityRestriction(
  names: string[],
  restrictions: CapabilityRestrictionRecord[]
): CapabilityRestrictionDecision {
  const normalizedNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  for (const restriction of restrictions) {
    if (!normalizedNames.includes(restriction.name) || restriction.status !== 'restricted') {
      continue;
    }
    return {
      allowed: false,
      matched_name: restriction.name,
      reason: restriction.reason,
    };
  }
  return { allowed: true };
}

export function checkCapabilityRestriction(
  names: string | string[],
  rootDir?: string
): CapabilityRestrictionDecision {
  const candidates = Array.isArray(names) ? names : [names];
  try {
    return evaluateCapabilityRestriction(
      candidates,
      loadCapabilityRestrictionPolicy(rootDir).restrictions
    );
  } catch (error) {
    return {
      allowed: false,
      reason: `restricted-capabilities policy is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function assertCapabilityAllowed(names: string | string[], rootDir?: string): void {
  const decision = checkCapabilityRestriction(names, rootDir);
  if (!decision.allowed) {
    const label = decision.matched_name || (Array.isArray(names) ? names.join(', ') : names);
    throw new Error(
      `[CAPABILITY_RESTRICTED] ${label}: ${decision.reason || 'restricted by governance policy'}`
    );
  }
}
