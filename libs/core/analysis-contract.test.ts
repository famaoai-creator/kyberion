import { describe, expect, it } from 'vitest';
import { loadAnalysisExecutionContracts, resolveAnalysisExecutionContract } from './analysis-contract.js';

describe('analysis-contract', () => {
  it('loads governed contracts for advanced analysis intents', () => {
    const contracts = loadAnalysisExecutionContracts();
    expect(contracts.length).toBeGreaterThanOrEqual(3);
    expect(contracts.map((contract) => contract.intent_id)).toEqual(
      expect.arrayContaining(['cross-project-remediation', 'incident-informed-review', 'evolve-agent-harness']),
    );
  });

  it('resolves the harness evolution contract with bounded compiler steps', () => {
    const contract = resolveAnalysisExecutionContract('evolve-agent-harness');
    expect(contract?.contract_id).toBe('analysis.evolve-agent-harness.v1');
    expect(contract?.required_bindings).toContain('target_harness');
    expect(contract?.compiler_steps).toContain('compile the baseline benchmark contract');
    expect(contract?.evidence_outputs).toContain('harness_experiment_report');
  });
});
