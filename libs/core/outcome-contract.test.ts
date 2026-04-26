import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  createOutcomeContract,
  inferMissionOutcomeContract,
  inferTaskSessionOutcomeContract,
  validateOutcomeContractAtCompletion,
} from './outcome-contract.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('outcome-contract', () => {
  it('creates normalized contracts with mandatory success criteria', () => {
    const contract = createOutcomeContract({
      requestedResult: 'Generate weekly report',
      deliverableKind: 'docx',
      successCriteria: ['report is generated'],
      verificationMethod: 'self_check',
    });
    expect(contract.outcome_id.length).toBeGreaterThan(0);
    expect(contract.success_criteria.length).toBe(1);
  });

  it('validates completion evidence only when required', () => {
    const optionalEvidence = createOutcomeContract({
      requestedResult: 'Summarize status',
      deliverableKind: 'summary',
      successCriteria: ['summary returned'],
      evidenceRequired: false,
    });
    expect(validateOutcomeContractAtCompletion(optionalEvidence).ok).toBe(true);

    const requiredEvidence = createOutcomeContract({
      requestedResult: 'Produce artifact',
      deliverableKind: 'pptx',
      successCriteria: ['artifact stored'],
      evidenceRequired: true,
    });
    expect(validateOutcomeContractAtCompletion(requiredEvidence).ok).toBe(false);
    expect(validateOutcomeContractAtCompletion(requiredEvidence, { artifactRefs: ['artifact://deck'] }).ok).toBe(true);
  });

  it('infers mission and task-session defaults', () => {
    const mission = inferMissionOutcomeContract({ missionId: 'MSN-TEST', missionType: 'development' });
    expect(mission.verification_method).toBe('review_gate');
    expect(mission.success_criteria.length).toBeGreaterThan(0);

    const session = inferTaskSessionOutcomeContract({
      sessionId: 'TSK-TEST',
      taskType: 'presentation_deck',
      goal: { summary: 'Create deck', success_condition: 'deck generated' },
    });
    expect(session.deliverable_kind).toBe('pptx');
    expect(session.expected_artifacts[0]?.kind).toBe('pptx');
  });

  it('emits contracts that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'schemas/outcome-contract.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const contract = createOutcomeContract({
      requestedResult: 'Generate weekly report',
      deliverableKind: 'docx',
      successCriteria: ['report is generated'],
      evidenceRequired: true,
      expectedArtifacts: [{ kind: 'docx', storage_class: 'artifact_store' }],
      verificationMethod: 'review_gate',
    });
    const valid = validate(contract);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
