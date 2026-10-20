import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('@agent/core/network', async (original) => ({
  ...(await original<typeof import('@agent/core/network')>()),
  secureFetch: vi.fn(),
}));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeExec: vi.fn(() => 'command result'),
}));
vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: vi.fn() }));
vi.mock('@agent/core/governance/accountability-charter-registry', () => ({
  findActiveCharter: vi.fn(() => null),
  loadCharterUsage: vi.fn(),
  recordCharterExecutionStarted: vi.fn(),
  recordCharterExecutionOutcome: vi.fn(),
}));
vi.mock('@agent/core/governance/external-operation-store', () => ({
  reserveExternalOperation: vi.fn(),
}));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('../../../core/scope-envelope.js', () => ({
  currentScopeEnvelope: vi.fn(() => undefined),
}));
vi.mock('@agent/core/pipeline/op-preflight', async (original) => ({
  ...(await original<typeof import('@agent/core/pipeline/op-preflight')>()),
  runOpPreflight: vi.fn(async ({ params }) => ({
    decision: 'allow',
    input: params,
    listener_ids: [],
    guard_ids: [],
  })),
}));
vi.mock('@agent/core/pipeline/op-preflight-defaults', () => ({
  ensureDefaultOpPreflight: vi.fn(),
  assertBuiltinOnlyOpPreflight: vi.fn(),
}));
vi.mock('@agent/core/async-utils', async (original) => ({
  ...(await original<typeof import('@agent/core/async-utils')>()),
  retry: vi.fn(async (execute: () => Promise<unknown>) => execute()),
}));
// The transport extension registry is an in-memory seam in this boundary test;
// production seam registration telemetry must not write into live observability.
vi.mock('@agent/core/seam', () => ({
  coreSeamCatalog: {},
  createSeam: () => {
    const providers = new Map<string, unknown>();
    return {
      register: (id: string, implementation: unknown) => {
        providers.set(id, { id, implementation });
        return () => {
          providers.delete(id);
        };
      },
      list: () => [...providers.values()],
    };
  },
}));

import { secureFetch } from '@agent/core/network';
import { safeExec } from '@agent/core/secure-io';
import { retry } from '@agent/core/async-utils';
import { enforceApprovalGate } from '@agent/core/governance/approval-gate';
import { reserveExternalOperation } from '@agent/core/governance/external-operation-store';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  withExternalOperationAuthority,
  withExternalOperationPipelineRun,
} from '@agent/core/governance/external-operation';
import { handleAction } from './index.js';
import { registerA2ATransport, sendA2AMessage } from './a2a-transport.js';

const trusted = <T>(body: () => T): T =>
  withExternalOperationAuthority(
    () => ({
      agentId: 'network-owner',
      tenantSlug: 'acme',
      invocationId: randomUUID(),
      hasHuman: true,
    }),
    body
  );
const fetchAction = (method: string) => ({
  action: 'pipeline' as const,
  steps: [
    {
      type: 'capture' as const,
      op: 'fetch',
      params: { url: 'https://example.invalid/endpoint', method, data: { body: 'sensitive-text' } },
    },
  ],
});

describe('network external governance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(secureFetch).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: false,
      status: 'pending',
      message: 'human required',
    });
  });

  it('keeps GET reads automatic with secureFetch and existing read retry policy', async () => {
    const result = await handleAction(fetchAction('get'));
    expect(result.status).toBe('succeeded');
    expect(secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: 'https://example.invalid/endpoint' })
    );
    expect(retry).toHaveBeenCalledTimes(1);
    expect(enforceApprovalGate).not.toHaveBeenCalled();
  });

  it('blocks an unapproved POST without any HTTP request or reservation', async () => {
    const result = await handleAction(fetchAction('POST'));
    expect(result.status).toBe('failed');
    expect(secureFetch).not.toHaveBeenCalled();
    expect(reserveExternalOperation).not.toHaveBeenCalled();
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({ requireApproval: true, hasHuman: false })
    );
  });

  it('attempts approved mutations once and records timeout as unknown', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    vi.mocked(secureFetch).mockRejectedValue(new Error('timeout after server accepted mutation'));
    const result = await trusted(() => handleAction(fetchAction('PATCH')));
    expect(result.status).toBe('failed');
    expect(secureFetch).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'external_operation_outcome',
        metadata: expect.objectContaining({ outcome: 'unknown' }),
      })
    );
    expect(JSON.stringify(vi.mocked(auditChain.record).mock.calls)).not.toContain('sensitive-text');
  });

  it('does not treat capture exposure checks as permission to POST', async () => {
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'exposure_check',
          params: { method: 'POST', items: [{ endpoint: 'https://example.invalid/' }] },
        },
      ],
    });
    expect(result.status).toBe('failed');
    expect(secureFetch).not.toHaveBeenCalled();
  });

  it('keeps the existing disabled-shell policy ahead of any common approval', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    const denied = await trusted(() =>
      handleAction({
        action: 'pipeline',
        steps: [
          {
            type: 'capture',
            op: 'shell',
            params: { cmd: 'opaque-external-command' },
          },
        ],
      })
    );
    expect(denied.status).toBe('failed');
    expect(denied.results[0]?.error).toContain('Shell execution disabled');
    expect(safeExec).not.toHaveBeenCalled();
    expect(enforceApprovalGate).not.toHaveBeenCalled();
  });

  it('protects the direct exported A2A transport and the pipeline send with one admission', async () => {
    const send = vi.fn(async () => undefined);
    const method = `test-${randomUUID()}`;
    const unregister = registerA2ATransport(method, { send, poll: async () => [] });
    const message = { header: { msg_id: 'governed-message' }, body: 'sensitive-text' };
    try {
      await expect(sendA2AMessage(message, { method, encrypt: false })).rejects.toThrow(
        'EXTERNAL_APPROVAL_REQUIRED'
      );
      expect(send).not.toHaveBeenCalled();
      vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
      vi.mocked(enforceApprovalGate).mockClear();
      const result = await trusted(() =>
        handleAction({
          action: 'pipeline',
          steps: [{ type: 'apply', op: 'a2a_send', params: { message, method, encrypt: false } }],
        })
      );
      expect(result.status).toBe('succeeded');
      expect(send).toHaveBeenCalledTimes(1);
      expect(enforceApprovalGate).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('rejects an inner mutation batch or repeated mutation loop before its first effect', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    const step = fetchAction('POST').steps[0]!;
    await expect(
      withExternalOperationPipelineRun('run', () =>
        trusted(() =>
          handleAction({
            action: 'pipeline',
            steps: [step, step],
          })
        )
      )
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    await expect(
      withExternalOperationPipelineRun('run', () =>
        trusted(() =>
          handleAction({
            action: 'pipeline',
            steps: [
              {
                type: 'control',
                op: 'while',
                params: { condition: 'true', pipeline: [step], max_iterations: 2 },
              },
            ],
          })
        )
      )
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(secureFetch).not.toHaveBeenCalled();
    expect(enforceApprovalGate).not.toHaveBeenCalled();
  });

  it('permits mutually exclusive single-effect branches under one production checkpoint', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    const step = fetchAction('POST').steps[0]!;
    const result = await withExternalOperationPipelineRun('branch-run', () =>
      trusted(() =>
        handleAction({
          action: 'pipeline',
          context: { choose_then: true },
          steps: [
            {
              type: 'control',
              op: 'if',
              params: { condition: 'choose_then', then: [step], else: [step] },
            },
          ],
        })
      )
    );
    expect(result.status).toBe('succeeded');
    expect(secureFetch).toHaveBeenCalledTimes(1);
  });
});
