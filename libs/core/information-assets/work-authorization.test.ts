import { describe, it, expect } from 'vitest';
import { subjectAuthorization } from '../foundation/authorization-registry.js';
import { approvalChannelResolution } from '../foundation/approval-domains.js';
import {
  serializeRegistryDocument,
  evaluatePolicyDocument,
  normalizeAuthorizationRequest,
} from '../foundation/authorization-policy-document.js';
const subjects = [
  'service:information_asset_work',
  'service:google-workspace:preset:gmail_reply',
  'service:github:preset:resolve_review_thread',
  'service:jira:preset:answer_request_approval',
  'service:jira:preset:transition_issue',
  'service:jira:preset:add_comment',
];
describe('reviewed information work authorization subjects', () => {
  it('declares wrapper and each real fixed external target, with a declared approval domain', () => {
    for (const subject of subjects) {
      const entry = subjectAuthorization(subject);
      expect(entry).toMatchObject({
        axis: 'operation',
        subject,
        declared: true,
        source: 'code',
        effectClass: 'external_mutation',
        authority: { kind: 'admission', boundary: 'external' },
        approvalDomain: 'external-operation',
        protectedPaths: [['params']],
      });
      expect(approvalChannelResolution(entry.approvalDomain!)).toMatchObject({
        declared: true,
        kind: 'domain',
      });
    }
  });
  it('preserves the real service target subject and approval domain in the Cedar-compatible document', () => {
    const document = serializeRegistryDocument();
    for (const subject of subjects) {
      expect(
        document.policies.find((p) => p.subject === subject && p.match === 'exact')
      ).toMatchObject({
        subject_axis: 'operation',
        effect_class: 'external_mutation',
        approval_domain: 'external-operation',
        protected_paths: [['params']],
      });
      const request = (context: Record<string, unknown>) =>
        normalizeAuthorizationRequest({
          principal: { id: 'mission-owner', kind: 'agent' },
          action: { subject },
          context,
        });
      expect(evaluatePolicyDocument(document, request({}))).toMatchObject({
        kind: 'require_approval',
        approvalDomain: 'external-operation',
      });
      expect(
        evaluatePolicyDocument(document, request({ admissionGranted: 'internal' }))
      ).toMatchObject({ kind: 'require_approval' });
      expect(evaluatePolicyDocument(document, request({ admissionGranted: 'external' }))).toEqual({
        kind: 'permit',
      });
    }
  });
});
