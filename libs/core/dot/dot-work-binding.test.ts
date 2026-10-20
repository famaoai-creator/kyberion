import { describe, expect, it } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { DotActionRecord } from './dot-action-ledger.js';
import { dotAdmissionScopeHash, genericDotActionIdentity } from './dot-admission-identity.js';
import { dotWorkItemInput } from './dot-work-item.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import { addressedTo } from './dot-executor-reports.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';

const charter: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'operation-supervisor',
  version: '1.0.0',
  title: 'Operation supervisor',
  purpose: 'Keep one operation healthy',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'tenant-a', organization_id: 'org-a' },
  goal: { statement: 'Produce the weekly report' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * 1' }] },
  authority: { authority_role: 'organization_operator' },
  notification: { deliver_to: { surface: 'surface', channel: 'operator' } },
  runtime: { heartbeat_id: 'operation-supervisor' },
};
describe('frozen operation work responsibility', () => {
  it('preserves unbound identities but separates the same dot after operation rebinding', () => {
    expect(dotAdmissionScopeHash(charter)).toBe(
      recoveryEvidenceHash({ dot_id: charter.dot_id, scope: charter.scope })
    );
    const first = { ...charter, work_binding: { operation_id: 'weekly-report' } };
    const other = { ...charter, work_binding: { operation_id: 'monthly-close' } };
    expect(dotAdmissionScopeHash(first)).not.toBe(dotAdmissionScopeHash(other));
    expect(dotAdmissionScopeHash(first)).not.toBe(dotAdmissionScopeHash(charter));
  });
  it('stamps binding from the charter and refuses relabeling admitted work', () => {
    const first = { ...charter, work_binding: { operation_id: 'weekly-report' } };
    const proposal = {
      action_id: 'dot.work.direct_reply' as const,
      title: 'Report',
      objective: 'Review report',
      work_shape: 'direct_reply' as const,
    };
    const identity = genericDotActionIdentity(first, proposal, 0, 'wake-1');
    const record: DotActionRecord = {
      ...identity,
      dot_id: first.dot_id,
      actor_id: `dot:${first.dot_id}`,
      action_id: proposal.action_id,
      title: proposal.title,
      objective: proposal.objective,
      work_shape: proposal.work_shape,
      status: 'admitted',
      proposal_hash: 'hash',
      at: '2026-10-21T00:00:00Z',
    };
    const input = dotWorkItemInput(first, record);
    expect(input.metadata?.operation_id).toBe('weekly-report');
    expect(input.context).not.toHaveProperty('operation_id');
    expect(() =>
      dotWorkItemInput({ ...first, work_binding: { operation_id: 'monthly-close' } }, record)
    ).toThrow('DOT_WORK_BINDING');
    expect(() => dotWorkItemInput(charter, record)).toThrow('DOT_WORK_BINDING');
    const item = { metadata: { ...input.metadata, handoff_to: first.dot_id } } as WorkItem;
    expect(addressedTo(first, item)).toBe(true);
    expect(addressedTo({ ...first, work_binding: { operation_id: 'monthly-close' } }, item)).toBe(
      false
    );
  });
});
