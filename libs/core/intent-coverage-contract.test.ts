import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
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
});
