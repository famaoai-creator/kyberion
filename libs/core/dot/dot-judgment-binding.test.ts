import { describe, expect, it, vi } from 'vitest';
import {
  normalizeDotProposal,
  collectDotProposals,
  parseDotProposalsFromText,
} from './dot-proposals.js';
import { dotProposalHash } from './dot-action-ledger.js';
import { genericDotActionIdentity } from './dot-admission-identity.js';
import { judgmentEvidenceParent } from '../organization/judgment-evidence.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import { createJudgmentLatencyFixture } from '../organization/judgment-latency-fixture.js';
import {
  bindSyntheticDotJudgmentProposal,
  parseDotJudgmentBinding,
  dotJudgmentCharterHash,
  validateServerDotJudgmentProposal,
  type SyntheticDotJudgmentBindingInput,
} from './dot-judgment-binding.js';

function fixture(): SyntheticDotJudgmentBindingInput {
  const data = createJudgmentLatencyFixture();
  const proposal = normalizeDotProposal({
    title: 'Repair fixture',
    objective: 'Preserve the fixed performance goal',
    work_shape: 'pipeline',
    pipeline_ref: data.charter.authority.allowed_pipelines![0],
  });
  const judgmentBinding = {
    schema_version: '1' as const,
    work_ref: 'incident-1',
    work_revision: '1',
    trigger_key: 'event-1',
    scope_hash: judgmentCanonicalHash(data.scope),
    request_hash: 'a'.repeat(64),
    evidence_hash: 'b'.repeat(64),
    precedent_snapshot_hash: 'c'.repeat(64),
    policy_version: 'semantic-policy-1',
    rubric_version: 'rubric-1',
    evaluator_version: 'evaluator-1',
    model_config_hash: 'd'.repeat(64),
  };
  const parent = judgmentEvidenceParent({
    scope: data.scope,
    binding: judgmentBinding,
    effectRef: 'effect-1',
  });
  return {
    mode: 'synthetic_fixture',
    proposal,
    charter: structuredClone(data.charter),
    scope: structuredClone(data.scope),
    judgmentBinding,
    effectRef: 'effect-1',
    effectPolicyVersion: 'effect-policy-1',
    originReceipt: { ...parent, attempt: 1, content_hash: 'e'.repeat(64) },
  };
}

describe('pure server-authored synthetic origin references (not persisted proof)', () => {
  it('authors deterministic, detached, deeply frozen references without claiming source verification', () => {
    const input = fixture();
    const before = structuredClone(input);
    const first = bindSyntheticDotJudgmentProposal(input);
    expect(first).toEqual(bindSyntheticDotJudgmentProposal(input));
    expect(first.semantic_judgment).toMatchObject({
      mode: 'synthetic_fixture',
      scope: input.scope,
      judgment_binding: input.judgmentBinding,
      origin_receipt: input.originReceipt,
      effect_ref: input.effectRef,
      effect_policy_version: 'effect-policy-1',
    });
    expect(first.semantic_judgment.effect_policy_version).not.toBe(
      first.semantic_judgment.judgment_binding.policy_version
    );
    expect(first.semantic_judgment.original_proposal_hash).toBe(
      judgmentCanonicalHash(input.proposal)
    );
    expect(first.semantic_judgment.charter_hash).toBe(dotJudgmentCharterHash(input.charter));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.semantic_judgment.origin_receipt)).toBe(true);
    expect(Object.isFrozen(first.semantic_judgment.judgment_binding)).toBe(true);
    input.originReceipt.attempt = 2;
    input.scope.tenant_slug = 'changed';
    input.proposal.title = 'changed';
    expect(first.semantic_judgment.origin_receipt.attempt).toBe(1);
    expect(first.semantic_judgment.scope).toEqual(before.scope);
    expect(first.title).toBe(before.proposal.title);
    // No storage is read here: this deliberately well-shaped invented selector is only authored.
    expect(first.semantic_judgment).not.toHaveProperty('persisted');
    expect(first.semantic_judgment).not.toHaveProperty('verified');
    expect(first.semantic_judgment).not.toHaveProperty('approval');
  });

  it('keeps absence off, but rejects null, malformed, unknown, oversized and lossy present bindings', () => {
    expect(parseDotJudgmentBinding(undefined)).toBeUndefined();
    const binding = bindSyntheticDotJudgmentProposal(fixture()).semantic_judgment;
    for (const value of [
      null,
      {},
      [],
      { ...binding, mode: 'shadow' },
      { ...binding, approval: true },
      { ...binding, effect_ref: 'x'.repeat(129) },
      { ...binding, effect_ref: ' ' },
      { ...binding, effect_policy_version: 'x'.repeat(17_000) },
      { ...binding, judgment_binding: { ...binding.judgment_binding, work_ref: ' incident-1 ' } },
      Object.defineProperty(structuredClone(binding), 'hidden', { value: true }),
      JSON.parse(
        JSON.stringify(binding).replace(
          '"schema_version":"1"',
          '"__proto__":{},"schema_version":"1"'
        )
      ),
    ])
      expect(() => parseDotJudgmentBinding(value)).toThrow();
    expect(parseDotJudgmentBinding(binding)).toEqual(binding);
  });

  it('validates all parent/effect/origin/scope identities using the shared evidence contract', () => {
    const binding = bindSyntheticDotJudgmentProposal(fixture()).semantic_judgment;
    for (const changed of [
      { evaluation_parent_key: 'f'.repeat(64) },
      { effect_key: 'f'.repeat(64) },
      { effect_ref: 'other-effect' },
      { scope: { ...binding.scope, tenant_slug: 'other-tenant' } },
      { judgment_binding: { ...binding.judgment_binding, scope_hash: 'f'.repeat(64) } },
      { judgment_binding: { ...binding.judgment_binding, model_config_hash: 'f'.repeat(64) } },
      { origin_receipt: { ...binding.origin_receipt, evaluation_key: 'f'.repeat(64) } },
      { origin_receipt: { ...binding.origin_receipt, effect_key: 'f'.repeat(64) } },
      { origin_receipt: { ...binding.origin_receipt, attempt: 0 } },
      { origin_receipt: { ...binding.origin_receipt, attempt: 129 } },
      { origin_receipt: { ...binding.origin_receipt, path: 'arbitrary/path' } },
    ])
      expect(() => parseDotJudgmentBinding({ ...binding, ...changed })).toThrow();
  });

  it('rejects pre-bound, shadow, diagnostic, managed and handoff authoring rather than stripping references', () => {
    const input = fixture();
    const bound = bindSyntheticDotJudgmentProposal(input);
    expect(() => bindSyntheticDotJudgmentProposal({ ...input, proposal: bound })).toThrow();
    for (const runtime of [
      { ...input.charter.runtime, semantic_judgment: { mode: 'shadow' as const } },
      { ...input.charter.runtime, execution_mode: 'front_desk_diagnostic' as const },
    ]) {
      expect(() =>
        bindSyntheticDotJudgmentProposal({ ...input, charter: { ...input.charter, runtime } })
      ).toThrow();
    }
    for (const field of [
      'semantic_judgment',
      'front_desk_execution',
      'continuous_work',
      'mission_admission',
      'handoff_to',
    ]) {
      expect(() =>
        bindSyntheticDotJudgmentProposal({ ...input, proposal: { ...input.proposal, [field]: {} } })
      ).toThrow();
    }
    expect(() =>
      bindSyntheticDotJudgmentProposal({
        ...input,
        mode: 'shadow',
      } as unknown as SyntheticDotJudgmentBindingInput)
    ).toThrow();
    expect(() =>
      bindSyntheticDotJudgmentProposal({
        ...input,
        charter: {
          ...input.charter,
          runtime: { ...input.charter.runtime, semantic_judgment: { mode: 'enforce' } },
        },
      } as unknown as SyntheticDotJudgmentBindingInput)
    ).toThrow();
  });

  it('requires exact canonical normalized proposals, allowed pipelines, active charter and complete matching scope', () => {
    const input = fixture();
    for (const proposal of [
      { ...input.proposal, work_shape: 'direct_reply' as const },
      { ...input.proposal, pipeline_ref: 'pipelines/unlisted.json' },
      { ...input.proposal, title: ' Repair fixture ' },
      { ...input.proposal, unknown: true },
      { ...input.proposal, action_id: 'chosen-action' },
    ]) {
      expect(() => bindSyntheticDotJudgmentProposal({ ...input, proposal })).toThrow();
    }
    for (const charter of [
      { ...input.charter, status: 'paused' as const },
      { ...input.charter, authority: { ...input.charter.authority, allowed_pipelines: [] } },
      { ...input.charter, authority: { ...input.charter.authority, allowed_work_shapes: [] } },
      { ...input.charter, scope: { ...input.charter.scope, project_id: 'other-project' } },
    ]) {
      expect(() => bindSyntheticDotJudgmentProposal({ ...input, charter })).toThrow();
    }
    expect(() =>
      bindSyntheticDotJudgmentProposal({
        ...input,
        scope: { ...input.scope, mission_id: 'MSN-OTHER' },
      })
    ).toThrow();
    expect(() =>
      bindSyntheticDotJudgmentProposal({ ...input, effectPolicyVersion: ' ' })
    ).toThrow();
    const getter = Object.defineProperty(structuredClone(input), 'effectRef', {
      enumerable: true,
      get: () => 'effect-1',
    });
    expect(() => bindSyntheticDotJudgmentProposal(getter)).toThrow();
  });

  it('pins full normalized proposal and charter config rather than the legacy truncated proposal identity', () => {
    const input = fixture();
    const original = bindSyntheticDotJudgmentProposal(input).semantic_judgment;
    for (const proposal of [
      { ...input.proposal, changed_paths: ['active/shared/tmp/fixture.json'] },
      { ...input.proposal, requested_decision: 'approve' as const },
      { ...input.proposal, target: 'service:fixture', intent: 'apply' as const },
    ]) {
      expect(
        bindSyntheticDotJudgmentProposal({ ...input, proposal }).semantic_judgment
          .original_proposal_hash
      ).not.toBe(original.original_proposal_hash);
    }
    for (const charter of [
      { ...input.charter, version: '1.0.1' },
      {
        ...input.charter,
        authority: { ...input.charter.authority, authority_role: 'changed-role' },
      },
    ]) {
      expect(
        bindSyntheticDotJudgmentProposal({ ...input, charter }).semantic_judgment.charter_hash
      ).not.toBe(original.charter_hash);
    }
    const baseHash = dotProposalHash('fixture-dot', input.proposal);
    expect(baseHash).toBe('f11c8efaa08fc96c');
    expect(
      dotProposalHash('fixture-dot', {
        ...input.proposal,
        target: 'service:fixture',
        intent: 'apply',
      })
    ).toBe('860ca2ee758ca32c');
    const before = genericDotActionIdentity(input.charter, input.proposal, 0, 'same-operation');
    bindSyntheticDotJudgmentProposal(input);
    expect(genericDotActionIdentity(input.charter, input.proposal, 0, 'same-operation')).toEqual(
      before
    );
    expect(input.proposal).not.toHaveProperty('semantic_judgment');
    // Stage a deliberately does not change legacy proposal/admission hash functions.
    expect(dotProposalHash('fixture-dot', input.proposal)).toBe(baseHash);
  });

  it('never treats even a valid authored reference as model input on tool or fenced paths', () => {
    const input = fixture();
    const bound = bindSyntheticDotJudgmentProposal(input);
    expect(() => normalizeDotProposal(bound)).toThrow(/reserved/);
    expect(collectDotProposals([bound])).toMatchObject({
      proposals: [],
      errors: [expect.stringContaining('reserved')],
    });
    expect(
      parseDotProposalsFromText('```dot-proposals\n' + JSON.stringify([bound]) + '\n```')
    ).toMatchObject({ proposals: [], errors: [expect.stringContaining('reserved')] });
  });

  it('validates trusted full proposals without mutating or rebinding their immutable origin', () => {
    const input = fixture();
    const proposal = bindSyntheticDotJudgmentProposal(input);
    const before = JSON.stringify(proposal);
    const binding = validateServerDotJudgmentProposal(proposal);
    expect(binding).toEqual(proposal.semantic_judgment);
    expect(binding).not.toBe(proposal.semantic_judgment);
    expect(Object.isFrozen(binding?.origin_receipt)).toBe(true);
    expect(JSON.stringify(proposal)).toBe(before);
    expect(() => normalizeDotProposal(proposal)).toThrow(/reserved/);
    expect(validateServerDotJudgmentProposal(input.proposal)).toBeUndefined();
    expect(
      validateServerDotJudgmentProposal({ ...input.proposal, semantic_judgment: undefined })
    ).toBeUndefined();
  });

  it('rejects changed facts, lossy bound objects, combined provenance and inventory indexes', () => {
    const proposal = bindSyntheticDotJudgmentProposal(fixture());
    const getter = vi.fn(() => proposal.semantic_judgment);
    const accessor = Object.defineProperty({ ...proposal }, 'semantic_judgment', {
      enumerable: true,
      get: getter,
    });
    const forgedUnknown = { ...proposal, ignored: 'must-not-be-dropped' };
    const baseWithUnknown = { ...fixture().proposal, ignored: 'must-not-be-dropped' };
    forgedUnknown.semantic_judgment = {
      ...proposal.semantic_judgment,
      original_proposal_hash: judgmentCanonicalHash(baseWithUnknown),
    };
    for (const changed of [
      { ...proposal, title: 'Changed work' },
      { ...proposal, pipeline_ref: 'pipelines/other.json' },
      { ...proposal, title: ' Repair fixture ' },
      { ...proposal, action_id: 'chosen-action' },
      { ...proposal, semantic_judgment: null },
      { ...proposal, work_shape: 'direct_reply' },
      { ...proposal, front_desk_execution: {} },
      { ...proposal, continuous_work: {} },
      { ...proposal, mission_admission: {} },
      { ...proposal, handoff_to: 'other-dot' },
      { ...proposal, private_content_hash: 'a'.repeat(64) },
      { ...fixture().proposal, private_content_hash: 'a'.repeat(64) },
      forgedUnknown,
      accessor,
      Object.defineProperty(structuredClone(proposal), 'hidden', { value: 1 }),
      Object.assign(structuredClone(proposal), { [Symbol('hidden')]: 1 }),
      Object.assign(
        Object.create({ semantic_judgment: proposal.semantic_judgment }),
        fixture().proposal
      ),
    ])
      expect(() => validateServerDotJudgmentProposal(changed as typeof proposal)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('appends only validated full judgment identity while retaining literal legacy proposal hashes', () => {
    const input = fixture();
    const bound = bindSyntheticDotJudgmentProposal(input);
    const baseHash = dotProposalHash('fixture-dot', input.proposal);
    expect(baseHash).toBe('f11c8efaa08fc96c');
    expect(
      dotProposalHash('fixture-dot', { ...input.proposal, semantic_judgment: undefined })
    ).toBe(baseHash);
    const boundHash = dotProposalHash('fixture-dot', bound);
    expect(boundHash).toHaveLength(16);
    expect(boundHash).not.toBe(baseHash);
    const changed = {
      ...bound,
      semantic_judgment: {
        ...bound.semantic_judgment,
        origin_receipt: {
          ...bound.semantic_judgment.origin_receipt,
          attempt: 2,
          content_hash: 'f'.repeat(64),
        },
      },
    };
    // A differently authored selector changes identity, but is not proven persisted by this parser.
    expect(dotProposalHash('fixture-dot', changed)).not.toBe(boundHash);
    const first = genericDotActionIdentity(input.charter, bound, 0, 'same-operation');
    const second = genericDotActionIdentity(input.charter, changed, 0, 'same-operation');
    expect(second.action_ref).toBe(first.action_ref);
    expect(second.admission?.semantic_hash).not.toBe(first.admission?.semantic_hash);
    expect(first.admission?.proposal.semantic_judgment?.origin_receipt.attempt).toBe(1);
    expect(() => dotProposalHash('fixture-dot', { ...bound, objective: 'Changed work' })).toThrow();
  });
});
