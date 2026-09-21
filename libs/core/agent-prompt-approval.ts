/**
 * Approval requests for prompts a pane agent stopped on.
 *
 * A person sees the prompt in the ordinary approval queue
 * (`pnpm kyberion approvals`, the surfaces) and approves or rejects it; the
 * pane adapter relays that decision as keys. Only a human decision counts:
 * the agent runtime is the thing that asked, so an agent deciding its own
 * prompt would be the prompt answering itself.
 */

import { createHash } from 'node:crypto';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
  recordApprovalApplyResult,
} from './approval-store.js';
import { nowIso } from './foundation/time.js';
import { notifyOperator } from './operator-notifications.js';
import {
  registerAgentPromptApprovalPort,
  type AgentPromptApprovalPort,
  type AgentPromptApprovalRequest,
} from './agent-prompt-approval-port.js';

export type {
  AgentPromptApprovalPort,
  AgentPromptApprovalRequest,
  AgentPromptApprovalStatus,
} from './agent-prompt-approval-port.js';

export const AGENT_PROMPT_APPROVAL_CHANNEL = 'agent-runtime';

/**
 * The same prompt on the same agent is one request, however many turns hit
 * it: a re-dispatch finds the request a person already decided.
 */
export function agentPromptCorrelationId(request: AgentPromptApprovalRequest): string {
  const normalized = request.excerpt.replace(/\s+/g, ' ').trim();
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `agent-prompt:${request.agentName}:${request.signatureId}:${digest}`;
}

export function createApprovalStorePromptPort(): AgentPromptApprovalPort {
  return {
    open(request) {
      const correlationId = agentPromptCorrelationId(request);
      const existing = listApprovalRequests({
        storageChannels: [AGENT_PROMPT_APPROVAL_CHANNEL],
        status: ['pending', 'approved', 'rejected'],
      }).find((record) => record.correlationId === correlationId && !record.applyResult);
      if (existing) return { id: existing.id, created: false };

      const record = createApprovalRequest('mission_controller', {
        channel: AGENT_PROMPT_APPROVAL_CHANNEL,
        threadTs: nowIso(),
        correlationId,
        requestedBy: request.agentName,
        draft: {
          title: `Agent '${request.agentName}' (${request.provider}) is waiting on a prompt`,
          summary: `Approve to accept, reject to decline. Prompt kind: ${request.signatureId}.`,
          details: `cwd: ${request.cwd}\n\n${request.excerpt}`,
          severity: request.signatureId === 'workspace_trust' ? 'high' : 'medium',
        },
        source: {
          agentId: request.agentName,
          ...(request.missionId ? { missionId: request.missionId } : {}),
        },
        accountability: {
          finalDecision: 'human_only',
          payloadHash: computeApprovalPayloadHash({
            agent: request.agentName,
            signature: request.signatureId,
            cwd: request.cwd,
            excerpt: request.excerpt,
          }),
          effectBinding: `agent-prompt:${request.signatureId}`,
        },
      });
      void notifyOperator('approval_required', {
        title: record.title,
        body: `${request.excerpt}\n\npnpm kyberion approve ${record.id}  /  pnpm kyberion reject ${record.id}`,
        link_hint: `approval request ${record.id}`,
        correlation_id: record.id,
      });
      return { id: record.id, created: true };
    },

    status(id) {
      const record = loadApprovalRequest(AGENT_PROMPT_APPROVAL_CHANNEL, id);
      if (!record || record.applyResult) return 'closed';
      if (record.status === 'pending') return 'pending';
      // Fail closed: a decision not recorded as a person's is not relayed.
      if (record.decidedByType !== 'human') return 'closed';
      if (record.status === 'approved' || record.status === 'applied') return 'approved';
      if (record.status === 'rejected') return 'rejected';
      return 'closed';
    },

    consume(id, relayed) {
      recordApprovalApplyResult('mission_controller', {
        channel: AGENT_PROMPT_APPROVAL_CHANNEL,
        requestId: id,
        applyResult: {
          appliedAt: nowIso(),
          appliedBy: 'agent-pane-runtime',
          result: relayed ? 'success' : 'failed',
        },
      });
    },
  };
}

// Importing this module is how an entry point turns escalation on.
registerAgentPromptApprovalPort(createApprovalStorePromptPort);
