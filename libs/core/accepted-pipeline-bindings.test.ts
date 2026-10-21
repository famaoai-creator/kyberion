import { describe, expect, it } from 'vitest';

import type { ApprovalRequestRecord } from './governance/approval-store.js';
import { pathResolver } from './path-resolver.js';
import {
  acceptedBindingGovernanceAllowsBypass,
  acceptedBindingMatchesPipelineHash,
  acceptedPipelineBindingCatalogPath,
  loadAcceptedPipelineBindingCatalog,
  resolveAcceptedPipelineBindingFromCatalog,
  validateAcceptedBindingCatalogScope,
  validateAcceptedPipelineRunState,
  validatePipelineBindingApproval,
  type AcceptedPipelineBinding,
} from './accepted-pipeline-bindings.js';

const hash = 'a'.repeat(64);
const binding: AcceptedPipelineBinding = {
  binding_id: 'accepted-test',
  pipeline_ref: 'pipelines/baseline-check.json',
  intent_ids: ['check-kyberion-baseline'],
  scope: { tier: 'public' },
  successful_run_evidence: {
    pipeline_sha256: hash,
    completed_at: '2026-09-16T00:00:00.000Z',
    evidence_digest: 'b'.repeat(64),
  },
  approval_request_id: '00000000-0000-4000-8000-000000000001',
  accepted_at: '2026-09-16T00:01:00.000Z',
  status: 'active',
};

function approval(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'channel-approval',
    storageChannel: 'pipeline-binding',
    channel: 'terminal',
    threadTs: 'test',
    correlationId: `pipeline-binding:${hash}`,
    requestedBy: 'pipeline-binding-cli',
    requestedAt: '2026-09-16T00:00:00.000Z',
    status: 'approved',
    title: 'test',
    summary: 'test',
    decidedBy: 'human:user-1',
    decidedByType: 'human',
    authenticated: true,
    decidedAuthMethod: 'passkey',
    accountability: {
      finalDecision: 'human_only',
      payloadHash: hash,
      effectBinding: 'accepted-pipeline-binding:v1',
    },
    ...overrides,
  };
}

describe('accepted pipeline bindings', () => {
  it('ships an empty public catalog rather than fabricated acceptance', () => {
    expect(loadAcceptedPipelineBindingCatalog()).toEqual({ version: 1, bindings: [] });
  });

  it('maps each data tier to a physically separate catalog', () => {
    expect(acceptedPipelineBindingCatalogPath({ tier: 'public' })).toBe(
      'knowledge/product/orchestration/accepted-pipeline-bindings.json'
    );
    expect(
      acceptedPipelineBindingCatalogPath({ tier: 'confidential', tenant_slug: 'tenant-a' })
    ).toBe('knowledge/confidential/tenant-a/orchestration/accepted-pipeline-bindings.json');
    expect(
      acceptedPipelineBindingCatalogPath({
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        organization_id: 'org-a',
        project_id: 'project-a',
      })
    ).toBe(
      'knowledge/confidential/tenant-a/orchestration/organizations/org-a/projects/project-a/accepted-pipeline-bindings.json'
    );
    expect(acceptedPipelineBindingCatalogPath({ tier: 'personal' })).toBe(
      'knowledge/personal/orchestration/accepted-pipeline-bindings.json'
    );
    expect(
      acceptedPipelineBindingCatalogPath({
        tier: 'personal',
        tenant_slug: 'tenant-a',
        organization_id: 'org-a',
      })
    ).toBe(
      'knowledge/personal/orchestration/tenants/tenant-a/organizations/org-a/accepted-pipeline-bindings.json'
    );
    expect(() =>
      acceptedPipelineBindingCatalogPath({
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        organization_id: '..',
      })
    ).toThrow(/invalid organization_id/u);
    expect(() =>
      acceptedPipelineBindingCatalogPath({
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        project_id: '.',
      })
    ).toThrow(/invalid project_id/u);
  });

  it('rejects foreign-scope rows in physical overlays', () => {
    expect(() =>
      validateAcceptedBindingCatalogScope(
        {
          version: 1,
          bindings: [
            {
              ...binding,
              scope: { tier: 'confidential', tenant_slug: 'tenant-b' },
            },
          ],
        },
        { tier: 'confidential', tenant_slug: 'tenant-a' }
      )
    ).toThrow(/foreign-scope/u);
    expect(() =>
      validateAcceptedBindingCatalogScope(
        { version: 1, bindings: [{ ...binding, scope: { tier: 'personal' } }] },
        { tier: 'public' }
      )
    ).toThrow(/foreign-scope/u);
  });

  it('requires a real exact-effect authenticated-human approval', () => {
    expect(() =>
      validatePipelineBindingApproval(
        'arbitrary-reference' as unknown as Parameters<typeof validatePipelineBindingApproval>[0],
        hash
      )
    ).toThrow(/not approved/u);
    expect(() =>
      validatePipelineBindingApproval(approval({ decidedByType: 'ai_agent' }), hash)
    ).toThrow(/authenticated human/u);
    expect(() =>
      validatePipelineBindingApproval(approval({ decidedAuthMethod: 'local_token' }), hash)
    ).toThrow(/authenticated human/u);
    expect(() =>
      validatePipelineBindingApproval(
        approval({
          accountability: {
            finalDecision: 'human_only',
            payloadHash: 'c'.repeat(64),
            effectBinding: 'accepted-pipeline-binding:v1',
          },
        }),
        hash
      )
    ).toThrow(/exact effect/u);
    expect(validatePipelineBindingApproval(approval(), hash).id).toBe(binding.approval_request_id);
  });

  it('invalidates a binding when pipeline content changes', () => {
    expect(acceptedBindingMatchesPipelineHash(binding, hash)).toBe(true);
    expect(acceptedBindingMatchesPipelineHash(binding, 'd'.repeat(64))).toBe(false);
  });

  it('accepts only canonical successful exact-path run journal state', () => {
    const state = {
      run_id: 'run-1',
      path: pathResolver.rootResolve('active/shared/runtime/pipeline-runs/run-1.jsonl'),
      events: [
        {
          version: 3,
          sequence: 1,
          run_id: 'run-1',
          event: 'run_started' as const,
          timestamp: '2026-09-16T00:00:00.000Z',
          payload: {},
        },
        {
          version: 3,
          sequence: 2,
          run_id: 'run-1',
          event: 'run_finished' as const,
          timestamp: '2026-09-16T00:01:00.000Z',
          payload: { status: 'succeeded' },
        },
      ],
      started: {
        pipeline_id: 'baseline-check',
        input_path: 'pipelines/baseline-check.json',
        pipeline_sha256: hash,
        step_ids: [],
      },
      completed_nodes: new Map(),
      finished: { status: 'succeeded' },
    };
    expect(
      validateAcceptedPipelineRunState(state, 'pipelines/baseline-check.json', hash)
    ).toMatchObject({ pipeline_sha256: hash });
    expect(() =>
      validateAcceptedPipelineRunState(
        { ...state, finished: { status: 'failed' } },
        'pipelines/baseline-check.json',
        hash
      )
    ).toThrow(/did not finish successfully/u);
    expect(() =>
      validateAcceptedPipelineRunState(
        {
          ...state,
          suspended: {
            step_id: 'approval',
            approval_request_id: 'approval-1',
            storage_channel: 'pipeline-binding',
            on_timeout: 'abort',
          },
        },
        'pipelines/baseline-check.json',
        hash
      )
    ).toThrow(/did not finish successfully/u);
    expect(() =>
      validateAcceptedPipelineRunState(
        {
          ...state,
          started: { ...state.started, input_path: 'pipelines/other.json' },
        },
        'pipelines/baseline-check.json',
        hash
      )
    ).toThrow(/input_path does not match/u);
    expect(() =>
      validateAcceptedPipelineRunState(
        {
          ...state,
          started: { ...state.started, pipeline_sha256: 'c'.repeat(64) },
        },
        'pipelines/baseline-check.json',
        hash
      )
    ).toThrow(/content hash does not match/u);
    expect(() =>
      validateAcceptedPipelineRunState(
        { ...state, path: pathResolver.rootResolve('active/shared/tmp/fake.jsonl') },
        'pipelines/baseline-check.json',
        hash
      )
    ).toThrow(/outside governed journal roots/u);
  });

  it('refuses the accepted fast path for review-required intents', () => {
    expect(
      resolveAcceptedPipelineBindingFromCatalog(
        { version: 1, bindings: [binding] },
        {
          packet: {
            selected_intent_id: 'check-kyberion-baseline',
            selected_confidence: 1,
            selected_resolution: { shape: 'pipeline' },
            candidates: [],
          },
          scope: { tier: 'public' },
          pipeline_sha256: hash,
        }
      )
    ).toBeNull();
  });

  it('lets mission, approval, and viewer governance dominate accepted routing', () => {
    expect(acceptedBindingGovernanceAllowsBypass({ execution_shape: 'mission' })).toBe(false);
    expect(acceptedBindingGovernanceAllowsBypass({ requires_approval: true })).toBe(false);
    expect(acceptedBindingGovernanceAllowsBypass({ active_mission: true })).toBe(false);
    expect(acceptedBindingGovernanceAllowsBypass({ viewer_scope_authorized: false })).toBe(false);
    expect(
      acceptedBindingGovernanceAllowsBypass({
        execution_shape: 'pipeline',
        viewer_scope_authorized: true,
      })
    ).toBe(true);
  });
});
