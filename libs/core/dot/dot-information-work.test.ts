import { describe, it, expect } from 'vitest';
import { informationWorkProposalRefusal, type DotScopedProposal } from './dot-information-work.js';
import type { DotCharter } from './dot-charter.js';
const scope = { tenant_slug: 'acme', organization_id: 'support' };
const charter = { scope: { ...scope, tier: 'confidential' } } as DotCharter;
const proposal: DotScopedProposal = {
  action_id: 'dot_delegate_work',
  work_shape: 'pipeline',
  pipeline_ref: 'knowledge/product/pipeline-templates/information-asset-work.json',
  information_asset_work: {
    version: 1,
    recipe_id: 'jira.approval_pending',
    recipe_version: 1,
    work_key: 'a'.repeat(64),
    observation: {
      event_id: 'e'.repeat(64),
      scope,
      asset_type: 'workflow.approval_request',
      location_id: 'jira',
      binding_id: 'jira-binding',
      service_id: 'jira',
      subject_id: 'SUP-1/approval/1',
      change_id: 'revision1',
      event_type: 'approval.observed',
      content_sha256: 'c'.repeat(64),
    },
  },
};
describe('trusted information work scope bounds', () => {
  it('accepts the declared pipeline and the separately governed mission-admission shape', () => {
    expect(informationWorkProposalRefusal(charter, proposal)).toBeUndefined();
    expect(
      informationWorkProposalRefusal(charter, {
        ...proposal,
        work_shape: 'mission',
        mission_admission: {
          mandate_ref: 'existing',
          mandate_facts: {
            work_type: 'fixture',
            paths: ['active/'],
            estimated_cost: 0,
            currency: 'USD',
            external_effects: ['jira:answer_request_approval'],
            risk_level: 3,
          },
        },
      })
    ).toBeUndefined();
  });
  it('refuses mission work without its admission, wrong pipeline, and scope widening', () => {
    expect(
      informationWorkProposalRefusal(charter, { ...proposal, work_shape: 'mission' })
    ).toMatchObject({ ok: false });
    expect(
      informationWorkProposalRefusal(charter, { ...proposal, pipeline_ref: 'arbitrary.json' })
    ).toMatchObject({ ok: false });
    expect(
      informationWorkProposalRefusal(
        { ...charter, scope: { ...charter.scope, tenant_slug: 'other' } },
        proposal
      )
    ).toMatchObject({ ok: false });
  });
});
