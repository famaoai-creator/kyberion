/**
 * Claude provider-native sub-agent projection (CN-02).
 *
 * Projects Kyberion's runtime-independent contracts onto the Claude CLI's
 * own sub-agent mechanism, so a delegated task runs as a *provider-native*
 * sub-agent inside one shared CLI session instead of one `claude -p` process
 * per task (the shape CT-05 established for Codex and the AGY SDK track
 * established for AGY).
 *
 * Everything here derives from existing SSoTs — this module owns no policy
 * of its own:
 *
 *  - KD-05 tiers (`subagent-capability-profiles.ts`) → the agent definition's
 *    `tools:` allowlist and its capability-framing sentence;
 *  - XP-02 permission matrix (`provider-permission-profiles.ts`) → the CLI
 *    session's `--permission-mode` / `--disallowedTools` projection;
 *  - working principles + `subagent-prompt-framing.ts` → the same governance
 *    framing the committed `.claude/agents/*.md` definitions carry.
 *
 * Protocol facts this module encodes (verified against Claude Code CLI
 * 2.1.x, `--input-format stream-json`):
 *
 *  - the built-in delegation tool is named `Task` on the `--tools` allowlist
 *    but is surfaced as `Agent` in stream messages, so observation must
 *    accept both names ({@link CLAUDE_NATIVE_SUBAGENT_TOOL_NAMES});
 *  - sub-agents run in the *background* by default; the parent then returns
 *    a "launched" acknowledgement instead of the sub-agent's report. The
 *    delegation prompt therefore demands `run_in_background: false`
 *    ({@link buildClaudeNativeDelegationPrompt}), and the session adapter
 *    keeps a background-mode fallback for CLI builds that ignore it.
 */

import {
  getSubagentCapabilityProfile,
  type SubagentCapabilityProfile,
} from './subagent-capability-profiles.js';
import {
  resolveProviderPermissionArgs,
  type ProviderPermissionProfileName,
} from './provider-permission-profiles.js';
import { buildWorkingPrinciplesLines } from './working-principles.js';
import {
  SUBAGENT_SECURE_IO_CONSTRAINT,
  SUBAGENT_SHARED_DIRECTORY_RULES_LINES,
} from './subagent-prompt-framing.js';

/** Built-in tool name the parent session is allowed to use (`--tools`). */
export const CLAUDE_PARENT_SESSION_TOOLS: readonly string[] = ['Task'];

/**
 * Stream-message tool names that prove a provider-native sub-agent was
 * actually started. `Agent` is what current CLI builds emit; `Task` is the
 * historical name and the `--tools` vocabulary.
 */
export const CLAUDE_NATIVE_SUBAGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task'];

/** Namespace prefix for Kyberion-injected agent definitions. */
export const CLAUDE_NATIVE_AGENT_PREFIX = 'kyberion-';

export interface ClaudeNativeAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  /** Mutable by design: this object is a provider payload (`--agents` / SDK `agents`). */
  readonly tools: string[];
}

export interface ClaudeNativeSessionPermission {
  /** `--permission-mode` value projected from the XP-02 matrix. */
  readonly permissionMode: string;
  /** Tools the sub-agent definition may use (KD-05 ∩ permission matrix). */
  readonly agentTools: readonly string[];
  /** Tools explicitly denied by the permission matrix, if any. */
  readonly disallowedTools: readonly string[];
}

/** `kyberion-explorer` etc. — the `subagent_type` the parent must call. */
export function claudeNativeAgentName(profileName: string): string {
  return `${CLAUDE_NATIVE_AGENT_PREFIX}${profileName}`;
}

function unavailable(message: string): Error {
  return new Error(`[SUBAGENT_UNAVAILABLE] ${message}`);
}

/**
 * Parse the XP-02 matrix's flat argv projection into flags. Fails closed on
 * any flag this module does not know how to honor, rather than silently
 * dropping a restriction the matrix intended to apply.
 */
function parsePermissionArgs(args: readonly string[]): Record<string, string[]> {
  const known = new Set(['--permission-mode', '--allowedTools', '--disallowedTools']);
  const flags: Record<string, string[]> = {};
  let current: string | undefined;
  for (const token of args) {
    if (token.startsWith('--')) {
      if (!known.has(token)) {
        throw unavailable(
          `Claude permission projection contains an unsupported flag for native delegation: ${token}`
        );
      }
      current = token;
      flags[current] = [];
      continue;
    }
    if (!current) {
      throw unavailable(
        `Claude permission projection contains a value with no preceding flag: ${token}`
      );
    }
    flags[current].push(token);
  }
  return flags;
}

/**
 * Project a KD-05 tier onto the native session's permission surface.
 *
 * The parent session is always restricted to the delegation tool alone (see
 * {@link CLAUDE_PARENT_SESSION_TOOLS}) so it cannot do the work itself; the
 * tier's real tool budget is carried by the sub-agent definition, narrowed
 * to the intersection of the KD-05 CLI projection and the permission
 * matrix's allowlist (least agency wins when the two differ).
 */
export function resolveClaudeNativeSessionPermission(
  profileName: ProviderPermissionProfileName
): ClaudeNativeSessionPermission {
  const resolution = resolveProviderPermissionArgs(profileName, 'claude');
  if (resolution.kind === 'refused') {
    throw unavailable(`Claude permission profile "${profileName}" refused: ${resolution.reason}`);
  }
  const flags = parsePermissionArgs(resolution.args);
  const permissionMode = flags['--permission-mode']?.[0];
  if (!permissionMode) {
    throw unavailable(
      `Claude permission projection for "${profileName}" declares no --permission-mode.`
    );
  }
  const profile = getSubagentCapabilityProfile(profileName);
  const matrixAllowed = flags['--allowedTools'];
  const disallowedTools = flags['--disallowedTools'] ?? [];
  const agentTools = (
    matrixAllowed
      ? profile.cliTools.filter((tool) => matrixAllowed.includes(tool))
      : profile.cliTools
  ).filter((tool) => !disallowedTools.includes(tool));

  return { permissionMode, agentTools, disallowedTools };
}

/** The governed system prompt a native sub-agent runs under. */
export function buildClaudeNativeAgentPrompt(profile: SubagentCapabilityProfile): string {
  return [
    profile.systemPromptPrefix,
    '',
    ...buildWorkingPrinciplesLines(),
    '## secure-io constraint',
    '',
    SUBAGENT_SECURE_IO_CONSTRAINT,
    '',
    ...SUBAGENT_SHARED_DIRECTORY_RULES_LINES,
    '## Output contract',
    '',
    'Return a concise report of what you did and what you found. Do not ask the parent session questions — state blockers in the report instead.',
  ].join('\n');
}

/**
 * The `--agents` payload for one KD-05 tier. Built at call time from the
 * registries above (never from a committed artifact), so a tier change
 * cannot drift out of the runtime projection.
 */
export function buildClaudeNativeAgentDefinitions(
  profileName: ProviderPermissionProfileName
): Record<string, ClaudeNativeAgentDefinition> {
  const profile = getSubagentCapabilityProfile(profileName);
  const { agentTools } = resolveClaudeNativeSessionPermission(profileName);
  return {
    [claudeNativeAgentName(profile.name)]: {
      description: `${profile.description} ${profile.whenToUse}`,
      prompt: buildClaudeNativeAgentPrompt(profile),
      tools: [...agentTools],
    },
  };
}

export interface ClaudeNativeDelegationPromptInput {
  readonly profileName: string;
  readonly instruction: string;
  readonly context?: string;
}

/**
 * The parent-session turn that forces an actual native delegation.
 *
 * `run_in_background: false` is load-bearing: with the CLI default, the
 * parent returns "agent launched" and the sub-agent's report only arrives in
 * a later auto-continued turn — a delegation result the caller would
 * otherwise never see.
 */
export function buildClaudeNativeDelegationPrompt(
  input: ClaudeNativeDelegationPromptInput
): string {
  const agentName = claudeNativeAgentName(input.profileName);
  return [
    '<kyberion-delegated-task>',
    `Delegate the task below to the "${agentName}" sub-agent using the Agent tool.`,
    `Call it with subagent_type: "${agentName}" and run_in_background: false — wait for the sub-agent to finish; never run it in the background.`,
    'Do not perform the task yourself and do not use any other tool.',
    input.context ? `Context:\n${input.context}` : '',
    `Task: ${input.instruction}`,
    'When the sub-agent returns, output its report verbatim and nothing else — no preamble, no summary of your own.',
    '</kyberion-delegated-task>',
  ]
    .filter(Boolean)
    .join('\n\n');
}
