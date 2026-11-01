/** Synthetic owner/request storage fixture; no human approval or external notification is fabricated. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeRoot } from '../secure-io.js';
vi.mock('../surface/operator-notifications.js', async (original) => ({
  ...(await original<typeof import('../surface/operator-notifications.js')>()),
  notifyOperatorSync: vi.fn(() => false),
}));
const previous = process.cwd();
const root = path.join(previous, 'active/shared/tmp', `development-consent-${randomUUID()}`);
let authority: typeof import('../authority.js');
let route: typeof import('../governance/approval-decision-routing.js');
let store: typeof import('../governance/approval-store.js');
let location: typeof import('../governance/approval-store-location.js');
let presentation: typeof import('./continuous-development-consent.js');
let identity: typeof import('../dot/dot-admission-identity.js');
let envelopes: typeof import('../scope-envelope.js');
let resident: typeof import('../dot/dot-key-results.js');
beforeAll(async () => {
  seedFirstJobTestRoot(previous, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const key of [
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_PROJECT_ID',
    'KYBERION_TASK_ID',
    'KYBERION_CUSTOMER',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('KYBERION_TIER', 'public');
  vi.stubEnv('KYBERION_NHI_ID', 'synthetic-consent-owner');
  vi.resetModules();
  authority = await import('../authority.js');
  route = await import('../governance/approval-decision-routing.js');
  store = await import('../governance/approval-store.js');
  location = await import('../governance/approval-store-location.js');
  presentation = await import('./continuous-development-consent.js');
  identity = await import('../dot/dot-admission-identity.js');
  envelopes = await import('../scope-envelope.js');
  resident = await import('../dot/dot-key-results.js');
}, 60000);
afterAll(() => {
  process.chdir(previous);
  vi.unstubAllEnvs();
  removeRoot(root, { recursive: true, force: true });
});
describe('personal development approval placement', () => {
  it('keeps the actual routed personal request out of system/public storage and another owner reads', async () =>
    authority.withExecutionContextAsync('infrastructure_sentinel', async () => {
      const charter = {
        dot_id: 'synthetic-owner',
        title: 'Synthetic owner',
        scope: { tier: 'personal', owner_nhi: 'synthetic-consent-owner', organization_id: 'ops' },
        authority: { authority_role: 'organization_operator' },
      } as unknown as import('../dot/dot-charter.js').DotCharter;
      const proposal = {
        action_id: 'dot_delegate_work',
        title: 'Develop',
        objective: 'Implement approved change',
        work_shape: 'pipeline',
        pipeline_ref: 'pipelines/continuous-managed-work.json',
        continuous_work: {
          kind: 'mission',
          missions: [
            {
              key: 'improve',
              title: 'Improve',
              goal: 'Improve',
              success_condition: 'Verified merge',
              development: {
                cwd: '.',
                repository_url: 'https://github.com/owner/private-repository',
                source_edit_paths: ['libs/core/example.ts'],
                implementation_task_id: 'execution-implement',
                review_task_id: 'self_review-code-review',
                title: 'fix: improve',
                body_file: 'evidence/pr-body.md',
              },
            },
          ],
        },
      } as import('../dot/dot-proposals.js').DotProposal;
      const binding = identity.genericDotActionIdentity(charter, proposal, 0, 'synthetic-consent');
      const visible = presentation.continuousDevelopmentDecisionPresentation(charter, {
        ...binding,
        title: proposal.title,
        objective: proposal.objective,
        continuous_work: proposal.continuous_work,
      })!;
      const requestId = await resident.runAsDotCharter(charter, async () => {
        expect(envelopes.currentScopeEnvelope()?.identity).toMatchObject({
          tier: 'personal',
          nhi_id: 'synthetic-consent-owner',
          organization_id: 'ops',
        });
        expect(process.env.KYBERION_TIER).toBe('public');
        const routed = route.routeAutonomousDecision({
          role: 'infrastructure_sentinel',
          gate: {
            actionId: 'dot_delegate_work',
            decision: 'approve',
            allowed: true,
            score: 0,
            maxScore: 6,
            policyVersion: 'synthetic',
            executionMode: 'apply',
            reason: 'Synthetic approved-plan request',
            axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
            shadow: false,
            escalations: [],
            highRiskPathMatches: [],
          },
          title: 'Synthetic development plan',
          question: visible.question,
          evidence: visible.evidence,
          scope: visible.scope,
          recommendation: 'Review the full exact-file scope',
          requestedBy: 'dot:synthetic-owner',
          accountability: {
            payloadHash: binding.admission!.semantic_hash,
            effectBinding: `continuous-work:${binding.action_ref}`,
          },
          notificationRoute: { surface: 'inbox', target: 'dot:synthetic-owner' },
        });
        expect(routed.requestId).toBeTruthy();
        const request = store.loadApprovalRequest('autonomy', routed.requestId!)!;
        expect(request.scope).toMatchObject({
          tier: 'personal',
          nhi_id: 'synthetic-consent-owner',
        });
        expect(request.scope?.tenant_slug).toBeUndefined();
        expect(
          location.locateApprovalRequest('autonomy', routed.requestId!)?.partition.kind
        ).not.toBe('system');
        return routed.requestId!;
      });
      vi.stubEnv('KYBERION_NHI_ID', 'synthetic-other-owner');
      expect(store.loadApprovalRequest('autonomy', requestId)).toBeNull();
    }));
});
