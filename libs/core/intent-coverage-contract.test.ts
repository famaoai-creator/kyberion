import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { resolveAnalysisExecutionContract } from './analysis-contract.js';
import { loadOutcomeCatalog, loadSpecialistCatalog, resolveWorkDesign } from './work-design.js';
import { classifyTaskSessionIntent } from './task-session.js';

type CoverageRecord = {
  intent_id: string;
  status: 'implemented' | 'partial' | 'missing';
  work_shape?: string;
  outcome_ids?: string[];
};

type StandardIntent = {
  id?: string;
  category?: string;
  surface_examples?: string[];
  specialist_id?: string;
  outcome_ids?: string[];
  resolution?: {
    shape?: string;
  };
};

type IntentOutcomePattern = {
  intent_id: string;
  primary_outcome_ids?: string[];
  canonical_flow?: string[];
  contract_layers?: string[];
  evidence?: string[];
  completion_criteria?: string[];
};

function loadCoverageRecords(): CoverageRecord[] {
  const filePath = pathResolver.knowledge('public/governance/intent-coverage-matrix.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as { intents?: CoverageRecord[] };
  return Array.isArray(parsed.intents) ? parsed.intents : [];
}

function loadStandardIntents(): StandardIntent[] {
  const filePath = pathResolver.knowledge('public/governance/standard-intents.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as { intents?: StandardIntent[] };
  return Array.isArray(parsed.intents) ? parsed.intents : [];
}

function loadIntentOutcomePatterns(): IntentOutcomePattern[] {
  const filePath = pathResolver.knowledge('public/governance/intent-outcome-patterns.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as { patterns?: IntentOutcomePattern[] };
  return Array.isArray(parsed.patterns) ? parsed.patterns : [];
}

describe('intent coverage contract', () => {
  it('keeps implemented intents aligned with standard-intents and outcomes', () => {
    const coverage = loadCoverageRecords().filter((entry) => entry.status === 'implemented');
    const standardIntents = loadStandardIntents();
    const outcomes = loadOutcomeCatalog();
    const specialists = loadSpecialistCatalog();

    for (const entry of coverage) {
      const intent = standardIntents.find((candidate) => candidate.id === entry.intent_id);
      expect(intent, `missing standard intent for ${entry.intent_id}`).toBeTruthy();
      expect(intent?.resolution?.shape, `missing resolution shape for ${entry.intent_id}`).toBe(entry.work_shape);

      for (const outcomeId of entry.outcome_ids || []) {
        expect(outcomes[outcomeId], `missing outcome ${outcomeId} for ${entry.intent_id}`).toBeTruthy();
      }

      if (intent?.specialist_id) {
        expect(specialists[intent.specialist_id], `missing specialist ${intent.specialist_id} for ${entry.intent_id}`).toBeTruthy();
      }

      const resolved = resolveWorkDesign({
        intentId: entry.intent_id,
        shape: entry.work_shape as any,
        outcomeIds: entry.outcome_ids || [],
      });
      expect(resolved.outcomes.map((item) => item.id)).toEqual(expect.arrayContaining(entry.outcome_ids || []));
    }
  });

  it('keeps implemented task-session and project-bootstrap intents classifiable from their first surface example', () => {
    const coverage = loadCoverageRecords().filter((entry) => entry.status === 'implemented');
    const standardIntents = loadStandardIntents();

    for (const entry of coverage) {
      if (!['task_session', 'project_bootstrap'].includes(String(entry.work_shape || ''))) continue;
      const intent = standardIntents.find((candidate) => candidate.id === entry.intent_id);
      const sample = intent?.surface_examples?.[0];
      expect(sample, `missing sample utterance for ${entry.intent_id}`).toBeTruthy();
      const classified = classifyTaskSessionIntent(String(sample));
      expect(classified, `could not classify implemented intent sample for ${entry.intent_id}`).toBeTruthy();
      expect(classified?.intentId).toBe(entry.intent_id);
    }
  });

  it('keeps every surface intent mapped to an intent-outcome pattern with valid outcomes', () => {
    const standardIntents = loadStandardIntents().filter((intent) => intent.category === 'surface');
    const patterns = loadIntentOutcomePatterns();
    const outcomes = loadOutcomeCatalog();

    for (const intent of standardIntents) {
      const pattern = patterns.find((entry) => entry.intent_id === intent.id);
      expect(pattern, `missing intent-outcome pattern for ${intent.id}`).toBeTruthy();
      expect(pattern?.canonical_flow?.length || 0, `missing canonical flow for ${intent.id}`).toBeGreaterThan(0);
      expect(pattern?.contract_layers?.length || 0, `missing contract layers for ${intent.id}`).toBeGreaterThan(0);
      expect(pattern?.evidence?.length || 0, `missing evidence expectations for ${intent.id}`).toBeGreaterThan(0);
      expect(pattern?.completion_criteria?.length || 0, `missing completion criteria for ${intent.id}`).toBeGreaterThan(0);

      for (const outcomeId of pattern?.primary_outcome_ids || []) {
        expect(outcomes[outcomeId], `missing outcome ${outcomeId} for ${intent.id}`).toBeTruthy();
      }

      for (const outcomeId of intent.outcome_ids || []) {
        expect(pattern?.primary_outcome_ids || [], `pattern outcomes missing ${outcomeId} for ${intent.id}`).toEqual(
          expect.arrayContaining([outcomeId]),
        );
      }
    }
  });

  it('keeps advanced analysis intents mapped to a first-class analysis execution contract', () => {
    for (const intentId of ['cross-project-remediation', 'incident-informed-review', 'evolve-agent-harness']) {
      const contract = resolveAnalysisExecutionContract(intentId);
      expect(contract, `missing analysis contract for ${intentId}`).toBeTruthy();
      expect(contract?.required_bindings.length || 0, `missing required bindings for ${intentId}`).toBeGreaterThan(0);
      expect(contract?.compiler_steps.length || 0, `missing compiler steps for ${intentId}`).toBeGreaterThan(0);
      expect(contract?.evidence_outputs.length || 0, `missing evidence outputs for ${intentId}`).toBeGreaterThan(0);
    }
  });
});
