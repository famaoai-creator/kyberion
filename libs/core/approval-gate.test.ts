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

vi.mock('./decision-rights.js', () => ({
  resolveDecisionRightsMatrix: vi.fn(),
  evaluateDecisionRights: vi.fn(),
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
import { evaluateDecisionRights, resolveDecisionRightsMatrix } from './decision-rights.js';
import type { DecisionRightsMatrix } from './decision-rights.js';
import { createApprovalRequest, listApprovalRequests } from './approval-store.js';
import { auditChain } from './audit-chain.js';

const mockResolvePolicy = vi.mocked(resolveApprovalPolicy);
const mockResolveDecisionRightsMatrix = vi.mocked(resolveDecisionRightsMatrix);
const mockEvaluateDecisionRights = vi.mocked(evaluateDecisionRights);
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
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);

    const result = enforceApprovalGate(baseParams);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('not_required');
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval_gate',
        result: 'allowed',
      })
    );
  });

  it('allows when an existing approved request matches correlationId', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);
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

  it('allows when an approved request has a future expiresAt', () => {
    mockResolvePolicy.mockReturnValue({ requiresApproval: true, missingRequirements: [] });
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);
    mockListRequests.mockReturnValue([
      {
        id: 'req-1',
        correlationId: 'corr-123',
        status: 'approved',
        decidedBy: 'admin',
        decidedAt: '2026-04-14T00:00:00Z',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } as any,
    ]);

    const result = enforceApprovalGate(baseParams);
    expect(result.allowed).toBe(true);
    expect(result.status).toBe('approved');
  });

  it('blocks reuse of an approved request whose expiresAt has passed (CR-4)', () => {
    mockResolvePolicy.mockReturnValue({ requiresApproval: true, missingRequirements: [] });
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);
    mockListRequests.mockReturnValue([
      {
        id: 'req-1',
        correlationId: 'corr-123',
        status: 'approved',
        decidedBy: 'admin',
        decidedAt: '2026-04-14T00:00:00Z',
        expiresAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
      } as any,
    ]);

    const result = enforceApprovalGate(baseParams);
    expect(result.allowed).toBe(false);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'denied', reason: 'Existing request is expired' })
    );
  });

  it('blocks when an existing request is pending', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);
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
      })
    );
  });

  it('creates a new request and blocks when no matching request exists', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);
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
      })
    );
  });

  it('uses custom draft when provided', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);
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
      })
    );
  });

  it('builds a rich default draft from payload context', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);
    mockListRequests.mockReturnValue([]);
    mockCreateRequest.mockReturnValue({ id: 'req-rich' } as any);

    enforceApprovalGate({
      ...baseParams,
      payload: {
        artifacts: ['libs/core/work-coordination.ts'],
        rationale: 'Need approval before handoff.',
        acceptance_criteria: ['retain context'],
        expected_outputs: ['handoff packet'],
        consequences: ['review only'],
      },
    });

    expect(mockCreateRequest).toHaveBeenCalledWith(
      'mission_controller',
      expect.objectContaining({
        draft: expect.objectContaining({
          title: 'Approval required: secret:set',
          summary: expect.stringContaining('Task: secret:set'),
          details: expect.stringContaining('Need approval before handoff.'),
        }),
      })
    );
  });

  it('always logs to audit chain', () => {
    mockResolvePolicy.mockReturnValue({
      requiresApproval: false,
      missingRequirements: [],
    });
    mockResolveDecisionRightsMatrix.mockReturnValue(null);
    mockEvaluateDecisionRights.mockReturnValue(null);

    enforceApprovalGate(baseParams);

    expect(mockAuditRecord).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        operation: 'secret:set',
      })
    );
  });

  it('emits secret mutation approval requests that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'schemas/secret-mutation-approval.schema.json'
    );
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

  it('allows operations that decision-rights mark as within threshold', () => {
    mockResolveDecisionRightsMatrix.mockReturnValue({
      version: '1.0.0',
      company_id: 'acme',
      tenant_slug: 'acme',
      source_kind: 'customer',
      source_path: 'customer/acme/decision-rights.json',
      decisions: [
        {
          decision_type: 'operational_spend',
          authorized_role: 'finance_controller',
          threshold: { metric: 'amount_jpy', value: 500000, unit: 'JPY' },
        },
      ],
    } satisfies DecisionRightsMatrix);
    mockEvaluateDecisionRights.mockReturnValue({
      decisionType: 'operational_spend',
      authorizedRole: 'finance_controller',
      thresholdMetric: 'amount_jpy',
      thresholdValue: 500000,
      requiresEscalation: false,
      escalationReason: null,
    });
    mockResolvePolicy.mockReturnValue({
      requiresApproval: true,
      missingRequirements: [],
    });

    const result = enforceApprovalGate({
      ...baseParams,
      agentId: 'finance_controller',
      payload: {
        tenant_slug: 'acme',
        decision_type: 'operational_spend',
        amount_jpy: 250000,
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('not_required');
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'Decision rights allow operational_spend',
      })
    );
  });
});
