/**
 * Governed intake-vector policy (data-ingestion-protocol Vectors 1-4).
 * The four external-data entry points are declared in governed data rather
 * than scattered through docs and code comments. A vector that is disabled
 * in policy must not accept new intake; `requires_host_gate` marks vectors
 * that only a host-level gate (SUDO / operator action) may trigger.
 */

import { defineCatalog } from '@agent/core/foundation/governed-catalog';
import { pathResolver } from '@agent/core/path-resolver';

const INTAKE_VECTORS_POLICY_PATH = 'knowledge/product/governance/intake-vectors.json';
const INTAKE_VECTORS_SCHEMA_PATH = 'knowledge/product/schemas/intake-vectors.schema.json';

export type IntakeVectorId =
  'manual_vaulting' | 'connector_skills' | 'agentic_web_fetch' | 'vault_mount';

export interface IntakeVectorPolicy {
  enabled: boolean;
  description: string;
  source_types: string[];
  requires_host_gate: boolean;
  agent_writable: boolean;
  landing_floor: string;
}

export interface IntakeVectorsPolicy {
  version: string;
  description?: string;
  vectors: Record<IntakeVectorId, IntakeVectorPolicy>;
}

const catalog = defineCatalog<IntakeVectorsPolicy>({
  id: 'intake-vectors',
  path: () => pathResolver.resolve(INTAKE_VECTORS_POLICY_PATH),
  schema: INTAKE_VECTORS_SCHEMA_PATH,
});

export function getIntakeVectorsPolicy(): IntakeVectorsPolicy {
  return catalog.load();
}

export function getIntakeVector(id: IntakeVectorId): IntakeVectorPolicy {
  return catalog.load().vectors[id];
}

export function isIntakeVectorEnabled(id: IntakeVectorId): boolean {
  return getIntakeVector(id).enabled === true;
}

export function assertIntakeVectorEnabled(id: IntakeVectorId): void {
  const vector = getIntakeVector(id);
  if (!vector.enabled) {
    throw new Error(
      `[INTAKE_VECTOR_DISABLED] Intake vector '${id}' is disabled in ${INTAKE_VECTORS_POLICY_PATH}.`
    );
  }
}

export function resetIntakeVectorsPolicyCache(): void {
  catalog.reset();
}
