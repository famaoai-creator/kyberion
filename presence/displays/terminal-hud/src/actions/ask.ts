import { runSurfaceMessageConversation } from '@agent/core';
import type { IntentResolutionContract } from '@agent/core';
import { auditAction } from './dispatch.js';

export interface AskReply {
  ok: boolean;
  text: string;
  intentResolution?: IntentResolutionContract;
}

/**
 * Route free-form operator input through the same governed CLI surface
 * conversation used by `pnpm kyberion ask` (reasoning backend + delegation).
 */
export async function askKyberion(text: string): Promise<AskReply> {
  const correlationId = `tui-ask-${Date.now().toString(36)}`;
  try {
    const result = await runSurfaceMessageConversation({
      surface: 'cli',
      text,
      channel: 'terminal-hud',
      threadTs: correlationId,
      correlationId,
      receivedAt: new Date().toISOString(),
      actorId: 'operator',
      senderAgentId: 'kyberion:terminal-hud',
      agentId: 'cli-surface-agent',
      delegationSummaryInstruction:
        'Produce a concise terminal-friendly reply in the operator language. No A2A blocks.',
    });
    const reply = (result as { text?: string })?.text?.trim() ?? '';
    auditAction('ask', { ok: true, message: text.slice(0, 200) }, { correlationId });
    return {
      ok: true,
      text: reply,
      intentResolution: result.intentResolution,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    auditAction('ask', { ok: false, message }, { correlationId });
    return { ok: false, text: message };
  }
}
