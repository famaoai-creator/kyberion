import { auditChain } from '@agent/core';

export interface ActionResult {
  ok: boolean;
  message: string;
}

const TUI_AGENT_ID = 'terminal-hud';

export function auditAction(
  operation: string,
  result: ActionResult,
  metadata?: Record<string, unknown>
): ActionResult {
  if (process.env.KYBERION_TUI_DISABLE_AUDIT === '1') return result;
  try {
    auditChain.record({
      agentId: TUI_AGENT_ID,
      action: 'tui_action',
      operation,
      result: result.ok ? 'completed' : 'failed',
      reason: result.message.slice(0, 500),
      metadata,
    });
  } catch {
    // audit failures must not mask the action result
  }
  return result;
}

export function toActionResult(err: unknown): ActionResult {
  return { ok: false, message: err instanceof Error ? err.message : String(err) };
}

export const HUD_PEER_ID = TUI_AGENT_ID;
