import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

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
    return productionEvidenceRegisterCatalog(resolved).load();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid production evidence register JSON at ${registerPath}: ${error.message}`
      );
    }
    throw error;
  }
}
