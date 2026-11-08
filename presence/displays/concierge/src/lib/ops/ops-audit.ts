import { auditChain } from '@agent/core/governance/audit-chain';
import type { ViewerContext } from './ops-viewer';

/**
 * One audited line per operator mutation dispatched through /api/ops routes.
 * Same shape the governed quick-action workers use: the requesting viewer
 * principal rides on every record. (`ViewerContext` is the ops-route viewer —
 * org/project narrowing is optional there and irrelevant to audit.)
 */
export function auditOpsMutation(
  viewer: ViewerContext,
  operation: string,
  result: 'completed' | 'failed' | 'error',
  metadata?: Record<string, unknown>,
  error?: unknown
): void {
  try {
    auditChain.record({
      agentId: viewer.principalId || 'concierge-ops-console',
      action: 'concierge_ops_mutation',
      operation,
      result,
      ...(error ? { reason: error instanceof Error ? error.message : String(error) } : {}),
      metadata: {
        role: viewer.role,
        ...(viewer.principalId ? { actor: viewer.principalId } : {}),
        ...(metadata ?? {}),
      },
    });
  } catch {
    // Audit is best-effort; a logging failure must not change the API result.
  }
}
