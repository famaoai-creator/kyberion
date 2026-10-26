/**
 * The port a pane runtime uses to ask a person about a prompt.
 *
 * Declared here, below the runtime, so the runtime never imports the
 * approval store: that store reaches mission steering and would pull the
 * pane runtime into the mission lifecycle's import cycle. The approval-store
 * implementation (`agent-prompt-approval.ts`) registers itself; an entry
 * point that runs pane agents imports it. With nothing registered, a prompt
 * that needs a person fails as awaiting_human with the prompt text — the
 * same outcome as before escalation existed, never an answer.
 */

import type { EventScopeInput } from '../event-scope.js';

let pipelineApprovalStatus: ((channel: string, id: string) => string | undefined) | undefined;
export function registerPipelineApprovalStatus(
  reader: (channel: string, id: string) => string | undefined
): () => void {
  const previous = pipelineApprovalStatus;
  pipelineApprovalStatus = reader;
  return () => {
    pipelineApprovalStatus = previous;
  };
}
export function getPipelineApprovalStatus(channel: string, id: string): string | undefined {
  return pipelineApprovalStatus?.(channel, id);
}

export class AgentRuntimeApprovalPendingError extends Error {
  readonly code = 'AGENT_APPROVAL_PENDING';
  constructor(
    readonly approvalRequestId: string,
    readonly scope?: EventScopeInput,
    readonly approvalStorageChannel?: string,
    readonly approvalKind: 'runtime' | 'pipeline' = 'runtime'
  ) {
    super(`[AGENT_APPROVAL_PENDING] approval ${approvalRequestId} requires a human decision`);
    this.name = 'AgentRuntimeApprovalPendingError';
  }
}

export function isAgentRuntimeApprovalPendingError(
  error: unknown
): error is AgentRuntimeApprovalPendingError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'AGENT_APPROVAL_PENDING' &&
    typeof (error as { approvalRequestId?: unknown }).approvalRequestId === 'string'
  );
}

export type AgentPromptApprovalStatus = 'pending' | 'approved' | 'rejected' | 'closed';

export interface AgentPromptApprovalRequest {
  agentName: string;
  provider: string;
  signatureId: string;
  cwd: string;
  excerpt: string;
  missionId?: string;
}

export interface AgentPromptApprovalPort {
  /** The open request for this prompt, creating one if there is none. */
  open(request: AgentPromptApprovalRequest): { id: string; created: boolean };
  status(id: string): AgentPromptApprovalStatus;
  /**
   * Mark a decision as relayed. One decision answers one prompt: without
   * this, the next identical prompt would find the old "yes" and be answered
   * by it, turning a single approval into a standing grant.
   */
  consume(id: string, relayed: boolean): void;
}

let registered: (() => AgentPromptApprovalPort) | null = null;

export function registerAgentPromptApprovalPort(
  factory: () => AgentPromptApprovalPort
): () => void {
  registered = factory;
  return () => {
    if (registered === factory) registered = null;
  };
}

export function getAgentPromptApprovalPort(): AgentPromptApprovalPort | null {
  return registered ? registered() : null;
}
