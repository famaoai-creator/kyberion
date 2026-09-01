import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

export interface AnalysisExecutionContractDefinition {
  contract_id: string;
  intent_id: string;
  summary: string;
  required_bindings: string[];
  compiler_steps: string[];
  evidence_outputs: string[];
}

interface AnalysisExecutionContractFile {
  version: string;
  contracts: AnalysisExecutionContractDefinition[];
}

const analysisExecutionContractCatalog = defineCatalog<AnalysisExecutionContractFile>({
  id: 'analysis-execution-contracts',
  path: () => pathResolver.knowledge('product/governance/analysis-execution-contracts.json'),
  schema: pathResolver.knowledge('product/schemas/analysis-execution-contracts.schema.json'),
});

export function loadAnalysisExecutionContracts(): AnalysisExecutionContractDefinition[] {
  return analysisExecutionContractCatalog.load().contracts;
}

export function resolveAnalysisExecutionContract(
  intentId?: string
): AnalysisExecutionContractDefinition | null {
  if (!intentId) return null;
  return (
    loadAnalysisExecutionContracts().find((contract) => contract.intent_id === intentId) || null
  );
}
