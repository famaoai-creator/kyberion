import type { ErrorClassification } from './error-classifier.js';

export type NextActionType =
  | 'run_command'
  | 'repair_surface'
  | 'bootstrap_environment'
  | 'request_clarification'
  | 'inspect_artifact'
  | 'retry_pipeline'
  | 'open_docs';

export interface NextAction {
  title: string;
  reason: string;
  next_action_type: NextActionType;
  suggested_command?: string;
  suggested_pipeline_path?: string;
  suggested_followup_request?: string;
}

export interface BuildNextActionInput {
  title: string;
  reason: string;
  next_action_type: NextActionType;
  suggested_command?: string;
  suggested_pipeline_path?: string;
  suggested_followup_request?: string;
}

export interface ErrorNextActionContext {
  source?: 'pipeline' | 'doctor' | 'surface' | 'service' | 'setup';
  pipelinePath?: string;
  surfaceId?: string;
  surfaceStateHealth?: 'healthy' | 'degraded' | 'stale' | 'untracked';
  surfaceRepairHint?: string;
  serviceId?: string;
  serviceSetupHint?: string;
  serviceMissingSecrets?: string[];
  serviceCliFallbacks?: string[];
  manifestId?: string;
  runtime?: string;
}

export interface CompletionGoal {
  summary: string;
  success_condition: string;
}

export interface CompletionReconciliation {
  satisfied: boolean;
  delivered: string[];
  gaps: string[];
  confidence: number;
  evidence_refs?: string[];
}

export interface CompletionNextAction {
  title: string;
  request: string;
  delivered: string[];
  gaps: string[];
  next_step: string;
  satisfied: boolean;
  confidence: number;
  evidence_refs: string[];
}

export function buildNextAction(input: BuildNextActionInput): NextAction {
  return {
    title: input.title,
    reason: input.reason,
    next_action_type: input.next_action_type,
    ...(input.suggested_command ? { suggested_command: input.suggested_command } : {}),
    ...(input.suggested_pipeline_path
      ? { suggested_pipeline_path: input.suggested_pipeline_path }
      : {}),
    ...(input.suggested_followup_request
      ? { suggested_followup_request: input.suggested_followup_request }
      : {}),
  };
}

export function formatNextAction(action: NextAction): string[] {
  const lines = [`Next Action: ${action.title}`, `Reason: ${action.reason}`];
  if (action.suggested_command) lines.push(`Command: ${action.suggested_command}`);
  if (action.suggested_pipeline_path) lines.push(`Pipeline: ${action.suggested_pipeline_path}`);
  if (action.suggested_followup_request)
    lines.push(`Follow-up: ${action.suggested_followup_request}`);
  return lines;
}

export function buildCompletionNextAction(input: {
  goal: CompletionGoal;
  reconciliation: CompletionReconciliation;
}): CompletionNextAction {
  const satisfied = input.reconciliation.satisfied;
  const delivered = Array.from(
    new Set(input.reconciliation.delivered.map((entry) => String(entry).trim()).filter(Boolean))
  );
  const gaps = Array.from(
    new Set(input.reconciliation.gaps.map((entry) => String(entry).trim()).filter(Boolean))
  );
  const evidenceRefs = Array.from(
    new Set(
      (input.reconciliation.evidence_refs || [])
        .map((entry) => String(entry).trim())
        .filter(Boolean)
    )
  );
  return {
    title: satisfied ? 'Completion confirmed' : 'Completion requires follow-up',
    request: input.goal.success_condition,
    delivered,
    gaps,
    next_step: satisfied
      ? 'Proceed with archival, promotion, or the next mission step.'
      : gaps.length > 0
        ? 'Resolve the gaps and rerun completion reconciliation.'
        : 'Review the delivered evidence and confirm whether the goal is satisfied.',
    satisfied,
    confidence: input.reconciliation.confidence,
    evidence_refs: evidenceRefs,
  };
}

export function formatCompletionNextAction(action: CompletionNextAction): string[] {
  const lines = [
    `Completion: ${action.title}`,
    `Goal: ${action.request}`,
    `Satisfied: ${action.satisfied ? 'yes' : 'no'}`,
    `Confidence: ${action.confidence.toFixed(2)}`,
  ];
  if (action.delivered.length > 0) lines.push(`Delivered: ${action.delivered.join('; ')}`);
  if (action.gaps.length > 0) lines.push(`Gaps: ${action.gaps.join('; ')}`);
  if (action.evidence_refs.length > 0) lines.push(`Evidence: ${action.evidence_refs.join('; ')}`);
  lines.push(`Next step: ${action.next_step}`);
  return lines;
}

function buildPipelineFailureNextAction(
  classification: ErrorClassification,
  context: ErrorNextActionContext
): NextAction {
  const pipelinePath = context.pipelinePath;

  switch (classification.ruleId) {
    case 'resource.eaddrinuse':
      return buildNextAction({
        title: context.surfaceId
          ? `Repair surface ${context.surfaceId}`
          : 'Inspect the port conflict',
        reason: classification.remediation,
        next_action_type: context.surfaceId ? 'repair_surface' : 'inspect_artifact',
        suggested_command: context.surfaceId
          ? `pnpm surfaces:repair -- --surface ${context.surfaceId}`
          : 'pnpm surfaces:status',
      });
    case 'dep.missing-binary':
    case 'dep.missing-module':
    case 'kyberion.capability-missing':
      return buildNextAction({
        title: 'Verify missing runtime prerequisites',
        reason: classification.remediation,
        next_action_type: 'bootstrap_environment',
        suggested_command: 'pnpm doctor',
      });
    case 'auth.invalid-key':
      return buildNextAction({
        title: 'Repair credentials and onboarding',
        reason: classification.remediation,
        next_action_type: 'bootstrap_environment',
        suggested_command: 'pnpm onboard',
      });
    case 'secret.not-found':
      return buildNextAction({
        title: 'Inspect configured secrets',
        reason: classification.remediation,
        next_action_type: 'inspect_artifact',
        suggested_command: 'pnpm cli secret list',
      });
    case 'kyberion.path-scope':
      return buildNextAction({
        title: 'Fix the write path scope',
        reason: classification.remediation,
        next_action_type: 'request_clarification',
        suggested_followup_request:
          'Move the target path under active/missions/{id}/ or active/shared/, then rerun the same command.',
      });
    case 'kyberion.governance-approval':
    case 'pipeline.hook-abort':
      return buildNextAction({
        title: 'Request the required approval',
        reason: classification.remediation,
        next_action_type: 'run_command',
        suggested_command: 'pnpm cli approval',
      });
    case 'mission.not-found':
      return buildNextAction({
        title: 'Resolve the mission id',
        reason: classification.remediation,
        next_action_type: 'inspect_artifact',
        suggested_command: 'pnpm mission list',
      });
    case 'input.schema':
    case 'input.json-parse':
    case 'input.unsupported-op':
      return buildNextAction({
        title: 'Fix the failing pipeline input',
        reason: classification.remediation,
        next_action_type: 'inspect_artifact',
        ...(pipelinePath ? { suggested_pipeline_path: pipelinePath } : {}),
        suggested_followup_request:
          'Update the referenced pipeline or payload, then rerun the same command.',
      });
    default:
      break;
  }

  if (classification.category === 'resource_unavailable') {
    return buildNextAction({
      title: context.surfaceId
        ? `Repair surface ${context.surfaceId}`
        : 'Inspect the unavailable resource',
      reason: classification.remediation,
      next_action_type: context.surfaceId ? 'repair_surface' : 'inspect_artifact',
      suggested_command: context.surfaceId
        ? `pnpm surfaces:repair -- --surface ${context.surfaceId}`
        : 'pnpm surfaces:status',
    });
  }

  if (classification.category === 'missing_dependency') {
    return buildNextAction({
      title: 'Verify runtime prerequisites',
      reason: classification.remediation,
      next_action_type: 'bootstrap_environment',
      suggested_command: 'pnpm doctor',
    });
  }

  if (classification.category === 'auth') {
    return buildNextAction({
      title: 'Repair credentials and onboarding',
      reason: classification.remediation,
      next_action_type: 'bootstrap_environment',
      suggested_command: 'pnpm onboard',
    });
  }

  if (classification.category === 'missing_secret') {
    return buildNextAction({
      title: 'Inspect configured secrets',
      reason: classification.remediation,
      next_action_type: 'inspect_artifact',
      suggested_command: 'pnpm cli secret list',
    });
  }

  if (
    classification.category === 'permission_denied' ||
    classification.category === 'governance_block' ||
    classification.category === 'tier_violation'
  ) {
    return buildNextAction({
      title: 'Resolve the policy block',
      reason: classification.remediation,
      next_action_type: 'request_clarification',
      suggested_followup_request:
        'Review the blocked action, obtain the required approval or role, and rerun the same command.',
    });
  }

  if (classification.category === 'invalid_input') {
    return buildNextAction({
      title: 'Fix the failing input',
      reason: classification.remediation,
      next_action_type: 'inspect_artifact',
      ...(pipelinePath ? { suggested_pipeline_path: pipelinePath } : {}),
      suggested_followup_request:
        'Fix the malformed input or schema mismatch, then rerun the same command.',
    });
  }

  if (classification.category === 'network' || classification.category === 'timeout') {
    return buildNextAction({
      title: 'Check the remote dependency and retry',
      reason: classification.remediation,
      next_action_type: 'retry_pipeline',
      ...(pipelinePath ? { suggested_pipeline_path: pipelinePath } : {}),
      suggested_followup_request:
        'Verify the remote service is reachable, then rerun the same command.',
    });
  }

  return buildNextAction({
    title: 'Inspect the failure and rerun',
    reason: classification.remediation,
    next_action_type: 'inspect_artifact',
    ...(pipelinePath ? { suggested_pipeline_path: pipelinePath } : {}),
    suggested_followup_request:
      'Inspect the error detail, adjust the failing input or environment, and rerun the same command.',
  });
}

export function buildNextActionFromError(
  classification: ErrorClassification,
  context: ErrorNextActionContext = {}
): NextAction {
  if (context.source === 'surface' && context.surfaceId) {
    return buildNextAction({
      title:
        context.surfaceStateHealth && context.surfaceStateHealth !== 'healthy'
          ? `Repair surface ${context.surfaceId}`
          : `Inspect surface ${context.surfaceId}`,
      reason: context.surfaceRepairHint || classification.remediation,
      next_action_type:
        context.surfaceStateHealth && context.surfaceStateHealth !== 'healthy'
          ? 'repair_surface'
          : 'inspect_artifact',
      suggested_command:
        context.surfaceStateHealth && context.surfaceStateHealth !== 'healthy'
          ? `pnpm surfaces:repair -- --surface ${context.surfaceId}`
          : `pnpm surfaces:status -- --surface ${context.surfaceId}`,
    });
  }

  if (context.source === 'service' && context.serviceId) {
    const missingSecrets = context.serviceMissingSecrets?.length
      ? ` Missing secrets: ${context.serviceMissingSecrets.join(', ')}.`
      : '';
    const fallbackNote = context.serviceCliFallbacks?.length
      ? ` CLI fallback: ${context.serviceCliFallbacks.join(', ')}.`
      : '';
    return buildNextAction({
      title: `Fix service setup for ${context.serviceId}`,
      reason:
        context.serviceSetupHint || `${classification.remediation}${missingSecrets}${fallbackNote}`,
      next_action_type: 'bootstrap_environment',
      suggested_command: 'pnpm services:setup',
    });
  }

  if (context.source === 'doctor') {
    return buildNextAction({
      title: `Bootstrap ${context.runtime || context.manifestId || 'runtime prerequisites'}`,
      reason: classification.remediation,
      next_action_type: 'bootstrap_environment',
      suggested_command: context.manifestId
        ? `pnpm env:bootstrap --manifest ${context.manifestId} --apply`
        : 'pnpm doctor',
    });
  }

  return buildPipelineFailureNextAction(classification, context);
}
