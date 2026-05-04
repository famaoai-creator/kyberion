import { requireApprovalForOp, RISKY_OPS } from './risky-op-registry.js';
import {
  buildClaudeCliOptionsFromEnv,
  probeShellClaudeCliAvailability,
  ShellClaudeCliBackend,
  type BrowserAgentTaskInput,
  type DocumentAgentTaskInput,
  type ShellClaudeCliBackendOptions,
} from './shell-claude-cli-backend.js';

export interface ClaudeTaskRunnerContext {
  agentId: string;
  channel?: string;
  correlationId?: string;
  payload?: Record<string, unknown>;
  draft?: {
    title: string;
    summary: string;
    severity?: 'low' | 'medium' | 'high';
  };
  backend?: ShellClaudeCliBackend;
  backendOptions?: ShellClaudeCliBackendOptions;
}

function resolveBackend(context: ClaudeTaskRunnerContext): ShellClaudeCliBackend {
  if (context.backend) return context.backend;

  const mergedOptions: ShellClaudeCliBackendOptions = {
    ...buildClaudeCliOptionsFromEnv(),
    ...(context.backendOptions || {}),
  };
  const availability = probeShellClaudeCliAvailability(process.env, {
    bin: mergedOptions.bin,
    timeoutMs: mergedOptions.timeoutMs,
  });
  if (!availability.available) {
    throw new Error(`[CLAUDE_TASK_RUNNER] Claude CLI unavailable: ${availability.reason ?? 'failed health check'}`);
  }

  return new ShellClaudeCliBackend(mergedOptions);
}

function enforceClaudeTaskApproval(
  opId: string,
  input: unknown,
  context: ClaudeTaskRunnerContext,
): void {
  const payload =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : { value: input };
  const approval = requireApprovalForOp({
    opId,
    agentId: context.agentId,
    channel: context.channel ?? 'system',
    correlationId: context.correlationId,
    payload: context.payload ?? payload,
    draft: context.draft ?? {
      title: `Claude approval required: ${opId}`,
      summary: `Agent ${context.agentId} requests approval for ${opId}.`,
      severity: 'high',
    },
  });

  if (!approval.allowed) {
    throw new Error(approval.message ?? `Approval required for ${opId}`);
  }
}

export async function runApprovedClaudeBrowserTask(
  input: BrowserAgentTaskInput,
  context: ClaudeTaskRunnerContext,
): Promise<string> {
  enforceClaudeTaskApproval(RISKY_OPS.CLAUDE_BROWSER_INTERACTIVE, input, context);
  return resolveBackend(context).runBrowserAgentTask(input);
}

export async function runApprovedClaudeDocumentTask(
  input: DocumentAgentTaskInput,
  context: ClaudeTaskRunnerContext,
): Promise<string> {
  enforceClaudeTaskApproval(RISKY_OPS.CLAUDE_DOCUMENT_GENERATION, input, context);
  return resolveBackend(context).runDocumentAgentTask(input);
}
