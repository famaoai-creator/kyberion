import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return {
    ...actual,
    assertSafeRepositoryPath: vi.fn((p: string) => p),
    safeExistsSync: vi.fn(() => true),
    safeLstat: vi.fn(() => ({ isFile: () => true })),
    safeReadFile: vi.fn(() => Buffer.from('file-bytes')),
  };
});

vi.mock('../foundation/json.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../foundation/json.js')>();
  return {
    ...actual,
    readJsonIfPresent: vi.fn(() => null),
  };
});

import {
  evaluateGateAiAssessmentPolicy,
  GateAiAssessmentSchema,
  GateDecisionRecordSchema,
  loadGateAiAssessment,
  verifyGateAiAssessmentFreshness,
  verifyGateDecisionBinding,
  type GateAiAssessment,
} from './gate-ai-assessment.js';
import { safeExistsSync, safeReadFile } from '../secure-io.js';
import { readJsonIfPresent } from '../foundation/json.js';
import { createHash } from 'node:crypto';

const baseAssessment: GateAiAssessment = {
  kind: 'gate-ai-assessment',
  gate_id: 'gate-release-readiness',
  governance_body: 'release-readiness-review',
  assessed_at: '2026-11-23T00:00:00.000Z',
  assessor: { backend: 'claude-cli', model_tier: 'standard' },
  recommended_verdict: 'go',
  confidence: 0.8,
  criteria: [
    { criterion: 'rollback plan exists', status: 'met', score: 1 },
    { criterion: 'runbook ready', status: 'met', score: 0.9 },
  ],
  required_artifacts: [
    { artifact: 'release-readiness-checklist', status: 'present', ref: 'evidence/checklist.md' },
  ],
};

describe('GateAiAssessmentSchema', () => {
  it('accepts a well-formed assessment', () => {
    expect(GateAiAssessmentSchema.safeParse(baseAssessment).success).toBe(true);
  });
  it('rejects a missing verdict', () => {
    const { recommended_verdict: _omit, ...rest } = baseAssessment;
    expect(GateAiAssessmentSchema.safeParse(rest).success).toBe(false);
  });
  it('rejects out-of-range confidence', () => {
    expect(GateAiAssessmentSchema.safeParse({ ...baseAssessment, confidence: 1.2 }).success).toBe(
      false
    );
  });
  it('rejects a malformed evaluated_evidence digest', () => {
    expect(
      GateAiAssessmentSchema.safeParse({
        ...baseAssessment,
        evaluated_evidence: [{ path: 'evidence/x.md', sha256: 'not-a-digest' }],
      }).success
    ).toBe(false);
  });
});

describe('evaluateGateAiAssessmentPolicy', () => {
  it('passes a clean assessment', () => {
    expect(evaluateGateAiAssessmentPolicy(baseAssessment).passed).toBe(true);
  });
  it('blocks confidence below the minimum', () => {
    const result = evaluateGateAiAssessmentPolicy({ ...baseAssessment, confidence: 0.3 });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('confidence');
  });
  it('honours a custom min_confidence', () => {
    const result = evaluateGateAiAssessmentPolicy(
      { ...baseAssessment, confidence: 0.6 },
      { min_confidence: 0.9 }
    );
    expect(result.passed).toBe(false);
  });
  it('blocks unmet criteria beyond the allowance', () => {
    const result = evaluateGateAiAssessmentPolicy({
      ...baseAssessment,
      criteria: [
        { criterion: 'rollback plan exists', status: 'unmet' },
        { criterion: 'runbook ready', status: 'met' },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('unmet');
  });
  it('allows unmet criteria within max_unmet', () => {
    const result = evaluateGateAiAssessmentPolicy(
      {
        ...baseAssessment,
        recommended_verdict: 'conditional_go',
        conditions: [{ condition: 'add rollback step', owner: 'ops', due: '2026-11-30' }],
        criteria: [
          { criterion: 'rollback plan exists', status: 'partial' },
          { criterion: 'runbook ready', status: 'met' },
        ],
      },
      { max_unmet: 1 }
    );
    expect(result.passed).toBe(true);
  });
  it('blocks absent required artifacts', () => {
    const result = evaluateGateAiAssessmentPolicy({
      ...baseAssessment,
      recommended_verdict: 'no_go',
      criteria: [{ criterion: 'rollback plan exists', status: 'unmet' }],
      required_artifacts: [{ artifact: 'rollback-plan', status: 'missing' }],
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('rollback-plan');
  });
  it('flags a "go" verdict inconsistent with unmet criteria', () => {
    const result = evaluateGateAiAssessmentPolicy(
      {
        ...baseAssessment,
        criteria: [{ criterion: 'rollback plan exists', status: 'unmet' }],
      },
      { max_unmet: 5 }
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('inconsistent');
  });
  it('flags a "no_go" verdict with nothing unmet', () => {
    const result = evaluateGateAiAssessmentPolicy({
      ...baseAssessment,
      recommended_verdict: 'no_go',
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('inconsistent');
  });
  it('flags conditional_go without conditions', () => {
    const result = evaluateGateAiAssessmentPolicy({
      ...baseAssessment,
      recommended_verdict: 'conditional_go',
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('condition');
  });
});

describe('verifyGateAiAssessmentFreshness', () => {
  beforeEach(() => {
    vi.mocked(safeReadFile).mockReturnValue(Buffer.from('file-bytes'));
    vi.mocked(safeExistsSync).mockReturnValue(true);
  });
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  it('passes when digests match', () => {
    const assessment: GateAiAssessment = {
      ...baseAssessment,
      evaluated_evidence: [{ path: 'evidence/checklist.md', sha256: digest('file-bytes') }],
    };
    expect(verifyGateAiAssessmentFreshness(assessment, '/m/M').passed).toBe(true);
  });
  it('fails when an evaluated file changed', () => {
    const assessment: GateAiAssessment = {
      ...baseAssessment,
      evaluated_evidence: [{ path: 'evidence/checklist.md', sha256: digest('other-bytes') }],
    };
    const result = verifyGateAiAssessmentFreshness(assessment, '/m/M');
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('changed since assessment');
  });
  it('fails when an evaluated file is unavailable', () => {
    vi.mocked(safeExistsSync).mockReturnValueOnce(false);
    const assessment: GateAiAssessment = {
      ...baseAssessment,
      evaluated_evidence: [{ path: 'evidence/checklist.md', sha256: digest('file-bytes') }],
    };
    expect(verifyGateAiAssessmentFreshness(assessment, '/m/M').passed).toBe(false);
  });
});

describe('verifyGateDecisionBinding', () => {
  const record = {
    decision: 'go' as const,
    decider: 'release-readiness-review',
    decided_at: '2026-11-23T01:00:00.000Z',
    ai_assessment_ref: 'evidence/gate-ai-assessment.json',
    ai_assessment_sha256: 'a'.repeat(64),
  };
  it('passes when the digest matches', () => {
    expect(verifyGateDecisionBinding({ record, assessmentFileDigest: 'a'.repeat(64) }).passed).toBe(
      true
    );
  });
  it('fails on a stale assessment binding', () => {
    const result = verifyGateDecisionBinding({
      record,
      assessmentFileDigest: 'b'.repeat(64),
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('different assessment');
  });
  it('fails conditional_go without conditions', () => {
    const result = verifyGateDecisionBinding({
      record: { ...record, decision: 'conditional_go', ai_assessment_sha256: 'a'.repeat(64) },
      assessmentFileDigest: 'a'.repeat(64),
    });
    expect(result.passed).toBe(false);
  });
});

describe('GateDecisionRecordSchema', () => {
  it('requires the assessment binding fields', () => {
    expect(
      GateDecisionRecordSchema.safeParse({
        decision: 'go',
        decider: 'review-board',
        decided_at: '2026-11-23T01:00:00.000Z',
      }).success
    ).toBe(false);
  });
});

describe('loadGateAiAssessment', () => {
  it('parses an assessment from the mission evidence dir', () => {
    vi.mocked(readJsonIfPresent).mockReturnValueOnce(baseAssessment);
    const result = loadGateAiAssessment('/m/M');
    expect(result.assessment?.gate_id).toBe('gate-release-readiness');
    expect(result.error).toBeUndefined();
  });
  it('reports a schema violation', () => {
    vi.mocked(readJsonIfPresent).mockReturnValueOnce({ kind: 'gate-ai-assessment' });
    const result = loadGateAiAssessment('/m/M');
    expect(result.assessment).toBeUndefined();
    expect(result.error).toContain('schema');
  });
});
