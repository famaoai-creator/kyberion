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
    expect(
      validateOutcomeContractAtCompletion(requiredEvidence, { artifactRefs: ['artifact://deck'] })
        .ok
    ).toBe(true);
  });

  it('prefers the interpreted intent goal over the generic placeholder (IL-01)', () => {
    const mission = inferMissionOutcomeContract({
      missionId: 'MSN-GOAL',
      missionType: 'development',
      intentGoal: {
        source_text: '来週のSBI向け提案資料を作って',
        summary: 'SBI向け提案資料の作成',
        success_condition: '提案PPTXが成果物として存在しレビュー済みである',
      },
    });

    expect(mission.requested_result).toBe('SBI向け提案資料の作成');
    expect(mission.success_criteria).toEqual(['提案PPTXが成果物として存在しレビュー済みである']);
    expect(mission.requested_result).not.toContain('Complete mission scope');
  });

  it('captures structured company vision refs in mission outcome contracts (CO-01)', () => {
    const mission = inferMissionOutcomeContract({
      missionId: 'MSN-VISION',
      missionType: 'development',
      visionRef: 'company://acme/vision?source=legacy%20brief',
    });

    expect(mission.vision_ref).toEqual({
      raw: 'company://acme/vision?source=legacy%20brief',
      kind: 'company',
      tenant_slug: 'acme',
      path: 'vision',
      query: 'source=legacy%20brief',
    });
  });

  it('falls back to the source utterance when the goal summary is empty (IL-01)', () => {
    const mission = inferMissionOutcomeContract({
      missionId: 'MSN-GOAL-2',
      missionType: 'development',
      intentGoal: { source_text: 'レポートまとめて', summary: '  ' },
    });

    expect(mission.requested_result).toBe('レポートまとめて');
  });

  it('infers mission and task-session defaults', () => {
    const mission = inferMissionOutcomeContract({
      missionId: 'MSN-TEST',
      missionType: 'development',
    });
    expect(mission.verification_method).toBe('review_gate');
    expect(mission.success_criteria.length).toBeGreaterThan(0);
    expect(mission.requested_result).toContain('Complete mission scope');

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
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/outcome-contract.schema.json'
    );
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const contract = createOutcomeContract({
      requestedResult: 'Generate weekly report',
      deliverableKind: 'docx',
      successCriteria: ['report is generated'],
      evidenceRequired: true,
      expectedArtifacts: [{ kind: 'docx', storage_class: 'artifact_store' }],
      verificationMethod: 'review_gate',
      visionRef: 'company://acme/vision',
    });
    const valid = validate(contract);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});

it('retains a schema-valid legacy development mission kind', async () => {
  const { compileSchemaFromPath } = await import('./schema-loader.js');
  const { pathResolver } = await import('./path-resolver.js');
  const validate = compileSchemaFromPath(
    new Ajv({ allErrors: true, strict: false }),
    pathResolver.knowledge('product/schemas/outcome-contract.schema.json')
  );
  const contract = inferMissionOutcomeContract({
    missionId: 'MSN-DEVELOPMENT',
    missionType: 'development',
    intentGoal: { summary: 'Implement feature', success_condition: 'Validated feature' },
  });
  expect(validate(contract)).toBe(true);
});

it('resolves unknown mission types to the governed fallback and preserves sanctioned legacy types', async () => {
  const { resolveMissionDeliverableKind } = await import('./outcome-contract.js');
  expect(resolveMissionDeliverableKind('unregistered-kind')).toBe('summary');
  expect(resolveMissionDeliverableKind('operations_report')).toBe('operations_report');
  expect(resolveMissionDeliverableKind('evaluation')).toBe('evaluation');
});
