import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditChain } from './audit-chain.js';
import {
  listApprovalAuditTrail,
  summarizeApprovalAuditDrilldown,
  summarizeApprovalAuditTrail,
} from './approval-audit.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';

describe('approval-audit', () => {
  afterEach(() => {
    const auditDir = pathResolver.shared('logs/audit');
    if (safeExistsSync(auditDir)) {
      safeRmSync(auditDir, { recursive: true, force: true });
    }
  });

  it('summarizes approval gate entries from the audit chain', () => {
    vi.spyOn(auditChain, 'loadAll').mockReturnValue([
      {
        id: 'A1',
        timestamp: '2026-07-05T00:00:00.000Z',
        agentId: 'agent-a',
        action: 'approval_gate',
        operation: 'secret:set',
        result: 'allowed',
        reason: 'Decision rights allow operational_spend',
        metadata: {
          correlationId: 'corr-1',
          intentId: 'intent-1',
          decisionType: 'operational_spend',
          decisionRightsSource: '/tmp/decision-rights.json',
        },
        previousHash: 'x',
        currentHash: 'y',
      },
      {
        id: 'A2',
        timestamp: '2026-07-05T01:00:00.000Z',
        agentId: 'agent-b',
        action: 'approval_gate',
        operation: 'secret:set',
        result: 'denied',
        reason: 'actor role finance_controller is not authorized',
        metadata: {
          correlationId: 'corr-2',
          intentId: 'intent-2',
          decisionType: 'contract_signature',
        },
        previousHash: 'y',
        currentHash: 'z',
      },
      {
        id: 'N1',
        timestamp: '2026-07-05T02:00:00.000Z',
        agentId: 'agent-c',
        action: 'other',
        operation: 'noop',
        result: 'completed',
        previousHash: 'z',
        currentHash: 'w',
      },
    ] as never[]);

    const trail = listApprovalAuditTrail(10);
    const summary = summarizeApprovalAuditTrail(10);

    expect(trail).toHaveLength(2);
    expect(trail[0]?.correlationId).toBe('corr-2');
    expect(summary.total).toBe(2);
    expect(summary.allowed).toBe(1);
    expect(summary.denied).toBe(1);
    expect(summary.recent[0]?.decisionType).toBe('contract_signature');
  });

  it('builds a drilldown by decision type and correlation id', () => {
    vi.spyOn(auditChain, 'loadAll').mockReturnValue([
      {
        id: 'A1',
        timestamp: '2026-07-05T00:00:00.000Z',
        agentId: 'agent-a',
        action: 'approval_gate',
        operation: 'secret:set',
        result: 'allowed',
        reason: 'ok',
        metadata: {
          correlationId: 'corr-1',
          intentId: 'intent-1',
          decisionType: 'operational_spend',
        },
        previousHash: 'x',
        currentHash: 'y',
      },
      {
        id: 'A2',
        timestamp: '2026-07-05T01:00:00.000Z',
        agentId: 'agent-b',
        action: 'approval_gate',
        operation: 'secret:set',
        result: 'denied',
        reason: 'needs review',
        metadata: {
          correlationId: 'corr-1',
          intentId: 'intent-1',
          decisionType: 'operational_spend',
        },
        previousHash: 'y',
        currentHash: 'z',
      },
      {
        id: 'A3',
        timestamp: '2026-07-05T02:00:00.000Z',
        agentId: 'agent-c',
        action: 'approval_gate',
        operation: 'mission:start',
        result: 'completed',
        metadata: {
          correlationId: 'corr-2',
          decisionType: 'mission_start',
        },
        previousHash: 'z',
        currentHash: 'w',
      },
    ] as never[]);

    const drilldown = summarizeApprovalAuditDrilldown(10);

    expect(drilldown.total).toBe(3);
    expect(drilldown.byDecisionType).toHaveLength(2);
    expect(drilldown.byDecisionType[0]?.decisionType).toBe('operational_spend');
    expect(drilldown.byDecisionType[0]?.total).toBe(2);
    expect(drilldown.byCorrelationId).toHaveLength(2);
    expect(drilldown.byCorrelationId[0]?.correlationId).toBe('corr-1');
    expect(drilldown.byCorrelationId[0]?.decisionTypes).toEqual(['operational_spend']);
    expect(drilldown.byCorrelationId[0]?.recent).toHaveLength(2);
  });
});
