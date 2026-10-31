/** Pure identity checks. These hand-authored records are not proof of a real human decision. */
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { normalizeEventScope } from '../event-scope.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import { judgmentEvidenceParent } from '../organization/judgment-evidence.js';
import { createJudgmentLatencyFixture } from '../organization/judgment-latency-fixture.js';
import { bindSyntheticDotJudgmentProposal } from './dot-judgment-binding.js';
import { genericDotActionIdentity } from './dot-admission-identity.js';
import { dotProposalHash, type DotActionRecord } from './dot-action-ledger.js';
import { normalizeDotProposal, proposalActionIdentity } from './dot-proposals.js';
import {
  dotJudgmentApprovalMatches,
  dotJudgmentApprovalRouteFields,
  dotJudgmentApprovalFeedbackReady,
  requireCurrentDotJudgmentApproval,
} from './dot-judgment-approval.js';

function fixture() {
  const data = createJudgmentLatencyFixture();
  const proposal = normalizeDotProposal({
    title: 'Fixture repair',
    objective: 'Keep the original goal',
    work_shape: 'pipeline',
    pipeline_ref: data.charter.authority.allowed_pipelines![0],
  });
  const binding = {
    schema_version: '1' as const,
    work_ref: 'work',
    work_revision: '1',
    trigger_key: 'trigger',
    scope_hash: judgmentCanonicalHash(data.scope),
    request_hash: 'a'.repeat(64),
    evidence_hash: 'b'.repeat(64),
    precedent_snapshot_hash: 'c'.repeat(64),
    policy_version: 'semantic-policy',
    rubric_version: 'rubric',
    evaluator_version: 'evaluator',
    model_config_hash: 'd'.repeat(64),
  };
  const parent = judgmentEvidenceParent({ scope: data.scope, binding, effectRef: 'effect' });
  const bound = bindSyntheticDotJudgmentProposal({
    mode: 'synthetic_fixture',
    charter: data.charter,
    proposal,
    scope: data.scope,
    judgmentBinding: binding,
    originReceipt: { ...parent, attempt: 1, content_hash: 'e'.repeat(64) },
    effectRef: 'effect',
    effectPolicyVersion: 'effect-policy',
  });
  const record: DotActionRecord = {
    scope: data.scope,
    ...genericDotActionIdentity(data.charter, bound, 0, 'wake'),
    semantic_judgment: bound.semantic_judgment,
    dot_id: data.charter.dot_id,
    actor_id: `dot:${data.charter.dot_id}`,
    action_id: bound.action_id,
    title: bound.title,
    objective: bound.objective,
    work_shape: bound.work_shape,
    pipeline_ref: bound.pipeline_ref,
    proposal_hash: dotProposalHash(data.charter.dot_id, bound),
    status: 'parked',
    decision: 'approve',
    request_id: 'request-1',
    at: '2026-10-31T00:00:00.000Z',
  };
  const route = dotJudgmentApprovalRouteFields(data.charter, record);
  const approval: ApprovalRequestRecord = {
    id: 'request-1',
    kind: 'channel-approval',
    storageChannel: 'autonomy',
    channel: 'inbox',
    threadTs: '',
    correlationId: 'fixture',
    requestedBy: record.actor_id,
    requestedAt: record.at,
    title: 'Fixture',
    summary: 'Synthetic',
    severity: 'high',
    status: 'pending',
    accountability: { ...route.accountability!, finalDecision: 'human_only' },
    source: { agentId: record.actor_id, actionId: proposalActionIdentity(bound) },
    scope: normalizeEventScope(data.scope),
  };
  return { data, record, approval, bound, proposal, route };
}

describe('judged approval identity without new decision policy', () => {
  it('uses the existing complete admission hash and fixed action-ref effect identity', () => {
    const f = fixture();
    expect(f.route).toEqual({
      accountability: {
        payloadHash: f.record.admission!.semantic_hash,
        effectBinding: `dot-judgment:${f.record.action_ref}`,
      },
      scope: normalizeEventScope(f.data.scope),
    });
    expect(dotJudgmentApprovalMatches(f.data.charter, f.record, f.approval)).toBe(true);
    expect(dotJudgmentApprovalFeedbackReady(f.data.charter, f.record, f.approval, NaN)).toBe(true); // Pending: no effect permission.
    expect(() =>
      requireCurrentDotJudgmentApproval(f.data.charter, f.record, {
        loadApproval: () => f.approval,
      })
    ).toThrow();
  });
  it('requires exact request, requester, source, full scope and payload/effect accountability', () => {
    const f = fixture();
    for (const changed of [
      null,
      { ...f.approval, id: 'other' },
      { ...f.approval, requestedBy: 'dot:other' },
      { ...f.approval, source: { ...f.approval.source, agentId: 'dot:other' } },
      { ...f.approval, source: { ...f.approval.source, actionId: 'other' } },
      {
        ...f.approval,
        scope: normalizeEventScope({ ...f.data.scope, tenant_slug: 'other-tenant' }),
      },
      {
        ...f.approval,
        scope: normalizeEventScope({ tier: 'confidential', tenant_slug: f.data.scope.tenant_slug }),
      },
      { ...f.approval, accountability: undefined },
      { ...f.approval, accountability: { finalDecision: 'human_only' as const } },
      {
        ...f.approval,
        accountability: { ...f.approval.accountability!, payloadHash: 'f'.repeat(64) },
      },
      {
        ...f.approval,
        accountability: { ...f.approval.accountability!, effectBinding: 'dot-judgment:other' },
      },
    ])
      expect(dotJudgmentApprovalMatches(f.data.charter, f.record, changed)).toBe(false);
    const getter = vi.fn(() => f.approval.id);
    const accessor = Object.defineProperty({ ...f.approval }, 'id', {
      enumerable: true,
      get: getter,
    });
    expect(dotJudgmentApprovalMatches(f.data.charter, f.record, accessor)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('keeps valid negative statuses distinct from usable positive approvals and respects existing expiry rules', () => {
    const f = fixture();
    const time = Date.parse(f.record.at);
    for (const status of ['rejected', 'cancelled', 'expired'] as const)
      expect(
        dotJudgmentApprovalFeedbackReady(f.data.charter, f.record, { ...f.approval, status }, time)
      ).toBe(true);
    for (const status of ['approved', 'applied'] as const) {
      const expired = { ...f.approval, status, expiresAt: f.record.at };
      expect(dotJudgmentApprovalFeedbackReady(f.data.charter, f.record, expired, time)).toBe(false);
      expect(
        dotJudgmentApprovalFeedbackReady(
          f.data.charter,
          f.record,
          { ...expired, expiresAt: 'bad' },
          time
        )
      ).toBe(false);
    }
    expect(
      dotJudgmentApprovalFeedbackReady(
        { ...f.data.charter, status: 'paused' },
        f.record,
        f.approval,
        time
      )
    ).toBe(false);
  });

  it('binds the immutable origin selector and action ref through existing admission/effect identities', () => {
    const f = fixture();
    const changed = {
      ...f.bound,
      semantic_judgment: {
        ...f.bound.semantic_judgment,
        origin_receipt: {
          ...f.bound.semantic_judgment.origin_receipt,
          attempt: 2,
          content_hash: 'f'.repeat(64),
        },
      },
    };
    const record = {
      ...f.record,
      ...genericDotActionIdentity(f.data.charter, changed, 0, 'wake'),
      semantic_judgment: changed.semantic_judgment,
      proposal_hash: dotProposalHash(f.data.charter.dot_id, changed),
    };
    expect(record.action_ref).toBe(f.record.action_ref);
    expect(record.admission?.semantic_hash).not.toBe(f.record.admission?.semantic_hash);
    expect(dotJudgmentApprovalMatches(f.data.charter, record, f.approval)).toBe(false);
    expect(
      dotJudgmentApprovalMatches(
        f.data.charter,
        { ...f.record, action_ref: 'different-action' },
        f.approval
      )
    ).toBe(false);
    const missing = structuredClone(f.record);
    delete (missing.semantic_judgment as unknown as { origin_receipt?: unknown }).origin_receipt;
    expect(dotJudgmentApprovalMatches(f.data.charter, missing, f.approval)).toBe(false);
  });
  it('does not upgrade legacy metadata or load approval evidence for ordinary off work', () => {
    const f = fixture();
    const record = {
      ...f.record,
      admission: genericDotActionIdentity(f.data.charter, f.proposal, 0, 'wake').admission,
    };
    delete record.semantic_judgment;
    expect(dotJudgmentApprovalRouteFields(f.data.charter, record)).toEqual({});
    expect(dotJudgmentApprovalMatches(f.data.charter, record, null)).toBe(true);
    const load = vi.fn(() => f.approval);
    expect(
      requireCurrentDotJudgmentApproval(f.data.charter, record, { loadApproval: load })
    ).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    const now = vi.fn(() => {
      throw new Error('Legacy must not consume an additional clock sample');
    });
    expect(dotJudgmentApprovalFeedbackReady(f.data.charter, record, null, now)).toBe(true);
    expect(now).not.toHaveBeenCalled();
    const missing = { ...f.record };
    delete missing.request_id;
    expect(() =>
      requireCurrentDotJudgmentApproval(f.data.charter, missing, { loadApproval: load })
    ).toThrow(/missing/);
  });
});
