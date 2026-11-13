import { hasTestRunMarker } from '../foundation/env.js';

/**
 * Provenance stamp for rows that an interactive agent session's hooks (the
 * kyberion-claude-code plugin) append to live ledgers of the checkout the
 * session works in: audit-chain rows (PostToolUse, UserPromptSubmit, Stop —
 * and the tenant audit mirror copy of each) and the Stop hook's
 * execution-metrics CLI-usage row (`recordCliUsage`).
 *
 * Those appends land in live state while the session's own test run is in
 * progress, so the Vitest live-state leak guard (tests/vitest-active-leak-guard.ts)
 * needs to tell them apart from a test that leaks a row into the same file.
 * The stamp is that distinction:
 *
 *  - it is written only by the hook bridge, only for a payload that carries the
 *    host session id, and never from a process with any test-run marker
 *    (`hasTestRunMarker`) — an ordinary audit write (any other
 *    `auditChain.record` caller), the hook's own unit tests and test children
 *    spawned with `VITEST: ''` do not produce it;
 *  - {@link isSessionHookAuditRow} / {@link isSessionHookMetricsRow} accept a
 *    row only when the stamp AND the row kind the hook writes match (agent id +
 *    action paired with its event; metrics component + agent with `Stop`), so a
 *    stamp-like field on any other row is still reported.
 *
 * The writer (`claude-code-hook.ts`) builds its rows from the constants below,
 * so writer and classifier cannot drift apart.
 *
 * Not stamped (growth stays reported): co-session writes (presence rows are
 * folded in place, lease and delivery-receipt files are rewritten JSON, and
 * the row builders are shared with the operator `co-session` CLI) and the
 * tier-guard denial rows a PreToolUse evaluation records (recorded
 * asynchronously inside tier-guard under its own generic agent id).
 *
 * Its only import is the side-effect-free `foundation/env` marker check, so
 * the leak guard (a Vitest globalSetup) can load it from source without a build.
 */

export const SESSION_HOOK_PROVENANCE_KEY = 'session_hook';

/** Agent id the hook bridge records under, per host (`hookHostAgentId`). */
export const SESSION_HOOK_AGENT_ID = { claude: 'claude-code', devin: 'devin-cli' } as const;

export const SESSION_HOOK_AGENT_IDS: readonly string[] = Object.values(SESSION_HOOK_AGENT_ID);

export type SessionHookEvent = 'PostToolUse' | 'UserPromptSubmit' | 'Stop';

/** Audit actions the hook bridge records. */
export const SESSION_HOOK_AUDIT_ACTION = {
  tool: 'claude_code_tool',
  userPrompt: 'claude_code_user_prompt',
  stop: 'claude_code_stop',
} as const;

/** Each audit action with the one hook event that records it. */
export const SESSION_HOOK_AUDIT_ACTIONS: Readonly<Record<string, SessionHookEvent>> = {
  [SESSION_HOOK_AUDIT_ACTION.tool]: 'PostToolUse',
  [SESSION_HOOK_AUDIT_ACTION.userPrompt]: 'UserPromptSubmit',
  [SESSION_HOOK_AUDIT_ACTION.stop]: 'Stop',
};

/** The metrics component (and `agent`) the Stop hook's `recordCliUsage` records under. */
export const SESSION_HOOK_METRICS_COMPONENT = 'claude-code-cli';

export interface SessionHookProvenance {
  host: 'claude' | 'devin';
  event: SessionHookEvent;
  session_id: string;
}

/**
 * The stamp for one hook-recorded row (audit or metrics), or undefined when the
 * row must not be attributed to a session hook: no host session id in the
 * payload, or the caller carries a test-run marker (a test exercising the hook
 * bridge, or a child a test spawned).
 */
export function sessionHookProvenance(
  host: 'claude' | 'devin',
  event: SessionHookEvent,
  sessionId: unknown,
  env: Record<string, string | undefined> = process.env
): SessionHookProvenance | undefined {
  if (hasTestRunMarker(env)) return undefined;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return undefined;
  return { host, event, session_id: sessionId.trim() };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidStamp(stamp: unknown, event: SessionHookEvent | undefined): boolean {
  return (
    isObject(stamp) &&
    (stamp.host === 'claude' || stamp.host === 'devin') &&
    event !== undefined &&
    stamp.event === event &&
    typeof stamp.session_id === 'string' &&
    stamp.session_id.trim() !== ''
  );
}

/** Whether a parsed audit row was recorded by an agent session's hook bridge. */
export function isSessionHookAuditRow(row: unknown): boolean {
  if (!isObject(row)) return false;
  if (typeof row.agentId !== 'string' || !SESSION_HOOK_AGENT_IDS.includes(row.agentId))
    return false;
  if (typeof row.action !== 'string' || !Object.hasOwn(SESSION_HOOK_AUDIT_ACTIONS, row.action)) {
    return false;
  }
  const metadata = row.metadata;
  if (!isObject(metadata)) return false;
  return isValidStamp(
    metadata[SESSION_HOOK_PROVENANCE_KEY],
    SESSION_HOOK_AUDIT_ACTIONS[row.action]
  );
}

/**
 * Whether a parsed execution-metrics row is the Stop hook's CLI token-usage row
 * (`recordCliUsage`): component and agent `claude-code-cli`, and a top-level
 * stamp whose event is `Stop`. Any other metrics row with a stamp is not.
 */
export function isSessionHookMetricsRow(row: unknown): boolean {
  if (!isObject(row)) return false;
  if (row.component !== SESSION_HOOK_METRICS_COMPONENT) return false;
  if (row.agent !== SESSION_HOOK_METRICS_COMPONENT) return false;
  return isValidStamp(row[SESSION_HOOK_PROVENANCE_KEY], 'Stop');
}

/** Whether a parsed append-only ledger row (audit or metrics) was written by an agent session's hooks. */
export function isSessionHookRow(row: unknown): boolean {
  return isSessionHookAuditRow(row) || isSessionHookMetricsRow(row);
}
