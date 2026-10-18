import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  ledger: vi.fn(),
  approval: vi.fn(),
  expired: vi.fn(),
  usable: vi.fn(),
}));
vi.mock('../dot/dot-action-ledger.js', () => ({ readDotActionLedgerStrict: mocks.ledger }));
vi.mock('../governance/approval-store.js', () => ({
  loadApprovalRequest: mocks.approval,
  isApprovalRequestExpired: mocks.expired,
}));
vi.mock('../governance/approval-linked-usability.js', () => ({
  approvalUsabilityRefusal: mocks.usable,
}));
import { authorizeItem } from './continuous-work-owner-state.js';
import { genericDotActionIdentity } from '../dot/dot-admission-identity.js';
import { dotWorkItemInput } from '../dot/dot-work-item.js';
import { CONTINUOUS_MANAGED_WORK_PIPELINE } from './continuous-work-plan.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotActionRecord } from '../dot/dot-action-ledger.js';
import type { DotProposal } from '../dot/dot-proposals.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
const charter = {
  dot_id: 'operator',
  scope: {
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org',
    project_id: 'PRJ-ONE',
  },
  authority: { authority_role: 'organization_operator' },
} as DotCharter;
function fixture() {
  const proposal: DotProposal = {
    action_id: 'dot_delegate_work',
    title: 'Repair',
    objective: 'Reduce errors',
    work_shape: 'pipeline',
    pipeline_ref: CONTINUOUS_MANAGED_WORK_PIPELINE,
    continuous_work: {
      kind: 'mission',
      missions: [
        { key: 'repair', title: 'Repair', goal: 'Fix cause', success_condition: 'No errors' },
      ],
    },
  };
  const identity = genericDotActionIdentity(charter, proposal, 0, 'stable');
  const record = {
    ...proposal,
    ...identity,
    dot_id: 'operator',
    status: 'dispatched',
    decision: 'approve',
    request_id: 'request-1',
  } as DotActionRecord;
  const input = dotWorkItemInput(charter, record, '/repo');
  const item = {
    item_id: input.itemId,
    metadata: input.metadata,
    context: input.context,
  } as WorkItem;
  record.work_item_id = item.item_id;
  const approval = {
    status: 'approved',
    decidedByType: 'human',
    decidedBy: 'user:owner',
    accountability: {
      payloadHash: record.admission!.semantic_hash,
      effectBinding: `continuous-work:${record.action_ref}`,
    },
  };
  mocks.ledger.mockReturnValue([record]);
  mocks.approval.mockReturnValue(approval);
  return { record, item, approval };
}
describe('continuous owner immutable authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expired.mockReturnValue(false);
    mocks.usable.mockReturnValue(undefined);
  });
  it('requires the exact payload and effect approval, rejecting approval transplant and AI decisions', () => {
    const f = fixture();
    expect(() => authorizeItem(charter, f.item, '/repo')).not.toThrow();
    f.approval.accountability.effectBinding = 'continuous-work:another-operation';
    expect(() => authorizeItem(charter, f.item, '/repo')).toThrow('human approval');
    f.approval.accountability.effectBinding = `continuous-work:${f.record.action_ref}`;
    f.approval.decidedByType = 'ai_agent';
    expect(() => authorizeItem(charter, f.item, '/repo')).toThrow('human approval');
  });
  it('rejects modified WorkItem plans and admission scope before checking approval', () => {
    const f = fixture();
    f.item.metadata = { ...f.item.metadata, continuous_work: { kind: 'project', missions: [] } };
    expect(() => authorizeItem(charter, f.item, '/repo')).toThrow('immutable');
    expect(mocks.approval).not.toHaveBeenCalled();
    const g = fixture();
    g.record.admission!.scope_hash = 'other-scope';
    expect(() => authorizeItem(charter, g.item, '/repo')).toThrow('binding changed');
  });
  it('rejects expiry and separation-of-duties refusals', () => {
    const f = fixture();
    mocks.expired.mockReturnValue(true);
    expect(() => authorizeItem(charter, f.item, '/repo')).toThrow('human approval');
    mocks.expired.mockReturnValue(false);
    mocks.usable.mockReturnValue('self approval refused');
    expect(() => authorizeItem(charter, f.item, '/repo')).toThrow('human approval');
  });
  it('allows immutable history reads after approval expiry while still rejecting plan tampering', () => {
    const f = fixture();
    mocks.expired.mockReturnValue(true);
    expect(() => authorizeItem(charter, f.item, '/repo', false)).not.toThrow();
    expect(mocks.approval).not.toHaveBeenCalled();
    f.item.metadata = { ...f.item.metadata, continuous_work: { kind: 'mission', missions: [] } };
    expect(() => authorizeItem(charter, f.item, '/repo', false)).toThrow('immutable');
  });
});
