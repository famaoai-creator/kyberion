import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

export interface AnalysisExecutionContractDefinition {
  contract_id: string;
  intent_id: string;
  summary: string;
  required_bindings: string[];
  compiler_steps: string[];
  evidence_outputs: string[];
}

interface AnalysisExecutionContractFile {
  contracts?: AnalysisExecutionContractDefinition[];
}

let analysisExecutionContractCache: AnalysisExecutionContractDefinition[] | null = null;

export function loadAnalysisExecutionContracts(): AnalysisExecutionContractDefinition[] {
  if (analysisExecutionContractCache) return analysisExecutionContractCache;
  const filePath = pathResolver.knowledge('public/governance/analysis-execution-contracts.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as AnalysisExecutionContractFile;
  analysisExecutionContractCache = Array.isArray(parsed.contracts) ? parsed.contracts : [];
  return analysisExecutionContractCache;
}

export function resolveAnalysisExecutionContract(intentId?: string): AnalysisExecutionContractDefinition | null {
  if (!intentId) return null;
  return loadAnalysisExecutionContracts().find((contract) => contract.intent_id === intentId) || null;
}
