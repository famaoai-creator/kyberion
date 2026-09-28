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
