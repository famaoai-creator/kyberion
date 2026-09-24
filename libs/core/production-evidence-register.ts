import { defineCatalog } from './foundation/governed-catalog.js';
import { readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { assertNotSimulatedEvidence } from './scenario-evidence-class.js';
import { safeExistsSync, safeLstat } from './secure-io.js';

export type ProductionEvidenceStatus = 'pending_external_evidence' | 'verified';

export interface ProductionEvidenceRefRequirement {
  id: string;
  description: string;
  accepted_ref_patterns: string[];
}

export interface ProductionEvidenceItem {
  id: string;
  gate: string;
  required_evidence: string;
  status: ProductionEvidenceStatus;
  owner: string;
  template_ref: string;
  acceptance_criteria: string[];
  verification_artifact: string;
  reviewed_at: string | null;
  reviewer: string | null;
  ref_requirements: ProductionEvidenceRefRequirement[];
  evidence_refs: string[];
}

export interface ProductionEvidenceRegister {
  version: string;
  last_updated: string;
  release_decision: ProductionEvidenceStatus;
  items: ProductionEvidenceItem[];
}

const DEFAULT_REGISTER_PATH = 'knowledge/product/governance/production-evidence-register.json';
const REGISTER_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/production-evidence-register.schema.json'
);

function productionEvidenceRegisterCatalog(registerPath: string) {
  return defineCatalog<ProductionEvidenceRegister>({
    id: 'production-evidence-register',
    path: registerPath,
    schema: REGISTER_SCHEMA_PATH,
  });
}

/** Load the release evidence register through the shared contract boundary. */
export function loadProductionEvidenceRegister(
  registerPath = DEFAULT_REGISTER_PATH
): ProductionEvidenceRegister {
  const resolved = pathResolver.rootResolve(registerPath);
  try {
    const register = productionEvidenceRegisterCatalog(resolved).load();
    assertNoSimulatedEvidenceInRegister(register);
    return register;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid production evidence register JSON at ${registerPath}: ${error.message}`
      );
    }
    throw error;
  }
}

/**
 * ES-04: a local JSON artifact referenced as evidence that is simulated
 * scenario output is refused as release evidence (the register schema itself
 * is closed, so items cannot carry an evidence class of their own).
 */
function assertNoSimulatedEvidenceInRegister(register: ProductionEvidenceRegister): void {
  for (const item of register.items) {
    const intake = `production-evidence-register item ${item.id}`;
    for (const ref of item.evidence_refs) {
      if (typeof ref !== 'string' || !ref.endsWith('.json') || ref.includes('://')) continue;
      const refPath = pathResolver.rootResolve(ref);
      if (!safeExistsSync(refPath) || !safeLstat(refPath).isFile()) continue;
      let artifact: unknown;
      try {
        artifact = readJson<unknown>(refPath);
      } catch {
        continue;
      }
      assertNotSimulatedEvidence(artifact, `${intake} ref ${ref}`);
    }
  }
}
