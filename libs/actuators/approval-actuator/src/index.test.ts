import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('approval-actuator', () => {
  it('emits approval actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'schemas/approval-action.schema.json')
    );
    const action = {
      action: 'create',
      params: {
        role: 'mission_controller',
        channel: 'terminal',
        storageChannel: 'terminal',
        threadTs: '1714060800.000100',
        correlationId: 'corr-approval-demo-1',
        requestedBy: 'agent-1',
        requestKind: 'secret_mutation',
        draft: {
          title: 'Rotate GitHub secret',
          summary: 'Rotate the GitHub token for the approval gate demo.',
          severity: 'high',
        },
      },
    };
    const valid = validate(action);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});

import { beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApprovalRequest: vi.fn(),
  decideApprovalRequest: vi.fn(),
  loadApprovalRequest: vi.fn(),
  listGovernedArtifacts: vi.fn(),
  safeReadFile: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    withRetry: mocks.withRetry,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
    pathResolver: {
      ...actual.pathResolver,
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
    },
  };
});

vi.mock('@agent/core/artifacts', () => ({
  listGovernedArtifacts: mocks.listGovernedArtifacts,
}));

vi.mock('@agent/core/governance', () => ({
  createApprovalRequest: mocks.createApprovalRequest,
  decideApprovalRequest: mocks.decideApprovalRequest,
  loadApprovalRequest: mocks.loadApprovalRequest,
}));

describe('approval-actuator handleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws for unsupported action', async () => {
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({ action: 'unsupported' as any, params: { channel: 'test' } })
    ).rejects.toThrow('Unsupported approval action');
  });

  it('create throws when required params are missing', async () => {
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({
        action: 'create',
        params: {
          channel: 'terminal',
          // missing threadTs, correlationId, requestedBy, draft
        },
      })
    ).rejects.toThrow('threadTs, correlationId, requestedBy, and draft are required');
  });

  it('load throws when requestId is missing', async () => {
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({
        action: 'load',
        params: { channel: 'terminal' },
      })
    ).rejects.toThrow('requestId is required');
  });

  it('decide throws when required params are missing', async () => {
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({
        action: 'decide',
        params: {
          channel: 'terminal',
          // missing requestId, decision, decidedBy
        },
      })
    ).rejects.toThrow('requestId, decision, and decidedBy are required');
  });

  it('create calls createApprovalRequest with correct params', async () => {
    const mockRequest = { id: 'req-1', status: 'pending' };
    mocks.createApprovalRequest.mockReturnValue(mockRequest);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'create',
      params: {
        channel: 'terminal',
        threadTs: '1714060800.000100',
        correlationId: 'corr-1',
        requestedBy: 'agent-1',
        draft: { title: 'Test', summary: 'Test summary', severity: 'low' },
      },
    });

    expect(mocks.createApprovalRequest).toHaveBeenCalled();
    expect(result.status).toBe('created');
    expect(result.request).toEqual(mockRequest);
  });

  it('load returns request by id', async () => {
    const mockRequest = { id: 'req-1', status: 'pending' };
    mocks.loadApprovalRequest.mockReturnValue(mockRequest);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'load',
      params: { channel: 'terminal', requestId: 'req-1' },
    });

    expect(mocks.loadApprovalRequest).toHaveBeenCalledWith('terminal', 'req-1');
    expect(mocks.withRetry).toHaveBeenCalled();
    expect(result.status).toBe('ok');
    expect(result.request).toEqual(mockRequest);
  });

  it('list_pending returns only pending requests', async () => {
    mocks.listGovernedArtifacts.mockReturnValue(['req-1.json', 'req-2.json']);
    mocks.loadApprovalRequest
      .mockReturnValueOnce({ id: 'req-1', status: 'pending' })
      .mockReturnValueOnce({ id: 'req-2', status: 'approved' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'list_pending',
      params: { channel: 'terminal' },
    });

    expect(result.status).toBe('ok');
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].status).toBe('pending');
    expect(mocks.withRetry).toHaveBeenCalled();
  });
});
