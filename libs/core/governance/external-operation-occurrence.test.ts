import { beforeEach, describe, expect, it, vi } from 'vitest';

const reservations = vi.hoisted(() => new Set<string>());
vi.mock('../scope-envelope.js', () => ({ currentScopeEnvelope: () => undefined }));
vi.mock('../scope-context.js', () => ({ resolveScopeContext: () => ({}) }));
vi.mock('./approval-gate.js', () => ({
  enforceApprovalGate: vi.fn(() => ({
    allowed: true,
    status: 'approved',
    requestId: '00000000-0000-4000-8000-000000000001',
  })),
}));
vi.mock('./approval-store.js', async (original) => ({
  ...(await original<typeof import('./approval-store.js')>()),
  evaluateApprovalUsability: () => null,
  loadApprovalRequest: (_channel: string, id: string) => {
    const params = vi.mocked(enforceApprovalGate).mock.calls.at(-1)?.[0];
    return params ? externalApprovalFixture(params, id) : null;
  },
}));
import { enforceApprovalGate } from './approval-gate.js';
import { externalApprovalFixture } from '../../../tests/helpers/external-approval-fixture.js';
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./external-operation-store.js', () => ({
  reserveExternalOperation: (input: { operationId: string; invocationId: string }) => {
    const key = JSON.stringify([input.operationId, input.invocationId]);
    if (reservations.has(key)) throw new Error('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    reservations.add(key);
  },
}));

import {
  currentExternalOperationOccurrence,
  withExternalOperationOccurrence,
} from './external-operation-occurrence.js';
import { createRuntimeExternalOperationAuthority } from './external-operation-runtime.js';
import { admitExternalOperation } from './external-operation.js';

describe('trusted external execution occurrences', () => {
  beforeEach(() => {
    reservations.clear();
    vi.clearAllMocks();
  });

  it('admits same-target iterations once each and rejects replay of the same iteration', () => {
    const resolve = createRuntimeExternalOperationAuthority({ runId: 'run', stepId: 'send' });
    const facts = {
      operationId: 'service:slack:preset:post_message',
      requiresApproval: true,
      effect: { params: { channel: 'same-channel', text: 'message' } },
    };
    const send = (index: number) =>
      withExternalOperationOccurrence(`foreach:loop:${index}`, () => {
        const operation = { ...facts, authority: resolve(facts) };
        return admitExternalOperation(operation);
      });
    expect(send(0).allowed).toBe(true);
    expect(send(1).allowed).toBe(true);
    expect(() => send(0)).toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
  });

  it('keeps nested substeps distinct while preserving stable resume identity', () => {
    const resolve = createRuntimeExternalOperationAuthority({ runId: 'run', stepId: 'pipeline' });
    const facts = {
      operationId: 'service:github:preset:create_issue',
      requiresApproval: true,
      effect: {},
    };
    const id = (step: number) =>
      withExternalOperationOccurrence('foreach:loop:0', () =>
        withExternalOperationOccurrence(
          `service-substep:${step}:preset`,
          () => resolve(facts)?.invocationId
        )
      );
    expect(id(0)).not.toBe(id(1));
    expect(id(0)).toBe(id(0));
    expect(currentExternalOperationOccurrence()).toEqual([]);
  });

  it('isolates concurrent branches and restores enclosing occurrence paths', async () => {
    await withExternalOperationOccurrence('parent', async () => {
      const paths = await Promise.all(
        [0, 1].map((index) =>
          withExternalOperationOccurrence(`parallel:${index}`, async () => {
            await Promise.resolve();
            return currentExternalOperationOccurrence();
          })
        )
      );
      expect(paths).toEqual([
        ['parent', 'parallel:0'],
        ['parent', 'parallel:1'],
      ]);
      expect(Object.isFrozen(paths[0])).toBe(true);
      expect(currentExternalOperationOccurrence()).toEqual(['parent']);
    });
    expect(currentExternalOperationOccurrence()).toEqual([]);
  });
});
