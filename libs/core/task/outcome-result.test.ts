import { describe, expect, it } from 'vitest';
import { createOutcomeContract } from './outcome-contract.js';
import { projectOutcomeResult } from './outcome-result.js';
import { compileSchema } from '../foundation/ajv.js';
import { pathResolver } from '../path-resolver.js';
import type { TaskResultBlock } from '../surface/channel-surface-types.js';
import type { ArtifactRecord } from '../workforce/artifact-record.js';

const contract = createOutcomeContract({
  outcomeId: 'report',
  requestedResult: 'Create the weekly report',
  deliverableKind: 'docx',
  successCriteria: ['Totals match', 'Sources cited'],
  verificationMethod: 'review_gate',
});
function report(patch: Partial<TaskResultBlock> = {}): TaskResultBlock {
  return {
    summary: 'Report created',
    artifacts: [{ path: 'report.docx', kind: 'docx' }],
    verification_done: ['Opened the report'],
    gaps: [],
    needs: [],
    ...patch,
  };
}
function artifact(statuses: Array<'pending' | 'delivered' | 'failed'>): ArtifactRecord {
  return {
    artifact_id: 'weekly',
    path: 'report.docx',
    kind: 'docx',
    storage_class: 'artifact_store',
    delivered_to: statuses.map((status, index) => ({ binding_id: `recipient-${index}`, status })),
  };
}

describe('Outcome Result facts remain separate', () => {
  it('does not infer verification or delivery from artifacts, checks, or a URL', () => {
    const result = projectOutcomeResult({
      contract,
      taskResult: report(),
      artifactRefs: ['https://example.test/report'],
    });
    expect(result.artifacts).toHaveLength(2);
    expect(result.verification.status).toBe('unassessed');
    expect(result.verification.reported_checks).toEqual(['Opened the report']);
    expect(result.delivery.status).toBe('unknown');
  });

  it('requires specific nonblank evidence for every exact criterion and preserves gaps', () => {
    const result = projectOutcomeResult({
      contract,
      taskResult: report({
        gaps: ['Review outstanding'],
        acceptance_evidence: [
          { criterion: ' Totals match ', status: 'passed', evidence: ' totals.csv comparison ' },
          { criterion: 'Sources cited', status: 'passed', evidence: ' ' },
          { criterion: 'Unrelated', status: 'passed', evidence: 'other test' },
        ],
      }),
    });
    expect(result.verification.status).toBe('partial');
    expect(result.verification.criteria[0].evidence).toEqual(['totals.csv comparison']);
    expect(result.verification.criteria[1].status).toBe('unassessed');
    expect(result.gaps).toEqual(['Review outstanding']);
  });

  it('does not call a complete worker report independent review', () => {
    const result = projectOutcomeResult({
      contract,
      taskResult: report({
        acceptance_evidence: contract.success_criteria.map((criterion) => ({
          criterion,
          status: 'passed',
          evidence: 'worker check',
        })),
      }),
    });
    expect(result.verification).toMatchObject({ status: 'reported_passed', method: 'review_gate' });
    expect(result.delivery.status).toBe('unknown');
  });

  it('a failed report wins over a duplicate pass and successful delivery', () => {
    const result = projectOutcomeResult({
      contract,
      artifactRecords: [artifact(['delivered'])],
      taskResult: report({
        acceptance_evidence: [
          { criterion: 'Totals match', status: 'failed', evidence: 'mismatch' },
          ...contract.success_criteria.map((criterion) => ({
            criterion,
            status: 'passed' as const,
            evidence: 'claimed pass',
          })),
        ],
      }),
    });
    expect(result.verification.status).toBe('reported_failed');
    expect(result.delivery.status).toBe('delivered');
  });

  it.each([
    [[], 'unknown'],
    [['pending'], 'pending'],
    [['delivered'], 'delivered'],
    [['pending', 'delivered'], 'partial'],
    [['delivered', 'failed'], 'failed'],
  ] as const)('preserves current per-binding delivery states %j', (statuses, expected) => {
    const source = artifact([...statuses]);
    const result = projectOutcomeResult({ contract, artifactRecords: [source] });
    expect(result.delivery.status).toBe(expected);
    expect(result.delivery.bindings.map((binding) => binding.status)).toEqual(statuses);
    expect(result.verification.status).toBe('unassessed');
    expect(source.delivered_to).toHaveLength(statuses.length);
  });

  it('preserves unknown delivery for outputs without receipts alongside delivered outputs', () => {
    const source = artifact(['delivered']);
    const result = projectOutcomeResult({
      contract,
      artifactRecords: [
        source,
        { artifact_id: 'other', kind: 'docx', storage_class: 'artifact_store' },
      ],
      artifactRefs: ['untracked.docx', 'report.docx'],
    });
    expect(result.delivery.status).toBe('partial');
    expect(result.delivery.untracked_artifact_refs).toEqual(['untracked.docx', 'artifact:other']);
    expect(result.delivery.bindings).toHaveLength(1);
  });

  it('never drops a failure with blank evidence in favor of a duplicate pass', () => {
    const result = projectOutcomeResult({
      contract,
      taskResult: report({
        acceptance_evidence: [
          { criterion: 'Totals match', status: 'failed', evidence: ' ' },
          ...contract.success_criteria.map((criterion) => ({
            criterion,
            status: 'passed' as const,
            evidence: 'pass',
          })),
        ],
      }),
    });
    expect(result.verification.status).toBe('reported_failed');
  });

  it('does not erase remaining needs when all criterion reports pass', () => {
    const result = projectOutcomeResult({
      contract,
      taskResult: report({
        needs: ['Human review'],
        acceptance_evidence: contract.success_criteria.map((criterion) => ({
          criterion,
          status: 'passed',
          evidence: 'worker check',
        })),
      }),
    });
    expect(result.verification.status).toBe('reported_passed');
    expect(result.needs).toEqual(['Human review']);
  });

  it('keeps an empty contract unassessed and emits schema-valid results', () => {
    const result = projectOutcomeResult({ contract: { ...contract, success_criteria: [] } });
    expect(result.verification.status).toBe('unassessed');
    const validate = compileSchema(
      pathResolver.knowledge('product/schemas/outcome-result.schema.json')
    );
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });
});
