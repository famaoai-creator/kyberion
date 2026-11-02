import { describe, it, expect } from 'vitest';
import { normalizeDotProposal, proposalActionIdentity, type DotProposal } from './dot-proposals.js';
import {
  dotProposalHash,
  assertDotActionInformationBinding,
  type DotActionRecord,
} from './dot-action-ledger.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import type { InformationAssetWorkBinding } from '../information-assets/work-types.js';
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'tenant-a',
  organization_id: 'org-a',
  project_id: 'project-a',
};
const binding: InformationAssetWorkBinding = {
  version: 1,
  recipe_id: 'github.review',
  recipe_version: 1,
  work_key: 'a'.repeat(64),
  observation: {
    event_id: 'b'.repeat(64),
    scope: { tenant_slug: 'tenant-a', organization_id: 'org-a', project_id: 'project-a' },
    asset_type: 'code.review_request',
    location_id: 'github-a',
    binding_id: 'binding-a',
    service_id: 'github',
    subject_id: 'owner/repo#1',
    change_id: 'head-1',
    event_type: 'review_requested',
    content_sha256: 'c'.repeat(64),
  },
};
const proposal: DotProposal = {
  action_id: 'dot_delegate_work',
  title: 'Review',
  objective: 'Review pull request',
  work_shape: 'pipeline',
  pipeline_ref: 'knowledge/product/pipeline-templates/information-asset-work.json',
  information_asset_work: binding,
};
describe('trusted information work origin', () => {
  it('rejects every model-authored reserved binding including undefined', () => {
    for (const value of [undefined, null, {}, binding])
      expect(() => normalizeDotProposal({ ...proposal, information_asset_work: value })).toThrow(
        'reserved'
      );
  });
  it('binds dedupe and approval supersession to recipe revision', () => {
    const next = {
      ...proposal,
      information_asset_work: {
        ...binding,
        observation: { ...binding.observation, change_id: 'head-2' },
      },
    };
    expect(dotProposalHash('reviewer', proposal)).not.toBe(dotProposalHash('reviewer', next));
    expect(proposalActionIdentity(proposal)).not.toBe(proposalActionIdentity(next));
  });
  it('rejects mutated work origins and scope before executable recovery', () => {
    const record = {
      ...proposal,
      scope,
      admission: {
        kind: 'dot-operation',
        operation_key: 'recipe',
        ordinal: 0,
        authority_role: 'ecosystem_architect',
        scope_hash: 'a'.repeat(64),
        semantic_hash: recoveryEvidenceHash(proposal),
        proposal,
      },
    } as unknown as DotActionRecord;
    expect(() => assertDotActionInformationBinding(record)).not.toThrow();
    expect(() =>
      assertDotActionInformationBinding({
        ...record,
        information_asset_work: {
          ...binding,
          observation: { ...binding.observation, change_id: 'tampered' },
        },
      })
    ).toThrow('admission');
    expect(() =>
      assertDotActionInformationBinding({ ...record, scope: { ...scope, tenant_slug: 'tenant-b' } })
    ).toThrow('scope');
    expect(() =>
      assertDotActionInformationBinding({ ...record, pipeline_ref: 'pipelines/other.json' })
    ).toThrow('executable field');
    expect(() =>
      assertDotActionInformationBinding({ ...record, private_content_hash: 'private' })
    ).toThrow('not executable');
  });
});
