import { describe, expect, it } from 'vitest';
import {
  JUDGMENT_MODEL_INPUT_MAX_BYTES,
  JUDGMENT_MODEL_OUTPUT_MAX_BYTES,
  decisionEvidenceRefSchema,
  judgmentAssessmentSchema,
  judgmentBindingSchema,
  judgmentScopeSchema,
  latencyGoalConstraintsSchema,
  latencyProposalFactsSchema,
  parseJudgmentModelInput,
  parseSemanticVerdict,
} from './judgment-contract.js';

const digest = 'a'.repeat(64);
const goal = () => ({
  kind: 'latency_goal_v1',
  goal_key: 'latency',
  decision_source_key: 'source-1',
  service_key: 'synthetic-service',
  load_profile_hash: digest,
  target_users: 100,
  max_p95_ms: 500,
  max_incremental_monthly_cost: 0,
  currency: 'JPY',
  permitted_change: 'isolated_fixture_only',
});
const proposal = () => ({
  proposal_key: 'repair-fixture',
  service_key: 'synthetic-service',
  load_profile_hash: digest,
  change_scope: 'isolated_fixture_only',
  requested_goal: { target_users: 100, max_p95_ms: 500 },
  incremental_monthly_cost: 0,
  currency: 'JPY',
});
const binding = () => ({
  schema_version: '1',
  work_ref: 'incident-1',
  work_revision: '1',
  trigger_key: 'event-1',
  scope_hash: digest,
  request_hash: digest,
  evidence_hash: digest,
  precedent_snapshot_hash: digest,
  policy_version: 'policy-1',
  rubric_version: 'rubric-1',
  evaluator_version: 'evaluator-1',
  model_config_hash: digest,
});
const evidenceRef = () => ({
  source_key: 'source-1',
  case_id: 'latency-case',
  decision_id: 'performance-goal',
  decision_version_hash: digest,
  basis: [{ ref: 'synthetic-human-decision', version: '1' }],
});
const apply = () => ({
  disposition: 'apply_precedent',
  precedent_keys: ['source-1'],
  rationale: '既決の目標と費用制約を維持する。',
  applicability: ['合成fixture内の局所修正'],
});
const reframe = () => ({
  disposition: 'reframe',
  violated_goal_keys: ['latency'],
  rationale: '人数制限と遅さの放置は元の目標を満たさない。',
  revised_question: '100人でp95が500ms以内になるよう原因を調査するには？',
  evidence_needed: [],
});
const escalate = () => ({
  disposition: 'escalate',
  rationale: '追加費用の許容は未決である。',
  question: '追加インフラ費用を許容するか？',
  options: [
    { label: '許容する', consequences: '月額費用が増える。' },
    { label: '許容しない', consequences: '費用0の修正候補を調べる。' },
  ],
  missing_facts: [],
});
const modelInput = () => ({
  goals: [goal()],
  precedents: [{ source_key: 'source-1', summary: '100人でp95は500ms以内。追加費用0。' }],
  proposal: proposal(),
  evidence: [{ evidence_key: 'observation-1', text: '65人でp95は1800ms（合成値）。' }],
});

describe('semantic judgment contracts', () => {
  it.each([apply(), reframe(), escalate()])('accepts the $disposition branch', (value) => {
    expect(parseSemanticVerdict(value)).toEqual(value);
  });

  it('separates canonical server binding and scope from model data', () => {
    expect(judgmentBindingSchema.parse(binding())).toEqual(binding());
    expect(
      judgmentScopeSchema.parse({
        tier: 'confidential',
        tenant_slug: 'synthetic',
        organization_id: 'ops',
        project_id: 'latency',
      })
    ).toEqual({
      tier: 'confidential',
      tenant_slug: 'synthetic',
      organization_id: 'ops',
      project_id: 'latency',
    });
    for (const injected of [
      { scope: { tenant_slug: 'other' } },
      { role: 'sovereign' },
      { approval_ref: 'approved' },
      { binding: binding() },
      { pipeline_ref: 'pipelines/deploy.json' },
      { decided_by: { kind: 'human' } },
    ]) {
      expect(() => parseSemanticVerdict({ ...apply(), ...injected })).toThrow();
      expect(() => parseJudgmentModelInput({ ...modelInput(), ...injected })).toThrow();
    }
  });

  it('rejects unknown, mixed, incomplete and empty classifications', () => {
    for (const value of [
      { ...apply(), disposition: 'deploy' },
      { ...apply(), violated_goal_keys: ['latency'] },
      { ...reframe(), precedent_keys: ['source-1'] },
      { ...escalate(), extra: true },
      { disposition: 'apply_precedent' },
      '',
      null,
      undefined,
      [],
      { ...apply(), rationale: ' \t\n' },
      { ...reframe(), revised_question: '　' },
      { ...escalate(), question: '' },
    ])
      expect(() => parseSemanticVerdict(value)).toThrow();
  });

  it('bounds and normalizes keys, rejects duplicates after normalization', () => {
    expect(parseSemanticVerdict({ ...apply(), precedent_keys: [' source-1 '] })).toMatchObject({
      precedent_keys: ['source-1'],
    });
    expect(parseSemanticVerdict({ ...apply(), precedent_keys: ['k'.repeat(128)] })).toBeDefined();
    for (const keys of [
      [],
      [' '],
      ['k'.repeat(129)],
      ['source-1', ' source-1 '],
      Array.from({ length: 11 }, (_, i) => `k-${i}`),
    ]) {
      expect(() => parseSemanticVerdict({ ...apply(), precedent_keys: keys })).toThrow();
      expect(() => parseSemanticVerdict({ ...reframe(), violated_goal_keys: keys })).toThrow();
    }
    expect(
      parseSemanticVerdict({
        ...apply(),
        precedent_keys: Array.from({ length: 10 }, (_, i) => `k-${i}`),
      })
    ).toBeDefined();
  });

  it('bounds explanations, text arrays and choices with nested strict fields', () => {
    expect(
      parseSemanticVerdict({
        ...apply(),
        rationale: 'r'.repeat(2000),
        applicability: ['a'.repeat(500)],
      })
    ).toBeDefined();
    for (const value of [
      { ...apply(), rationale: 'r'.repeat(2001) },
      { ...apply(), applicability: [] },
      { ...apply(), applicability: ['a'.repeat(501)] },
      { ...apply(), applicability: [' '] },
      { ...reframe(), evidence_needed: Array(11).fill('evidence') },
      { ...escalate(), missing_facts: Array(11).fill('fact') },
      { ...escalate(), options: [escalate().options[0]] },
      { ...escalate(), options: Array(5).fill(escalate().options[0]) },
      {
        ...escalate(),
        options: [{ label: 'x', consequences: 'y', approval: true }, escalate().options[1]],
      },
    ])
      expect(() => parseSemanticVerdict(value)).toThrow();
  });

  it('rejects oversized UTF-8 output instead of truncating valid fields', () => {
    const oversized = {
      ...reframe(),
      rationale: 'あ'.repeat(2000),
      revised_question: 'い'.repeat(2000),
      evidence_needed: Array(10).fill('う'.repeat(500)),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(
      JUDGMENT_MODEL_OUTPUT_MAX_BYTES
    );
    expect(() => parseSemanticVerdict(oversized)).toThrow(/UTF-8/);
    expect(() =>
      parseSemanticVerdict({
        ...oversized,
        rationale: 'r',
        revised_question: 'q',
        evidence_needed: [],
      })
    ).not.toThrow();
  });

  it('checks exact output byte boundary after text normalization', () => {
    const value = {
      ...reframe(),
      rationale: 'あ'.repeat(2000),
      revised_question: 'い'.repeat(2000),
      evidence_needed: Array(10).fill('x'.repeat(400)),
    };
    const extra =
      JUDGMENT_MODEL_OUTPUT_MAX_BYTES - Buffer.byteLength(JSON.stringify(value), 'utf8');
    expect(extra).toBeGreaterThan(0);
    let remaining = extra;
    for (let i = 0; remaining > 0; i++) {
      const count = Math.min(99, remaining);
      value.evidence_needed[i] += 'x'.repeat(count);
      remaining -= count;
    }
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(JUDGMENT_MODEL_OUTPUT_MAX_BYTES);
    expect(() => parseSemanticVerdict(value)).not.toThrow();
    value.evidence_needed[0] += 'x';
    expect(() => parseSemanticVerdict(value)).toThrow(/UTF-8/);
  });

  it('accepts bounded model input and refuses oversized UTF-8 input', () => {
    expect(parseJudgmentModelInput(modelInput())).toEqual(modelInput());
    const oversized = {
      ...modelInput(),
      evidence: Array.from({ length: 10 }, (_, i) => ({
        evidence_key: `e-${i}`,
        text: 'あ'.repeat(2000),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(
      JUDGMENT_MODEL_INPUT_MAX_BYTES
    );
    expect(() => parseJudgmentModelInput(oversized)).toThrow(/UTF-8/);
    expect(() => parseJudgmentModelInput({ ...modelInput(), goals: [] })).toThrow();
    expect(() =>
      parseJudgmentModelInput({
        ...modelInput(),
        evidence: [{ evidence_key: 'e', text: 'x', source: 'fake' }],
      })
    ).toThrow();
  });

  it('rejects duplicate model input keys after normalization', () => {
    for (const input of [
      { ...modelInput(), goals: [goal(), { ...goal(), goal_key: ' latency ' }] },
      {
        ...modelInput(),
        precedents: [
          { source_key: 's', summary: 'one' },
          { source_key: ' s ', summary: 'two' },
        ],
      },
      {
        ...modelInput(),
        evidence: [
          { evidence_key: 'e', text: 'one' },
          { evidence_key: ' e ', text: 'two' },
        ],
      },
    ])
      expect(() => parseJudgmentModelInput(input)).toThrow(/unique/);
  });

  it('checks the exact UTF-8 input byte boundary without truncation', () => {
    const input = {
      ...modelInput(),
      evidence: Array.from({ length: 10 }, (_, i) => ({
        evidence_key: `e-${i}`,
        text: 'あ'.repeat(1000),
      })),
    };
    let remaining =
      JUDGMENT_MODEL_INPUT_MAX_BYTES - Buffer.byteLength(JSON.stringify(input), 'utf8');
    expect(remaining).toBeGreaterThan(0);
    for (let i = 0; remaining > 0; i++) {
      const count = Math.min(999, remaining);
      input.evidence[i].text += 'x'.repeat(count);
      remaining -= count;
    }
    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBe(JUDGMENT_MODEL_INPUT_MAX_BYTES);
    expect(() => parseJudgmentModelInput(input)).not.toThrow();
    input.evidence[0].text += 'x';
    expect(() => parseJudgmentModelInput(input)).toThrow(/UTF-8/);
  });

  it('validates numeric ranges and preserves requested goals as facts, not achievement', () => {
    expect(latencyGoalConstraintsSchema.parse(goal())).toEqual(goal());
    expect(latencyProposalFactsSchema.parse(proposal())).toEqual(proposal());
    expect(
      latencyProposalFactsSchema.parse({
        ...proposal(),
        requested_goal: { target_users: 65, max_p95_ms: 1800 },
      })
    ).toMatchObject({ requested_goal: { target_users: 65, max_p95_ms: 1800 } });
    for (const field of ['target_users', 'max_p95_ms', 'max_incremental_monthly_cost']) {
      for (const value of [NaN, Infinity, -Infinity, -1, 1_000_001])
        expect(latencyGoalConstraintsSchema.safeParse({ ...goal(), [field]: value }).success).toBe(
          false
        );
    }
    for (const value of [0, 10_001, 1.5]) {
      expect(
        latencyGoalConstraintsSchema.safeParse({ ...goal(), target_users: value }).success
      ).toBe(false);
      expect(
        latencyProposalFactsSchema.safeParse({
          ...proposal(),
          requested_goal: { target_users: value, max_p95_ms: 500 },
        }).success
      ).toBe(false);
    }
    for (const value of [0, 60_001, NaN, Infinity])
      expect(
        latencyProposalFactsSchema.safeParse({
          ...proposal(),
          requested_goal: { target_users: 100, max_p95_ms: value },
        }).success
      ).toBe(false);
    for (const value of [-1, 1_000_001, 0.5, NaN, Infinity])
      expect(
        latencyProposalFactsSchema.safeParse({ ...proposal(), incremental_monthly_cost: value })
          .success
      ).toBe(false);
    expect(
      latencyGoalConstraintsSchema.safeParse({
        ...goal(),
        target_users: 10_000,
        max_p95_ms: 60_000,
        max_incremental_monthly_cost: 1_000_000,
      }).success
    ).toBe(true);
    expect(
      latencyProposalFactsSchema.safeParse({ ...proposal(), change_scope: 'production' }).success
    ).toBe(false);
    expect(latencyProposalFactsSchema.safeParse({ ...proposal(), currency: 'USD' }).success).toBe(
      false
    );
  });

  it('rejects invalid canonical scopes and malformed server evidence', () => {
    for (const scope of [
      { tier: 'confidential' },
      { tier: 'confidential', tenant_slug: 'public' },
      { tier: 'confidential', tenant_slug: 'synthetic', project_id: 'missing-org' },
      { tier: 'public', role: 'sovereign' },
      { tier: 'public', tenant_id: 'alias' },
    ])
      expect(judgmentScopeSchema.safeParse(scope).success).toBe(false);
    expect(
      judgmentBindingSchema.safeParse({ ...binding(), request_hash: 'model-invented' }).success
    ).toBe(false);
    expect(judgmentBindingSchema.safeParse({ ...binding(), approval_ref: 'fake' }).success).toBe(
      false
    );
    expect(decisionEvidenceRefSchema.parse(evidenceRef())).toEqual(evidenceRef());
    expect(decisionEvidenceRefSchema.safeParse({ ...evidenceRef(), basis: [] }).success).toBe(
      false
    );
    expect(
      decisionEvidenceRefSchema.safeParse({ ...evidenceRef(), basis: [{ ref: 'x', version: ' ' }] })
        .success
    ).toBe(false);
  });

  it('keeps evaluated evidence separate from operational unavailability', () => {
    const evaluated = {
      status: 'evaluated',
      binding: binding(),
      verdict: apply(),
      evidence_refs: [evidenceRef()],
      provider: 'fake',
      model: 'fixture',
      evaluated_at: '2026-10-31T00:00:00.000Z',
      expires_at: '2026-10-31T00:05:00.000Z',
      audit_summary: '同scopeの確定先例を参照。',
    };
    expect(judgmentAssessmentSchema.parse(evaluated)).toEqual(evaluated);
    for (const expires_at of ['2026-10-31T00:00:00.000Z', '2026-10-31T00:05:00.001Z', 'invalid'])
      expect(judgmentAssessmentSchema.safeParse({ ...evaluated, expires_at }).success).toBe(false);
    for (const reason of [
      'invalid_schema',
      'missing_evidence',
      'scope_mismatch',
      'stale_precedent',
      'conflicting_precedents',
      'budget_exhausted',
      'provider_error',
      'deadline_exceeded',
      'cancelled',
    ]) {
      expect(
        judgmentAssessmentSchema.parse({ status: 'unavailable', reason, detail: '診断' })
      ).toEqual({ status: 'unavailable', reason, detail: '診断' });
    }
    expect(
      judgmentAssessmentSchema.safeParse({
        status: 'unavailable',
        reason: 'provider_error',
        detail: '診断',
        verdict: escalate(),
      }).success
    ).toBe(false);
  });
});
