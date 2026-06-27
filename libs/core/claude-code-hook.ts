import { auditChain } from './audit-chain.js';
import { detectTier, validateWritePermission } from './tier-guard.js';

/**
 * Claude Code hook bridge (Direction A: Claude Code as front-end → Kyberion).
 *
 * Turns Claude Code's native tool lifecycle into governed Kyberion actions:
 *  - PreToolUse  : tier-guard on file-mutating tools (deny writes that leak a
 *                  higher knowledge tier — the §1 invariant, now enforced not
 *                  just documented).
 *  - PostToolUse : record Write/Edit/Bash executions into the Kyberion audit
 *                  chain, so Claude-Code-initiated work is visible to Chronos /
 *                  the feedback loop exactly like Kyberion-initiated work.
 *  - SessionStart: inject the operating-guide reminder + governance status.
 *
 * Pure functions here; the stdin/stdout wiring lives in
 * `scripts/claude_code_hook.ts` so this stays unit-testable.
 */

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export interface PreToolUseInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface PostToolUseInput extends PreToolUseInput {
  tool_response?: unknown;
}

export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: PermissionDecision;
    permissionDecisionReason: string;
  };
}

export interface SessionStartHookOutput {
  hookSpecificOutput: {
    hookEventName: 'SessionStart';
    additionalContext: string;
  };
}

/** File-mutating tools whose target path we can reliably extract + tier-check. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Tools whose completed execution we record into the audit chain. */
const AUDITED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function targetPaths(toolInput: Record<string, unknown> = {}): string[] {
  const candidate = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  return typeof candidate === 'string' && candidate ? [candidate] : [];
}

function pre(decision: PermissionDecision, reason: string): PreToolUseHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Gate a tool call before it runs.
 *
 * Only writes into a **protected knowledge tier** (`personal` / `confidential`)
 * are tier-gated — that is the §1 leak invariant. Ordinary source files and the
 * `public` tier (everything `detectTier` classifies as `public`) are left freely
 * editable so normal development is never blocked. A protected-tier write is
 * deferred to `validateWritePermission`, so a properly-configured persona/authority
 * can still write; an unconfigured Claude Code session is denied (safe default,
 * matching the plugin's public-tier-only posture).
 */
export function evaluatePreToolUse(input: PreToolUseInput): PreToolUseHookOutput {
  const tool = input.tool_name ?? '';
  if (!FILE_WRITE_TOOLS.has(tool)) {
    return pre('allow', 'No Kyberion gate applies to this tool.');
  }
  for (const p of targetPaths(input.tool_input)) {
    const tier = detectTier(p);
    if (tier === 'public') continue; // source / public knowledge — not tier-gated
    const verdict = validateWritePermission(p);
    if (!verdict.allowed) {
      return pre(
        'deny',
        `Kyberion tier-guard blocked a write into the ${tier} tier: ${verdict.reason ?? 'not authorized'}. ` +
          'Use a Kyberion mission / the kyberion.* MCP tools, or configure KYBERION_PERSONA + authority.',
      );
    }
  }
  return pre('allow', 'Kyberion tier-guard: write permitted.');
}

function describeToolInput(tool: string, toolInput: Record<string, unknown> = {}): Record<string, unknown> {
  if (tool === 'Bash') {
    return { command: truncate(String(toolInput.command ?? ''), 300) };
  }
  const candidate = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  if (typeof candidate === 'string' && candidate) {
    return { file_path: candidate, tier: detectTier(candidate) };
  }
  return {};
}

/**
 * Record a completed Claude Code tool execution into the audit chain.
 * Returns `{ recorded: false }` for tools we don't audit.
 */
export function recordPostToolUse(input: PostToolUseInput): { recorded: boolean; entryId?: string } {
  const tool = input.tool_name ?? '';
  if (!AUDITED_TOOLS.has(tool)) return { recorded: false };

  const entry = auditChain.record({
    agentId: 'claude-code',
    action: 'claude_code_tool',
    operation: tool,
    result: 'completed',
    metadata: { tool, ...describeToolInput(tool, input.tool_input), cwd: input.cwd },
  });
  return { recorded: true, entryId: entry.id };
}

/** Context injected at session start so Claude Code follows the operating guide. */
export function buildSessionStartContext(): string {
  return [
    'Kyberion governance is active for this session (kyberion-claude-code plugin).',
    '- Writes into knowledge/ tiers are gated by tier-guard (PreToolUse) — leaks are denied.',
    '- Write/Edit/Bash executions are recorded into the Kyberion audit chain (PostToolUse).',
    '- Follow the Operating Guide (CLAUDE.md §3): capture intent → align → execute → review.',
    'Use /ky-baseline to check system health, or /ky-mission-start to open a governed mission.',
  ].join('\n');
}
