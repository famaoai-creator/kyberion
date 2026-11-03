import * as authorizationRegistry from '@agent/core/foundation/authorization-registry';
vi.mock('@agent/core/service/service-harness', () => ({
  planServiceOperation: () => ({}),
  createServiceExecutionReceipt: (_plan: unknown, _result: unknown, options: unknown) => ({
    receipt_id: 'receipt-test',
    options,
  }),
  persistServiceExecutionReceipt: (receipt: unknown) => receipt,
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InformationAssetWorkDeps } from '../../../core/information-assets/work-execution.js';
import type { InformationAssetWorkBinding } from '../../../core/information-assets/work-types.js';
import { informationArtifactHash } from '../../../core/information-assets/completion.js';
const state = vi.hoisted(() => ({
  deps: undefined as InformationAssetWorkDeps | undefined,
  binding: {} as InformationAssetWorkBinding,
  location: {} as Record<string, unknown>,
  observation: {} as Record<string, unknown>,
  capture: vi.fn(),
  mission: 'mission-test',
}));
vi.mock('@agent/core/information-assets/work', async () => ({
  ...(await import('../../../core/information-assets/work-types.js')),
  resolveInformationAssetMissionExecution: () => ({ mission_id: 'mission-test' }),
  executeInformationAssetWork: async (_input: unknown, deps: InformationAssetWorkDeps) => {
    state.deps = deps;
    return {};
  },
}));
vi.mock('@agent/core/information-assets/collector', () => ({
  getInformationAssetCollector: () => ({ actions: ['capture'] }),
  buildReviewThreadsCaptureParams: (variables: Record<string, unknown>) => ({
    body: { query: 'FIXED_READ_QUERY', variables },
  }),
  readInformationAssetObservation: () => state.observation,
  assertInformationAssetCaptureOperation: vi.fn(),
}));
vi.mock('@agent/core/information-assets/collector-capture', () => ({
  executeInformationAssetCapture: state.capture,
}));
vi.mock('@agent/core/information-assets/catalog', () => ({
  readInformationAssetCatalog: () => ({ locations: [state.location] }),
  authorizeInformationAssetCapture: async () => state.location,
}));
vi.mock('@agent/core/information-assets/access', () => ({
  assertInformationAssetBinding: vi.fn(),
}));
vi.mock('@agent/core/workforce/work-coordination', () => ({
  getWorkItem: () => ({
    item_id: 'w',
    status: 'in_progress',
    lease_id: 'l',
    current_attempt_id: 'a',
    claimed_by_peer_id: 'dot:d',
    metadata: {
      information_asset_work: state.binding,
      information_asset_expected_body_sha256: informationArtifactHash('Approved body'),
    },
  }),
  listActiveWorkLeases: () => [
    { lease_id: 'l', status: 'active', expires_at: '2099-01-01T00:00:00Z' },
  ],
}));
vi.mock('@agent/core/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/authority')>()),
  resolveIdentityContext: () => ({ missionId: state.mission }),
}));
import {
  runInformationAssetWork,
  resolveInformationAssetEffectAuthorization,
} from './information-asset-work.js';
const input = { work_item_id: 'w', attempt_id: 'a', lease_id: 'l', dot_id: 'd', actor_id: 'dot:d' };
const recipe = (action: string) =>
  ({
    recipe_id: 'test',
    version: 1,
    title: 'test',
    asset_type: 'workflow.approval_request',
    event_types: ['test'],
    action,
    completion: 'external_readback',
    requires_approval: true,
  }) as Parameters<NonNullable<InformationAssetWorkDeps['hostApply']>>[0];
beforeEach(() => {
  state.mission = 'mission-test';
  vi.restoreAllMocks();
  state.capture.mockReset();
  state.binding = {
    version: 1,
    recipe_id: 'test',
    recipe_version: 1,
    work_key: 'a'.repeat(64),
    observation: {
      event_id: 'e'.repeat(64),
      scope: { tenant_slug: 'acme', organization_id: 'support' },
      asset_type: 'workflow.approval_request',
      location_id: 'source',
      binding_id: 'binding',
      service_id: 'jira',
      subject_id: 'SUP-1',
      change_id: 'v1',
      event_type: 'test',
      content_sha256: 'c'.repeat(64),
    },
  };
  state.location = {
    location_id: 'source',
    binding_id: 'binding',
    service_id: 'jira',
    enabled: true,
    tier: 'confidential',
    scope: state.binding.observation.scope,
    selectors: { domain: 'example', overdue_transition_id: '31', overdue_status_id: '5' },
  };
  state.observation = {
    ...state.binding.observation,
    data: { issue_key: 'SUP-1', approval: { id: '7' } },
  };
});
describe('information work fixed service compiler', () => {
  it('routes approval to captured issue/id and verifies external approval state', async () => {
    const port = vi.fn(async () => ({ ok: true }));
    await runInformationAssetWork(input, port);
    const apply = await state.deps!.hostApply!(recipe('approve_issue'), state.binding, {
      kind: 'service_action',
      params: { service_id: 'evil', subject_id: 'OTHER', decision: 'decline' },
    });
    expect(apply.status).toBe('applied');
    expect(port).toHaveBeenCalledWith(
      expect.objectContaining({
        service_id: 'jira',
        mode: 'PRESET',
        action: 'answer_request_approval',
        params: {
          vars: { domain: 'example', issue_key: 'SUP-1', approval_id: '7' },
          decision: 'approve',
        },
      }),
      undefined,
      {}
    );
    state.capture.mockResolvedValue({ id: '7', finalDecision: 'approved' });
    expect((await state.deps!.readback!(recipe('approve_issue'), state.binding)).verified).toBe(
      true
    );
    state.capture.mockResolvedValue({ id: 'other', finalDecision: 'approved' });
    expect((await state.deps!.readback!(recipe('approve_issue'), state.binding)).verified).toBe(
      false
    );
  });
  it('compiles configured overdue transition and checks resulting status', async () => {
    const port = vi.fn(async () => ({ ok: true }));
    await runInformationAssetWork(input, port);
    await state.deps!.hostApply!(recipe('resolve_overdue'), state.binding, {
      kind: 'service_action',
      params: { transition_id: 'evil' },
    });
    expect(port.mock.calls[0][0]).toMatchObject({
      action: 'transition_issue',
      params: { vars: { issue_key: 'SUP-1' }, transition_id: '31' },
    });
    state.capture.mockResolvedValue({ key: 'SUP-1', fields: { status: { id: '5' } } });
    expect((await state.deps!.readback!(recipe('resolve_overdue'), state.binding)).verified).toBe(
      true
    );
  });
  it('writes only prepared comment content and verifies exact persisted body hash', async () => {
    const port = vi.fn(async () => ({ ok: true }));
    await runInformationAssetWork(input, port);
    await state.deps!.hostApply!(recipe('request_information'), state.binding, {
      kind: 'service_action',
      params: { body: 'Approved body', destination: 'evil' },
    });
    expect(port.mock.calls[0][0]).toMatchObject({
      action: 'add_comment',
      params: { vars: { issue_key: 'SUP-1' }, body: 'Approved body' },
    });
    state.capture.mockResolvedValue({
      comments: [{ body: { content: [{ content: [{ type: 'text', text: 'Approved body' }] }] } }],
    });
    expect(
      (await state.deps!.readback!(recipe('request_information'), state.binding)).verified
    ).toBe(true);
  });
  it('replies only to source message and requires independently captured SENT body', async () => {
    state.location.service_id = 'google-workspace';
    state.binding.observation.service_id = 'google-workspace';
    state.binding.observation.subject_id = 'message1';
    state.observation = { ...state.binding.observation, data: { threadId: 'thread1' } };
    const port = vi.fn(async () => ({ ok: true }));
    await runInformationAssetWork(input, port);
    await state.deps!.hostApply!(recipe('follow_up'), state.binding, {
      kind: 'service_action',
      params: { body: 'Approved body', message_id: 'evil' },
    });
    expect(port.mock.calls[0][0]).toMatchObject({
      service_id: 'google-workspace',
      action: 'gmail_reply',
      params: { message_id: 'message1', body: 'Approved body' },
    });
    state.capture.mockResolvedValue({
      messages: [
        {
          id: 'reply1',
          threadId: 'thread1',
          labelIds: ['SENT'],
          payload: {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Approved body').toString('base64url') },
          },
        },
      ],
    });
    expect((await state.deps!.readback!(recipe('follow_up'), state.binding)).verified).toBe(true);
  });
  it('binds thread resolution to source repository pull head and exact thread', async () => {
    state.location.service_id = 'github';
    state.binding.observation.service_id = 'github';
    state.location.selectors = { owner: 'acme', repo: 'project' };
    state.observation = {
      ...state.binding.observation,
      data: { number: 42, head_sha: 'head1', review_thread_id: 'thread1' },
    };
    state.capture.mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head1',
          reviewThreads: {
            nodes: [{ id: 'thread1', isResolved: false }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    });
    const port = vi.fn(async () => ({ ok: true }));
    await runInformationAssetWork(input, port);
    expect(
      (
        await state.deps!.hostApply!(recipe('resolve_review'), state.binding, {
          kind: 'service_action',
          params: { thread_id: 'evil' },
        })
      ).status
    ).toBe('applied');
    expect(port.mock.calls[0][0]).toMatchObject({
      action: 'resolve_review_thread',
      params: { thread_id: 'thread1' },
    });
    state.capture.mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'changed',
          reviewThreads: {
            nodes: [{ id: 'thread1', isResolved: true }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    });
    expect((await state.deps!.readback!(recipe('resolve_review'), state.binding)).verified).toBe(
      false
    );
  });
  it('holds mission-only write admission without creating a synthetic mission', async () => {
    state.mission = '';
    const port = vi.fn(async () => ({ ok: true }));
    await runInformationAssetWork(input, port);
    expect(
      (
        await state.deps!.hostApply!(recipe('approve_issue'), state.binding, {
          kind: 'service_action',
          params: {},
        })
      ).status
    ).toBe('approval_required');
    expect(port).not.toHaveBeenCalled();
  });
  it('resolves fixed effect subjects canonically before any service write and rejects weakened policy', async () => {
    const original = authorizationRegistry.subjectAuthorization;
    const port = vi.fn(async () => ({ ok: true }));
    await runInformationAssetWork(input, port);
    vi.spyOn(authorizationRegistry, 'subjectAuthorization').mockImplementation((subject) =>
      subject === 'service:jira:preset:answer_request_approval'
        ? { ...original(subject), effectClass: 'local_only', authority: { kind: 'free' } }
        : original(subject)
    );
    await expect(
      state.deps!.hostApply!(recipe('approve_issue'), state.binding, {
        kind: 'service_action',
        params: {},
      })
    ).rejects.toThrow('AUTHORIZATION');
    expect(port).not.toHaveBeenCalled();
  });
  it('rejects undeclared service target subjects and incompatible approval domains', () => {
    expect(() => resolveInformationAssetEffectAuthorization('unknown', 'mutate')).toThrow(
      'AUTHORIZATION'
    );
    const original = authorizationRegistry.subjectAuthorization;
    vi.spyOn(authorizationRegistry, 'subjectAuthorization').mockImplementation((subject) => ({
      ...original(subject),
      approvalDomain: 'arbitrary-domain',
    }));
    expect(() =>
      resolveInformationAssetEffectAuthorization('jira', 'answer_request_approval')
    ).toThrow('APPROVAL_DOMAIN');
  });
});
