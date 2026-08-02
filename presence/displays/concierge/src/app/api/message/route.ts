import { NextRequest, NextResponse } from 'next/server';
import type { SurfaceConversationResult } from '@agent/core/channel-surface';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { conciergeText, resolveConciergeLocale, type ConciergeLocale } from '../../../lib/i18n';
import type {
  ConversationMessageResponse,
  ConversationNextAction,
  ConversationPromotion,
  ConversationShape,
} from '../../../lib/conversation-types';

export const dynamic = 'force-dynamic';

/**
 * CS-01 conversation core — ported from the legacy Express concierge
 * (`presence/displays/concierge/server.ts`) with the same two-path
 * failover and no single point of failure:
 *
 *   Primary path  — voice-hub /api/ingest-text (richest experience: greeting
 *                   chit-chat, orchestrator, server-side TTS, presence
 *                   reflection). Bounded by a short abort timeout so the UI
 *                   never hangs on a stopped daemon.
 *   Fallback path — LAZILY import @agent/core and call
 *                   runSurfaceMessageConversation directly (the same entry
 *                   chronos uses), so knowledge queries and mission promotion
 *                   still work without a second daemon.
 *   Both fail     — a clear, actionable user message (never a silent failure).
 */
const VOICE_HUB_URL = process.env.VOICE_HUB_URL || 'http://127.0.0.1:3032';
const VOICE_HUB_TIMEOUT_MS = 3000;

/** Primary path: voice-hub (rich reply + TTS + presence reflection). */
async function replyViaVoiceHub(text: string, speaker: string): Promise<string> {
  const resp = await fetch(`${VOICE_HUB_URL}/api/ingest-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      intent: 'conversation',
      source_id: 'concierge',
      speaker,
      reflect_to_surface: true,
      auto_reply: true,
    }),
    signal: AbortSignal.timeout(VOICE_HUB_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`voice-hub responded ${resp.status}`);
  const data = (await resp.json()) as { reply?: unknown; text?: unknown; response?: unknown };
  const reply = String(data.reply ?? data.text ?? data.response ?? '').trim();
  // An empty reply is a silent failure from the user's perspective; degrade
  // to the orchestrator instead of returning nothing.
  if (!reply) throw new Error('empty voice-hub reply');
  return reply;
}

/**
 * Map the orchestrator result to a user-facing conversation shape
 * (docs/USER_EXPERIENCE_CONTRACT.md). Only what the result actually
 * distinguishes is claimed:
 *
 * - `missionProposals` / `approvalRequests` — work is about to begin and
 *   needs an explicit go-ahead → Execution Preview.
 * - `delegationResults` — delegated work completed and `text` summarizes the
 *   delivered responses → Delivery Summary.
 * - anything else (direct_reply) → plain `reply`. The result carries no
 *   dedicated clarification/status marker, so those shapes are never
 *   fabricated here.
 */
function deriveConversationView(
  conversation: SurfaceConversationResult,
  locale: ConciergeLocale
): {
  shape: ConversationShape;
  promoted?: ConversationPromotion;
  nextActions?: ConversationNextAction[];
} {
  const missionProposal = conversation.missionProposals?.[0];
  const approvalRequests = conversation.approvalRequests ?? [];
  const delegationResults = conversation.delegationResults ?? [];

  if (missionProposal) {
    const label = String(
      missionProposal.summary || missionProposal.why || missionProposal.mission_type || ''
    ).trim();
    return {
      shape: 'execution_preview',
      promoted: label ? { kind: 'mission', label } : undefined,
      // The "next action" must be directly actionable: these labels are sent
      // back verbatim through /api/message as the confirmation/decline turn.
      nextActions: [
        { id: 'confirm', label: conciergeText('dock.confirm_proceed', locale) },
        { id: 'cancel', label: conciergeText('dock.decline_proceed', locale) },
      ],
    };
  }
  if (approvalRequests.length > 0) {
    return { shape: 'execution_preview' };
  }
  if (delegationResults.length > 0) {
    const promotedDelegation = delegationResults.find((entry) => entry.missionId);
    return {
      shape: 'delivery_summary',
      promoted: promotedDelegation?.missionId
        ? { kind: 'task_session', label: promotedDelegation.missionId }
        : undefined,
    };
  }
  return { shape: 'reply' };
}

/** Fallback path: call the orchestrator directly (lazy-loaded @agent/core). */
async function replyViaOrchestrator(
  text: string,
  speaker: string,
  sessionId: string | undefined,
  locale: ConciergeLocale
): Promise<ConversationMessageResponse> {
  const [channelSurface, pathResolverModule] = await Promise.all([
    import('@agent/core/channel-surface'),
    import('@agent/core/path-resolver'),
  ]);
  const conversation = await channelSurface.runSurfaceMessageConversation({
    surface: 'presence',
    text,
    senderAgentId: 'kyberion:concierge',
    agentId: 'presence-surface-agent',
    actorId: speaker,
    threadTs: sessionId,
    cwd: pathResolverModule.pathResolver.rootDir(),
  });
  const reply = String(conversation?.text ?? '').trim();
  if (!reply) throw new Error('empty orchestrator reply');
  const view = deriveConversationView(conversation, locale);
  return { reply, mode: 'orchestrator', ...view };
}

// Primary conversation entrypoint. Tries voice-hub, then degrades to the
// orchestrator, then fails loudly (never silently).
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const locale = resolveConciergeLocale(
    typeof body.locale === 'string' ? body.locale : req.headers.get('accept-language') || undefined
  );
  const text = String(body.text ?? '').trim();
  if (!text) {
    return NextResponse.json(
      { ok: false, error: conciergeText('api.text_required', locale) },
      { status: 400 }
    );
  }
  const speaker = typeof body.speaker === 'string' && body.speaker ? body.speaker : 'Sovereign';
  const sessionId =
    typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : undefined;

  // Try voice-hub first (rich path). It only returns a plain reply string, so
  // no conversation shape can be honestly derived from it.
  try {
    const reply = await replyViaVoiceHub(text, speaker);
    const payload: ConversationMessageResponse = { reply, mode: 'voice-hub', shape: 'reply' };
    return NextResponse.json(payload);
  } catch (error) {
    console.warn(
      `[concierge] voice-hub path failed (${error instanceof Error ? error.message : String(error)}); falling back to orchestrator`
    );
  }

  // Degrade to the orchestrator directly (no voice-hub needed).
  try {
    const payload = await replyViaOrchestrator(text, speaker, sessionId, locale);
    return NextResponse.json(payload);
  } catch (error) {
    console.warn(
      `[concierge] orchestrator fallback failed (${error instanceof Error ? error.message : String(error)})`
    );
  }

  // Both paths failed — clear, actionable message (UX-01: no silent failure).
  const unavailable: ConversationMessageResponse = {
    reply: conciergeText('api.message_unavailable', locale),
    mode: 'unavailable',
    shape: 'reply',
  };
  return NextResponse.json(unavailable, { status: 503 });
}
