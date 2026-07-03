import * as nodePath from 'node:path';
import type { CanUseTool, McpServerConfig, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { pathResolver } from './path-resolver.js';
import { auditChain } from './audit-chain.js';
import { evaluatePreToolUse } from './claude-code-hook.js';
import { evaluateShellCommandPolicy } from './shell-command-policy.js';

/**
 * Direction B: make the claude-agent SDK sub-agent a *governed Kyberion citizen*
 * when it does agentic (tool-using) work, instead of a raw Claude Code instance.
 *
 * Three governance pieces, all SDK-agnostic + unit-testable:
 *  - `buildKyberionMcpServerConfig` — wires Kyberion's own MCP surface into the
 *    sub-agent so it reuses governed pipelines/actuators/knowledge.
 *  - `createKyberionCanUseTool` — a `canUseTool` gate: read-only + kyberion.* tools
 *    pass; file writes are tier-guarded (same kernel as Direction A's PreToolUse);
 *    Bash is policy-gated and audited; everything else is denied (least privilege).
 *  - `buildGovernedAgentSystemPrompt` — injects the deterministic-first / tier rules
 *    plus mission & knowledge context.
 */

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Advisory allowlist passed to the SDK (the canUseTool gate is the real enforcer). */
export const GOVERNED_AGENT_ALLOWED_TOOLS: string[] = [
  'Read',
  'Grep',
  'Glob',
  'NotebookRead',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
];

function allow(input: Record<string, unknown>): PermissionResult {
  return { behavior: 'allow', updatedInput: input };
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message, interrupt: false };
}

function auditAgentTool(toolName: string, input: Record<string, unknown>): void {
  try {
    auditChain.record({
      agentId: 'claude-agent-subagent',
      action: 'subagent_tool',
      operation: toolName,
      result: 'allowed',
      metadata: { tool: toolName, input: summarizeInput(input) },
    });
  } catch {
    // audit is best-effort; never block the sub-agent on a logging failure
  }
}

function extractShellCommand(input: Record<string, unknown> = {}): string {
  const value = input.command ?? input.cmd ?? input.shell_command ?? input.prompt;
  return typeof value === 'string' ? value.trim() : '';
}

function summarizeInput(input: Record<string, unknown> = {}): Record<string, unknown> {
  const fp = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof fp === 'string') return { file_path: fp };
  if (typeof input.command === 'string') return { command: input.command.slice(0, 200) };
  return {};
}

/**
 * Build a `canUseTool` gate enforcing Kyberion governance on the sub-agent's
 * tool calls. Reuses the Direction-A tier-guard for file writes so both entry
 * points share one kernel.
 */
export function createKyberionCanUseTool(): CanUseTool {
  return async (toolName, input) => {
    if (READ_ONLY_TOOLS.has(toolName)) return allow(input);

    // Governed Kyberion MCP tools (already allowlisted / tier-isolated / audited server-side).
    if (toolName.includes('kyberion')) {
      auditAgentTool(toolName, input);
      return allow(input);
    }

    if (FILE_WRITE_TOOLS.has(toolName)) {
      const decision = evaluatePreToolUse({
        tool_name: toolName,
        tool_input: input,
      }).hookSpecificOutput;
      if (decision.permissionDecision === 'deny') return deny(decision.permissionDecisionReason);
      auditAgentTool(toolName, input);
      return allow(input);
    }

    if (toolName === 'Bash') {
      const command = extractShellCommand(input);
      const decision = evaluateShellCommandPolicy(command);
      if (decision.verdict !== 'allow') {
        return deny(
          `${decision.reason} ${command ? `Command: ${command}` : 'Bash command was not provided.'}`
        );
      }
      auditAgentTool(toolName, input);
      return allow(input);
    }

    return deny(
      `Kyberion governance: tool "${toolName}" is not in the governed sub-agent allowlist.`
    );
  };
}

/** Wire Kyberion's own MCP server (the kyberion.* surface) into the sub-agent. */
export function buildKyberionMcpServerConfig(
  repoRoot: string = pathResolver.rootDir()
): Record<string, McpServerConfig> {
  return {
    kyberion: {
      type: 'stdio',
      command: 'node',
      args: [nodePath.join(repoRoot, 'dist/scripts/mcp_server.js')],
      cwd: repoRoot,
      env: { KYBERION_PERSONA: process.env.KYBERION_PERSONA ?? 'sovereign_concierge' },
    } as McpServerConfig,
  };
}

export interface GovernedAgentPromptInput {
  base: string;
  missionContext?: string;
  knowledgeContext?: string;
  tierScope?: string;
}

/** Compose the sub-agent system prompt with Kyberion conventions + context. */
export function buildGovernedAgentSystemPrompt(input: GovernedAgentPromptInput): string {
  return [
    input.base,
    '',
    'You are operating as a Kyberion sub-agent under governance:',
    '- Prefer governed kyberion.* MCP tools and existing pipelines/actuators over raw file/shell edits (deterministic-first ladder).',
    '- Never write into knowledge/personal or knowledge/confidential tiers directly; route through Kyberion.',
    input.tierScope ? `- Tier scope: ${input.tierScope}.` : '',
    input.missionContext ? `\nMission context:\n${input.missionContext}` : '',
    input.knowledgeContext ? `\nRelevant knowledge:\n${input.knowledgeContext}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
