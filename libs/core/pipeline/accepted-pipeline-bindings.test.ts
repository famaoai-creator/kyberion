import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import * as approvals from '../governance/approval-store.js';
import * as catalogs from '../foundation/governed-catalog.js';
import * as locks from '../foundation/lock-utils.js';
import * as intents from '../intent/intent-resolution.js';
import * as secureIo from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  acceptedBindingGovernanceAllowsBypass,
  acceptedBindingMatchesPipelineHash,
  acceptedPipelineBindingCatalogPath,
  acceptPromotedPipelineBinding,
  hashAcceptedPipeline,
  inspectPipelineBindingAcceptance,
  resetAcceptedPipelineBindingCatalog,
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
  it('completes a missing receipt without republishing the binding and is idempotent', () => {
    resetAcceptedPipelineBindingCatalog();
    const input = {
      pipeline_ref: binding.pipeline_ref,
      intent_id: binding.intent_ids[0],
      scope: binding.scope,
      successful_run_id: 'fixture-run',
      approval_request_id: binding.approval_request_id,
    };
    const readFile = secureIo.safeReadFile;
    vi.spyOn(secureIo, 'safeReadFile').mockImplementation((file, options) =>
      file === pathResolver.rootResolve(input.pipeline_ref)
        ? Buffer.from('{"promotion":{}}')
        : readFile(file, options)
    );
    vi.spyOn(intents, 'loadResolvedStandardIntentCatalog').mockReturnValue([
      {
        id: input.intent_id,
        execution_shape: 'pipeline',
        resolution: { shape: 'pipeline' },
      } as never,
    ]);
    vi.spyOn(locks, 'withLockSync').mockImplementation((_resource, run) => run());
    try {
      const pipelineHash = hashAcceptedPipeline(input.pipeline_ref);
      const { approval_request_id: _approvalId, ...effect } = input;
      const digest = approvals.computeApprovalPayloadHash({
        ...effect,
        pipeline_sha256: pipelineHash,
      });
      const published = {
        ...binding,
        binding_id: `accepted-${digest.slice(0, 16)}`,
        successful_run_evidence: {
          ...binding.successful_run_evidence,
          pipeline_sha256: pipelineHash,
        },
      };
      const record = approval({
        correlationId: `pipeline-binding:${digest}`,
        accountability: { ...approval().accountability!, payloadHash: digest },
      });
      const load = vi.spyOn(approvals, 'loadApprovalRequest').mockReturnValue(record);
      const receipt = vi.spyOn(approvals, 'recordApprovalApplyResult').mockReturnValue(record);
      const publish = vi.fn();
      vi.spyOn(catalogs, 'defineCatalog').mockReturnValue({
        load: () => ({ version: 1, bindings: [published] }),
        generation: () => 'fixture-generation',
        reset: () => undefined,
        publish,
      } as never);
      expect(inspectPipelineBindingAcceptance(input)).toMatchObject({ status: 'receipt_pending' });
      expect(receipt).not.toHaveBeenCalled();
      expect(acceptPromotedPipelineBinding(input)).toEqual(published);
      expect(publish).not.toHaveBeenCalled();
      expect(receipt).toHaveBeenCalledOnce();
      load.mockReturnValue({ ...record, applyResult: receipt.mock.calls[0][1].applyResult });
      expect(inspectPipelineBindingAcceptance(input)).toMatchObject({ status: 'accepted' });
      expect(acceptPromotedPipelineBinding(input)).toEqual(published);
      expect(receipt).toHaveBeenCalledOnce();
    } finally {
      resetAcceptedPipelineBindingCatalog();
      vi.restoreAllMocks();
    }
  });

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
      // Pure validator fixture: rootResolve maps live runtime stores to Vitest's
      // sandbox, while this contract validates the canonical persisted path.
      path: `${pathResolver.rootDir()}/active/shared/runtime/pipeline-runs/run-1.jsonl`,
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
