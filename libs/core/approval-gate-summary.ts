export interface ApprovalGateSummaryInput {
  taskId: string;
  artifacts: string[];
  approvalBoundary?: {
    requiredFor: string[];
    defaultAction: ApprovalGateDefaultAction;
  };
}

type ApprovalGateDefaultAction = 'draft_only' | 'notify_only' | 'requires_human_approval';

function formatArtifactList(artifacts: string[]): string {
  if (artifacts.length === 0) {
    return '- No artifacts recorded';
  }

  return artifacts.map((artifact) => `- Created ${artifact}`).join('\n');
}

function formatApprovalList(requiredFor?: string[]): string {
  if (!requiredFor || requiredFor.length === 0) {
    return '- none';
  }

  return requiredFor.map((item) => `- ${item}`).join('\n');
}

function formatDefaultAction(action?: ApprovalGateDefaultAction): string {
  if (!action) {
    return '- unknown; no external delivery was performed';
  }

  const humanReadable = action.replace(/_/g, '-');
  return `- ${humanReadable}; no external delivery was performed`;
}

export function summarizeApprovalGate(input: ApprovalGateSummaryInput): string {
  const requiredFor = input.approvalBoundary?.requiredFor ?? [];
  const defaultAction = input.approvalBoundary?.defaultAction;

  return [
    `Task: ${input.taskId}`,
    '',
    'Result:',
    formatArtifactList(input.artifacts),
    '',
    'Approval required:',
    formatApprovalList(requiredFor),
    '',
    'Default action:',
    formatDefaultAction(defaultAction),
  ].join('\n');
}
