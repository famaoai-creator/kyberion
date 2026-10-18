import { auditChain } from '../governance/audit-chain.js';
import { metrics } from '../metrics.js';
import { evaluateShellCommandPolicy } from '../shell/shell-command-policy.js';
import { detectTier, validateWritePermission } from '../tier-guard.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import {
  coSessionHookDrain,
  coSessionHookEnd,
  coSessionHookJoin,
  coSessionHookLeaseGate,
  formatPendingHandoffs,
} from './co-session-hook.js';

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
  session_id?: string;
}

export interface PostToolUseInput extends PreToolUseInput {
  tool_response?: unknown;
}

export interface PreToolUseHookOutput {
  // Devin CLI honors these top-level fields; Claude Code reads
  // hookSpecificOutput.permissionDecision. Both mean "deny" — see pre().
  decision?: 'block';
  reason?: string;
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

export interface UserPromptSubmitHookOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

export interface StopHookOutput {
  hookSpecificOutput: {
    hookEventName: 'Stop';
    additionalContext: string;
  };
}

/**
 * Devin CLI auto-loads `.claude/settings.json` hooks (compat), so this
 * entrypoint can run under either host. Distinguish the host for co-session
 * presence and audit attribution via the env Devin injects into hook
 * processes (`DEVIN_PROJECT_DIR`, and the `AI_AGENT` / `CHISEL_SESSION_DB`
 * markers present in its process environment).
 */
export function resolveHookHostProvider(): 'claude' | 'devin' {
  const env = process.env;
  return env.DEVIN_PROJECT_DIR || env.CHISEL_SESSION_DB || /^devin/i.test(env.AI_AGENT ?? '')
    ? 'devin'
    : 'claude';
}

function hookHostAgentId(): string {
  return resolveHookHostProvider() === 'devin' ? 'devin-cli' : 'claude-code';
}

/**
 * Devin CLI tool names → the Claude Code names this bridge was written
 * against (`exec` is Devin's shell). Applied unconditionally: the lowercase
 * names never appear under Claude Code, so aliasing is a no-op there.
 * `apply_patch` has no reliable path field — it maps to Edit, but tier/lease
 * checks only run when a path actually extracts.
 */
const HOST_TOOL_ALIASES: Record<string, string> = {
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  notebook_edit: 'NotebookEdit',
  exec: 'Bash',
};

function canonicalHookToolName(tool: string | undefined): string {
  const name = tool ?? '';
  return HOST_TOOL_ALIASES[name] ?? name;
}

/** File-mutating tools whose target path we can reliably extract + tier-check. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Tools whose completed execution we record into the audit chain. */
const AUDITED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function normalizePrompt(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyPromptIntent(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const hints: string[] = [];
  if (/presentation|slide|deck|proposal/.test(normalized))
    hints.push(
      'Use the presentation preference profile and keep pattern selection separate from theme selection.'
    );
  if (/mission|scope|task|implement|build|fix/.test(normalized))
    hints.push('Start or update a Kyberion mission before changing code.');
  if (/review|pr|pull request|validate|test/.test(normalized))
    hints.push('Run the validation path first, then /ky-review after the work is stable.');
  if (/voice|audio|meeting|slack/.test(normalized))
    hints.push('Prefer the governed actuator or plugin surface instead of ad hoc shell work.');
  return hints.slice(0, 3);
}

function targetPaths(toolInput: Record<string, unknown> = {}): string[] {
  const candidate = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  return typeof candidate === 'string' && candidate ? [candidate] : [];
}

function pre(decision: PermissionDecision, reason: string): PreToolUseHookOutput {
  const out: PreToolUseHookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  // Devin ignores permissionDecision — its hook contract reads top-level
  // `decision`/`reason` instead. Emit them only for deny; 'ask' falls through
  // to Devin's own permission prompt just like a silent response would.
  if (decision === 'deny' && resolveHookHostProvider() === 'devin') {
    out.decision = 'block';
    out.reason = reason;
  }
  return out;
}

/** Deny response for fail-closed paths in the script boundary. */
export function denyHookResponse(reason: string): PreToolUseHookOutput {
  return pre('deny', reason);
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
/**
 * Deny-only shell gate for interactive Claude Code sessions.
 *
 * Unlike {@link evaluatePreToolUse} (which denies anything the policy does not
 * explicitly allow — right for headless agents, far too strict for a human-led
 * session), this returns a decision only when a denylist rule matches, e.g.
 * `document-hand-extraction` steering agents to `pnpm kyberion read`. Every
 * other command returns null so Claude Code's own permission flow (prompts,
 * allow rules) stays in charge — returning 'allow' would silently auto-approve.
 */
export function evaluatePreToolUseShellDeny(input: PreToolUseInput): PreToolUseHookOutput | null {
  if (canonicalHookToolName(input.tool_name) !== 'Bash') return null;
  const command = String(input.tool_input?.command ?? input.tool_input?.cmd ?? '').trim();
  if (!command) return null;
  const decision = evaluateShellCommandPolicy(command);
  if (decision.verdict !== 'deny') return null;
  return pre('deny', decision.reason || 'Denied by Kyberion shell-command policy.');
}

export function evaluatePreToolUse(input: PreToolUseInput): PreToolUseHookOutput {
  const tool = canonicalHookToolName(input.tool_name);
  if (tool === 'Bash') {
    const command = String(input.tool_input?.command ?? input.tool_input?.cmd ?? '').trim();
    const decision = evaluateShellCommandPolicy(command);
    if (decision.verdict !== 'allow') {
      return pre(
        'deny',
        `${decision.reason} ${command ? `Command: ${command}` : 'Bash command was not provided.'}`
      );
    }
    return pre('allow', 'Kyberion shell-command policy: Bash command allowed.');
  }
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
          'Use a Kyberion mission / the kyberion.* MCP tools, or configure KYBERION_PERSONA + authority.'
      );
    }
  }
  for (const p of targetPaths(input.tool_input)) {
    const gate = coSessionHookLeaseGate({
      provider: resolveHookHostProvider(),
      session_key: input.session_id,
      file_path: p,
    });
    if (gate.decision === 'deny') {
      return pre('deny', `Kyberion co-session lease gate: ${gate.reason}`);
    }
  }
  return pre('allow', 'Kyberion tier-guard: write permitted.');
}

function recordSessionSignal(action: string, metadata: Record<string, unknown>): void {
  try {
    auditChain.record({
      agentId: hookHostAgentId(),
      action,
      operation: 'session_signal',
      result: 'completed',
      metadata,
    });
  } catch {
    // best-effort; never fail the session on logging
  }
}

export function buildUserPromptSubmitContext(input: Record<string, unknown> = {}): string {
  const prompt = normalizePrompt(input.prompt);
  const summary = prompt ? truncate(prompt, 180) : 'No prompt text was provided.';
  const hints = prompt ? classifyPromptIntent(prompt) : [];
  recordSessionSignal('claude_code_user_prompt', {
    cwd: input.cwd,
    prompt_summary: summary,
    hints,
  });

  const handoffBlock = formatPendingHandoffs(
    coSessionHookDrain({
      provider: resolveHookHostProvider(),
      session_key: input.session_id as string | undefined,
      only_new: true,
    })
  );

  return [
    'Kyberion captured the user prompt for coordination.',
    `Prompt summary: ${summary}`,
    ...(hints.length
      ? ['Next-step hints:', ...hints.map((hint) => `- ${hint}`)]
      : ['Next-step hints: keep the work inside the shared coordination brief.']),
    'If this becomes scoped work, start a Kyberion mission; if it is closing work, run /ky-review.',
    ...(handoffBlock ? ['', handoffBlock] : []),
  ].join('\n');
}

export function buildStopContext(input: Record<string, unknown> = {}): string {
  if (input.stop_hook_active === true) return '';
  const reason = normalizePrompt(input.reason);
  const summary = reason ? truncate(reason, 180) : 'No stop reason was provided.';
  recordSessionSignal('claude_code_stop', {
    cwd: input.cwd,
    reason_summary: summary,
  });

  // Stop is telemetry only. Review reminders belong on UserPromptSubmit;
  // injecting instructions here can repeatedly resume an otherwise done turn.
  return '';
}

/**
 * SessionEnd (fires once when the session actually ends — unlike Stop, which
 * fires after every agent turn). Releases this participant's co-session path
 * leases so they don't linger to TTL. Returns a note for the transcript when
 * anything was released.
 */
export function buildSessionEndContext(input: Record<string, unknown> = {}): string {
  const ended = coSessionHookEnd({
    provider: resolveHookHostProvider(),
    session_key: input.session_id as string | undefined,
  });
  return ended.released_leases > 0
    ? `Released ${ended.released_leases} co-session path lease(s) held by this participant.`
    : '';
}

export interface CliUsageSummary {
  model: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/**
 * Parse a Claude Code transcript (JSONL) and sum token usage across assistant
 * turns. Pure (no I/O) so it is unit-testable; the transcript file read happens in
 * the hook script boundary (it is an external Claude Code artifact, not repo/tier
 * content, so it cannot go through secure-io's project-root read guard).
 */
export function summarizeTranscriptUsage(transcriptText: string): CliUsageSummary | null {
  if (!transcriptText) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let model = '';
  for (const line of transcriptText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = parseSafeJsonInput(trimmed, 'Claude transcript entry');
    } catch {
      continue;
    }
    const msg = obj?.message;
    const usage = msg?.usage;
    if (
      usage &&
      (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number')
    ) {
      inputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      outputTokens += usage.output_tokens ?? 0;
      turns += 1;
      if (typeof msg.model === 'string' && msg.model) model = msg.model;
    }
  }
  if (turns === 0) return null;
  return { model: model || 'unknown', inputTokens, outputTokens, turns };
}

/**
 * Record front-CLI (Claude Code) token usage into the metrics collector under the
 * `claude-code-cli` component, attributed by model. Best-effort. Returns whether a
 * record was written.
 */
export function recordCliUsage(summary: CliUsageSummary | null): boolean {
  if (!summary) return false;
  try {
    metrics.record('claude-code-cli', 0, 'success', {
      model: summary.model,
      agent: 'claude-code-cli',
      turns: summary.turns,
      usage: { prompt_tokens: summary.inputTokens, completion_tokens: summary.outputTokens },
    });
    return true;
  } catch {
    return false;
  }
}

function describeToolInput(
  tool: string,
  toolInput: Record<string, unknown> = {}
): Record<string, unknown> {
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
export function recordPostToolUse(input: PostToolUseInput): {
  recorded: boolean;
  entryId?: string;
} {
  const tool = canonicalHookToolName(input.tool_name);
  if (!AUDITED_TOOLS.has(tool)) return { recorded: false };

  const entry = auditChain.record({
    agentId: hookHostAgentId(),
    action: 'claude_code_tool',
    operation: tool,
    result: 'completed',
    metadata: { tool, ...describeToolInput(tool, input.tool_input), cwd: input.cwd },
  });
  return { recorded: true, entryId: entry.id };
}

/** Context injected at session start so Claude Code follows the operating guide. */
export function buildSessionStartContext(input: Record<string, unknown> = {}): string {
  const provider = resolveHookHostProvider();
  const join = coSessionHookJoin({
    provider,
    session_key: input.session_id as string | undefined,
  });
  return [
    'Kyberion governance is active for this session (kyberion-claude-code plugin).',
    '- Writes into knowledge/ tiers are gated by tier-guard (PreToolUse) — leaks are denied.',
    '- Write/Edit/Bash executions are recorded into the Kyberion audit chain (PostToolUse).',
    '- UserPromptSubmit captures the user prompt as a shared coordination signal.',
    '- Run /ky-review after changes; Stop only records telemetry and never resumes the turn.',
    '- Follow the Operating Guide (CLAUDE.md §3): capture intent → align → execute → review.',
    'Use /ky-baseline to check system health, or /ky-mission-start to open a governed mission.',
    ...(join.joined
      ? [
          `Co-session ${join.session_id}: joined as ${join.participant_id}. ` +
            `Acquire a path lease before editing shared paths: ` +
            `\`co-session lease --action acquire --as ${provider} --participant-id ${join.participant_id} --path <repo/path>\`. ` +
            'Pending handoffs arrive via prompt context.',
        ]
      : []),
  ].join('\n');
}
