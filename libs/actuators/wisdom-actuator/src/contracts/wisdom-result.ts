import type { ContextSecurityScope } from '@agent/core';

export type ExecutionKind =
  | 'reasoning_single'
  | 'reasoning_ensemble'
  | 'agent_delegation'
  | 'agent_a2a'
  | 'deterministic';

export type IdempotencyClass = 'read' | 'idempotent_write' | 'non_idempotent' | 'external_effect';

export interface WisdomReceipt<T = unknown> {
  actuator_id: 'wisdom-actuator';
  requested_op: string;
  canonical_op: string;
  execution_kind: ExecutionKind;
  status: 'succeeded' | 'failed' | 'blocked' | 'partial';
  result?: T;
  error?: { code: string; message: string; retryable: boolean };
  security_scope?: ContextSecurityScope;
  reasoning?: {
    backend?: string;
    mode?: 'model' | 'placeholder' | 'deterministic';
    route_id?: string;
  };
  compatibility?: {
    deprecated_alias?: string;
    forwarded_to?: string;
  };
  retry?: {
    attempts: number;
    idempotency_class: IdempotencyClass;
    automatic_retry: boolean;
  };
  trace_summary?: Record<string, unknown>;
}

export function makeWisdomReceipt(input: {
  requestedOp: string;
  canonicalOp: string;
  executionKind: ExecutionKind;
  status?: WisdomReceipt['status'];
  result?: unknown;
  error?: WisdomReceipt['error'];
  compatibility?: WisdomReceipt['compatibility'];
  retry?: WisdomReceipt['retry'];
  securityScope?: WisdomReceipt['security_scope'];
  reasoning?: WisdomReceipt['reasoning'];
  traceSummary?: WisdomReceipt['trace_summary'];
}): WisdomReceipt {
  return {
    actuator_id: 'wisdom-actuator',
    requested_op: input.requestedOp,
    canonical_op: input.canonicalOp,
    execution_kind: input.executionKind,
    status: input.status || 'succeeded',
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.error ? { error: input.error } : {}),
    ...(input.compatibility ? { compatibility: input.compatibility } : {}),
    ...(input.retry ? { retry: input.retry } : {}),
    ...(input.securityScope ? { security_scope: input.securityScope } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.traceSummary ? { trace_summary: input.traceSummary } : {}),
  };
}
