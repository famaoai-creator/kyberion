/** Durable native-provider approvals. A pending request survives redispatch. */
import { createHash } from 'node:crypto';
import type { EventScopeInput } from '../event-scope.js';
import {
  AgentRuntimeApprovalPendingError,
  getAgentPromptApprovalPort,
  type AgentPromptApprovalPort,
} from './agent-prompt-approval-port.js';

export function createScopedRuntimeApprovalHandler(input: {
  agentId: string;
  provider: string;
  cwd: string;
  missionId?: string;
  scope: EventScopeInput;
  approvals?: AgentPromptApprovalPort;
  assertCurrent?: () => void;
  /** A server-owned grant, not an approval decision or model-supplied flag. */
  authorize?: (method: string, params: Record<string, unknown>) => boolean;
  /** Persist full request only in the owning scoped artifact store. */
  recordRequest?: (request: {
    method: string;
    params: Record<string, unknown>;
    scope: EventScopeInput;
    digest: string;
  }) => Promise<string> | string;
}): (method: string, params: Record<string, unknown>) => Promise<boolean> {
  return async (method, params) => {
    input.assertCurrent?.();
    // Human approval cannot create an operation/root grant. Legacy runtimes
    // have no claimed task grant and therefore cannot escalate raw native tools.
    if (!input.authorize?.(method, params) || !input.recordRequest) return false;
    const approvals = input.approvals ?? getAgentPromptApprovalPort();
    if (!approvals)
      throw new Error('[AGENT_APPROVAL_UNAVAILABLE] Approval store port is not installed');
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          method,
          params,
          scope: input.scope,
          cwd: input.cwd,
          mission: input.missionId,
        })
      )
      .digest('hex');
    const evidenceRef = await input.recordRequest({ method, params, scope: input.scope, digest });
    if (!evidenceRef.startsWith('artifact:') || evidenceRef.length > 256)
      throw new Error(
        '[AGENT_APPROVAL_EVIDENCE] Native request requires a scoped artifact reference'
      );
    const { id } = approvals.open({
      agentName: input.agentId,
      provider: input.provider,
      signatureId: `native-${digest}`,
      cwd: input.cwd,
      missionId: input.missionId,
      // Do not copy tenant commands or file contents to a global notification.
      excerpt: `Native ${method}; scope-bound request ${digest}. Review ${evidenceRef} before deciding.`,
    });
    const status = approvals.status(id);
    if (status === 'pending') throw new AgentRuntimeApprovalPendingError(id, input.scope);
    input.assertCurrent?.();
    if (!input.authorize(method, params)) return false;
    if (status !== 'approved') return false;
    approvals.consume(id, true);
    return true;
  };
}
