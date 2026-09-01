import { randomUUID } from 'node:crypto';
import { enforceApprovalGate, type ApprovalGateResult } from './approval-gate.js';
import type { ApprovalActionDescriptor, ApprovalRequestSource } from './approval-store.js';
import type { TraceContext } from './src/trace.js';

export interface RequireApprovalParams {
  opId: string;
  agentId: string;
  correlationId?: string;
  channel?: string;
  payload?: Record<string, unknown>;
  draft?: {
    title: string;
    summary: string;
    severity?: 'low' | 'medium' | 'high';
  };
  trace?: TraceContext;
  actionDescriptor?: ApprovalActionDescriptor;
  source?: ApprovalRequestSource;
  hasHuman?: boolean;
  hasUI?: boolean;
  nonInteractive?: boolean;
}

export function requireApprovalForOp(params: RequireApprovalParams): ApprovalGateResult {
  const correlationId = params.correlationId ?? randomUUID();
  return enforceApprovalGate({
    operationId: params.opId,
    agentId: params.agentId,
    correlationId,
    channel: params.channel ?? 'system',
    intentId: params.opId,
    payload: params.payload,
    draft: params.draft,
    trace: params.trace,
    actionDescriptor: params.actionDescriptor,
    source: params.source,
    ...(params.hasHuman !== undefined ? { hasHuman: params.hasHuman } : {}),
    ...(params.hasUI !== undefined ? { hasUI: params.hasUI } : {}),
    ...(params.nonInteractive !== undefined ? { nonInteractive: params.nonInteractive } : {}),
  });
}
