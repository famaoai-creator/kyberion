import { NextRequest, NextResponse } from 'next/server';
import type { SurfaceConversationResult } from '@agent/core/surface/channel-surface';
import type { IntentResolutionContract } from '@agent/core/intent/intent-resolution-contract-parser';
import { isSimpleGreetingText } from '@agent/core/intent/intent-contract';
import { checkAndRepairSurfaceUxContract } from '@agent/core/surface/surface-ux-contract';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { voiceHubUrl } from '../../../lib/voice-hub';
import { conciergeConversationScope, resolveConciergeViewer } from '../../../lib/viewer-context';
import { conciergeText, resolveConciergeLocale, type ConciergeLocale } from '../../../lib/i18n';
import { CONVERSATION_MAX_INPUT } from '../../../lib/conversation-history';
import {
  beginConversationTurn,
  completeConversationTurn,
  conversationRef,
  readConversationHistory,
  ConversationStoreError,
} from '../../../lib/conversation-store';
import {
  ConversationMessageResponse,
  parseVoiceHubConversationResponse,
  type ConversationNextAction,
  type ConversationPromotion,
  type ConversationShape,
} from '../../../lib/conversation-types';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

/** Restore only the current server-owned conversation; query IDs never select an owner. */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json(readConversationHistory(resolved.context), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'conversation_history_unavailable' },
      {
        status:
          error instanceof ConversationStoreError && error.code === 'identity_required' ? 403 : 503,
        headers: NO_STORE,
      }
    );
  }
}

/**
 * CS-01 conversation core — ported from the legacy Express concierge
 * (`presence/displays/concierge/server.ts`) with the same two-path
 * failover and no single point of failure:
 *
 *   Primary path  — voice-hub /api/ingest-text (richest experience: greeting
 *                   chit-chat, orchestrator, server-side TTS, presence
 *                   reflection, and the shared intent-resolution contract).
 *                   Bounded by a short abort timeout so the UI never hangs
 *                   on a stopped daemon.
 *   Fallback path — LAZILY import @agent/core and call
 *                   runSurfaceMessageConversation directly (the same entry
 *                   chronos uses), so knowledge queries and mission promotion
 *                   still work without a second daemon.
 *   Both fail     — a clear, actionable user message (never a silent failure).
 */
const VOICE_HUB_TIMEOUT_MS = 3000;

/** Primary path: voice-hub (rich reply + TTS + presence reflection). */
async function replyViaVoiceHub(
  text: string,
  speaker: string,
  scope: import('@agent/core/event-scope').EventScopeInput
): Promise<{ reply: string; intentResolution?: IntentResolutionContract }> {
  const resp = await fetch(`${voiceHubUrl()}/api/ingest-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      intent: 'conversation',
      source_id: 'concierge',
      speaker,
      scope,
      reflect_to_surface: true,
      auto_reply: true,
    }),
    signal: AbortSignal.timeout(VOICE_HUB_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`voice-hub responded ${resp.status}`);
  const data = parseVoiceHubConversationResponse(await resp.json());
  if (!data) throw new Error('invalid voice-hub response');
  const { reply } = data;
  // An empty reply is a silent failure from the user's perspective; degrade
  // to the orchestrator instead of returning nothing.
  if (!reply) throw new Error('empty voice-hub reply');
  return {
    reply,
    intentResolution: data.intentResolution,
  };
}

function viewFromIntentResolution(
  contract: IntentResolutionContract
): Pick<ConversationMessageResponse, 'shape' | 'nextActions'> {
  if (contract.authority_level === 'human_clarification_required') {
    return {
      shape: 'clarification',
      nextActions: [{ id: 'provide_input', label: contract.next_action.label }],
    };
  }
  if (contract.authority_level === 'approval_required') {
    return {
      shape: 'execution_preview',
      nextActions: [{ id: 'approve', label: contract.next_action.label }],
    };
  }
  return { shape: 'reply' };
}

function prepareReplyForDelivery(
  reply: string,
  requestText: string,
  intentResolution?: IntentResolutionContract
): string {
  const check = checkAndRepairSurfaceUxContract(reply, {
    allow_conversational_reply: isSimpleGreetingText(requestText),
    approval_required: intentResolution?.authority_level === 'approval_required',
  });
  if (check.repaired) {
    console.info('[concierge] repaired voice-hub reply before delivery');
  } else if (!check.verdict.valid) {
    console.warn(
      `[concierge] voice-hub reply violates surface UX contract: ${check.verdict.violations.join('; ')}`
    );
  }
  return check.text;
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
 * - `intentResolution` supplies the shared clarification/approval boundary;
 *   anything else (direct_reply) → plain `reply`.
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
  locale: ConciergeLocale,
  scope: import('@agent/core/event-scope').EventScopeInput
): Promise<ConversationMessageResponse> {
  const [channelSurface, pathResolverModule] = await Promise.all([
    import('@agent/core/surface/channel-surface'),
    import('@agent/core/path-resolver'),
  ]);
  const conversation = await channelSurface.runSurfaceMessageConversation({
    surface: 'presence',
    text,
    locale,
    senderAgentId: 'kyberion:concierge',
    agentId: 'presence-surface-agent',
    actorId: speaker,
    threadTs: sessionId,
    cwd: pathResolverModule.pathResolver.rootDir(),
    scope,
  });
  const reply = typeof conversation?.text === 'string' ? conversation.text.trim() : '';
  if (!reply) throw new Error('empty orchestrator reply');
  const view = deriveConversationView(conversation, locale);
  const intentView =
    conversation.intentResolution && conversation.intentResolution.authority_level !== 'autonomous'
      ? viewFromIntentResolution(conversation.intentResolution)
      : undefined;
  return {
    reply,
    mode: 'orchestrator',
    ...view,
    ...(conversation.intentResolution ? { intentResolution: conversation.intentResolution } : {}),
    ...(intentView || {}),
  };
}

// Primary conversation entrypoint. Tries voice-hub, then degrades to the
// orchestrator, then fails loudly (never silently).
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const scope = conciergeConversationScope(resolved.context);

  const parsedBody = await readRequestObject(req, 'request body', [
    'text',
    'locale',
    'speaker',
    'sessionId',
  ]);
  if (!parsedBody.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: conciergeText(
          'api.text_required',
          resolveConciergeLocale(req.headers.get('accept-language') || undefined)
        ),
      },
      { status: 400 }
    );
  }
  const { body } = parsedBody;
  const locale = resolveConciergeLocale(
    typeof body?.locale === 'string' ? body.locale : req.headers.get('accept-language') || undefined
  );
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json(
      { ok: false, error: conciergeText('api.text_required', locale) },
      { status: 400 }
    );
  }
  if (text.length > CONVERSATION_MAX_INPUT) {
    return NextResponse.json(
      { ok: false, error: conciergeText('api.message_too_long', locale) },
      { status: 413, headers: NO_STORE }
    );
  }
  let ref: ReturnType<typeof conversationRef>;
  try {
    ref = conversationRef(resolved.context);
  } catch {
    return NextResponse.json(
      { ok: false, error: 'conversation_identity_required' },
      { status: 403, headers: NO_STORE }
    );
  }
  const speaker = resolved.context.principalId!;
  const sessionId = ref.sessionId;
  const durable = body.sessionId !== undefined;
  if (durable && body.sessionId !== sessionId) {
    return NextResponse.json(
      { ok: false, error: 'conversation_scope_changed' },
      { status: 409, headers: NO_STORE }
    );
  }

  // The voice-hub protocol has no verified thread contract. New durable clients
  // use the orchestrator directly, where this server-owned thread is authoritative.
  if (durable) {
    let turnId: string;
    try {
      turnId = beginConversationTurn(resolved.context, text);
    } catch {
      // Nothing was executed: do not lose a request and imply it was accepted.
      return NextResponse.json(
        { ok: false, error: conciergeText('api.history_unavailable', locale) },
        { status: 503, headers: NO_STORE }
      );
    }
    let payload: ConversationMessageResponse;
    let status = 200;
    try {
      payload = await replyViaOrchestrator(text, speaker, sessionId, locale, scope);
    } catch {
      payload = {
        reply: conciergeText('api.message_unavailable', locale),
        mode: 'unavailable',
        shape: 'reply',
      };
      status = 503;
    }
    let historySaved = true;
    try {
      completeConversationTurn(resolved.context, turnId, payload.reply);
    } catch {
      // Execution may have completed. Return the real reply, never invite a blind retry.
      historySaved = false;
    }
    return NextResponse.json({ ...payload, historySaved }, { status, headers: NO_STORE });
  }

  // Try voice-hub first (rich path). The bridge returns the same intent
  // resolution contract as the in-process orchestrator path.
  try {
    const voiceReply = await replyViaVoiceHub(text, sessionId, scope);
    const intentView = voiceReply.intentResolution
      ? viewFromIntentResolution(voiceReply.intentResolution)
      : { shape: 'reply' as const };
    const payload: ConversationMessageResponse = {
      reply: prepareReplyForDelivery(voiceReply.reply, text, voiceReply.intentResolution),
      mode: 'voice-hub',
      ...intentView,
      ...(voiceReply.intentResolution ? { intentResolution: voiceReply.intentResolution } : {}),
    };
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    console.warn(
      `[concierge] voice-hub path failed (${error instanceof Error ? error.message : String(error)}); falling back to orchestrator`
    );
  }

  // Degrade to the orchestrator directly (no voice-hub needed).
  try {
    const payload = await replyViaOrchestrator(text, speaker, sessionId, locale, scope);
    return NextResponse.json(payload, { headers: NO_STORE });
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
  return NextResponse.json(unavailable, { status: 503, headers: NO_STORE });
}
