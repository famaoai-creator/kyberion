import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';

// Mock dependencies before importing the module under test
vi.mock('./approval-policy.js', () => ({
  resolveApprovalPolicy: vi.fn(),
}));

vi.mock('./approval-store.js', () => ({
  createApprovalRequest: vi.fn(),
  listApprovalRequests: vi.fn(),
}));

vi.mock('./audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));

import { enforceApprovalGate } from './approval-gate.js';
import { resolveApprovalPolicy } from './approval-policy.js';
import { createApprovalRequest, listApprovalRequests } from './approval-store.js';
import { auditChain } from './audit-chain.js';

const mockResolvePolicy = vi.mocked(resolveApprovalPolicy);
const mockListRequests = vi.mocked(listApprovalRequests);
const mockCreateRequest = vi.mocked(createApprovalRequest);
const mockAuditRecord = vi.mocked(auditChain.record);
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

const baseParams = {
  operationId: 'secret:set',
  agentId: 'agent-1',
  correlationId: 'corr-123',
  channel: 'terminal',
};

describe('enforceApprovalGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows immediately when no approval is required', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: false,
      missingRequirements: [],
    });

    const result = enforceApprovalGate(baseParams);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('not_required');
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval_gate',
        result: 'allowed',
      }),
    );
  });

  it('allows when an existing approved request matches correlationId', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockListRequests.mockReturnValue([
      {
        id: 'req-1',
        correlationId: 'corr-123',
        status: 'approved',
        decidedBy: 'admin',
        decidedAt: '2026-04-14T00:00:00Z',
      } as any,
    ]);

    const result = enforceApprovalGate(baseParams);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('approved');
    expect(result.requestId).toBe('req-1');
  });

  it('blocks when an existing request is pending', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockListRequests.mockReturnValue([
      {
        id: 'req-2',
        correlationId: 'corr-123',
        status: 'pending',
      } as any,
    ]);

    const result = enforceApprovalGate(baseParams);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('pending');
    expect(result.requestId).toBe('req-2');
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval_gate',
        result: 'denied',
      }),
    );
  });

  it('creates a new request and blocks when no matching request exists', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockListRequests.mockReturnValue([]);
    mockCreateRequest.mockReturnValue({
      id: 'req-new',
      status: 'pending',
    } as any);

    const result = enforceApprovalGate(baseParams);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('pending');
    expect(result.requestId).toBe('req-new');
    expect(mockCreateRequest).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'New approval request created; awaiting decision',
      }),
    );
  });

  it('uses custom draft when provided', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockListRequests.mockReturnValue([]);
    mockCreateRequest.mockReturnValue({ id: 'req-custom' } as any);

    enforceApprovalGate({
      ...baseParams,
      draft: { title: 'Custom', summary: 'Custom summary', severity: 'high' },
    });

    expect(mockCreateRequest).toHaveBeenCalledWith(
      'mission_controller',
      expect.objectContaining({
        draft: { title: 'Custom', summary: 'Custom summary', severity: 'high' },
      }),
    );
  });

  it('always logs to audit chain', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: false,
      missingRequirements: [],
    });

    enforceApprovalGate(baseParams);

    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        operation: 'secret:set',
      }),
    );
  });

  it('emits secret mutation approval requests that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schemaPath = path.join(pathResolver.rootDir(), 'schemas/secret-mutation-approval.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const request = {
      request_id: 'req-schema-1',
      kind: 'secret_mutation',
      status: 'pending',
      created_at: '2026-04-26T00:00:00.000Z',
      requested_by: {
        surface: 'terminal',
        actor_id: 'agent-1',
        actor_role: 'ops',
      },
      target: {
        service_id: 'github',
        secret_key: 'token',
        mutation: 'rotate',
      },
      justification: {
        reason: 'Token rotation is due.',
      },
      risk: {
        level: 'high',
        restart_scope: 'service',
        requires_strong_auth: true,
      },
      workflow: {
        workflow_id: 'wf-schema-1',
        mode: 'all_required',
        required_roles: ['ops'],
        stages: [
          {
            stage_id: 'stage-1',
            required_roles: ['ops'],
          },
        ],
        approvals: [
          {
            role: 'ops',
            status: 'pending',
          },
        ],
      },
    };
    const valid = validate(request);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
