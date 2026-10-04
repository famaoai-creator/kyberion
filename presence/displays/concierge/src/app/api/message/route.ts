import { NextRequest, NextResponse } from 'next/server';
import type { SurfaceConversationResult } from '@agent/core/surface/channel-surface';
import type { IntentResolutionContract } from '@agent/core/intent/intent-resolution-contract-parser';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { resolveConciergeViewer } from '../../../lib/viewer-context';
import {
  SurfaceConversationAdmissionError,
  SurfaceConversationCapabilityError,
} from '@agent/core/surface/surface-conversation-runtime-context';
import { conciergeText, resolveConciergeLocale, type ConciergeLocale } from '../../../lib/i18n';
import { CONVERSATION_MAX_INPUT } from '../../../lib/conversation-history';
import {
  reserveConversationTurn,
  markConversationTurnUncertain,
  markConversationTurnNotStarted,
  completedConversationContext,
  frontDeskRuntimeScope,
  narrowFrontDeskConversationViewer,
  completeConversationTurn,
  conversationRef,
  readConversationHistory,
  ConversationStoreError,
} from '../../../lib/conversation-store';
import {
  ConversationMessageResponse,
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
  let viewer: ReturnType<typeof narrowFrontDeskConversationViewer>;
  try {
    viewer = narrowFrontDeskConversationViewer(resolved.context, {
      tenant: req.nextUrl.searchParams.get('tenant'),
      organizationId: req.nextUrl.searchParams.get('organizationId'),
      projectId: req.nextUrl.searchParams.get('projectId'),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'conversation_scope_denied' },
      { status: 403, headers: NO_STORE }
    );
  }
  try {
    return NextResponse.json(readConversationHistory(viewer), { headers: NO_STORE });
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

/** Run one server-scoped text turn through the orchestrator. */
async function replyViaOrchestrator(
  text: string,
  speaker: string,
  sessionId: string | undefined,
  locale: ConciergeLocale,
  scope: import('@agent/core/event-scope').EventScopeInput,
  requestId: string,
  conversationKey: string,
  history: ReturnType<typeof completedConversationContext>
): Promise<ConversationMessageResponse> {
  const [channelSurface, pathResolverModule] = await Promise.all([
    import('@agent/core/surface/channel-surface'),
    import('@agent/core/path-resolver'),
  ]);
  const conversation = await channelSurface.runSurfaceMessageConversation({
    surface: 'presence',
    text,
    locale,
    senderAgentId: 'kyberion:front-desk',
    correlationId: requestId,
    messageId: requestId,
    agentId: 'presence-surface-agent',
    actorId: speaker,
    threadTs: sessionId,
    cwd: pathResolverModule.pathResolver.rootDir(),
    scope,
    conversationKey,
    conversationHistory: history.messages,
    conversationHistoryTruncated: history.truncated,
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
    ...(conversation.conversationRuntime
      ? { conversationRuntime: conversation.conversationRuntime }
      : {}),
    ...view,
    ...(conversation.intentResolution ? { intentResolution: conversation.intentResolution } : {}),
    ...(intentView || {}),
  };
}

// Text clients share the authenticated durable partition. A timeout never starts a second execution.
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  let viewer: ReturnType<typeof narrowFrontDeskConversationViewer> = resolved.context;

  const parsedBody = await readRequestObject(req, 'request body', [
    'text',
    'locale',
    'speaker',
    'sessionId',
    'requestId',
    'requestCreatedAt',
    'tenant',
    'organizationId',
    'projectId',
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
  if (
    ['tenant', 'organizationId', 'projectId'].some(
      (field) => body[field] !== undefined && typeof body[field] !== 'string'
    ) ||
    (body.requestCreatedAt !== undefined &&
      (typeof body.requestCreatedAt !== 'number' || !Number.isFinite(body.requestCreatedAt)))
  ) {
    return NextResponse.json(
      { ok: false, error: 'invalid_conversation_request', retry_safe: true },
      { status: 400, headers: NO_STORE }
    );
  }
  try {
    viewer = narrowFrontDeskConversationViewer(viewer, {
      tenant: typeof body.tenant === 'string' ? body.tenant : undefined,
      organizationId: typeof body.organizationId === 'string' ? body.organizationId : undefined,
      projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'conversation_scope_denied', retry_safe: true },
      { status: 403, headers: NO_STORE }
    );
  }
  let scope: ReturnType<typeof frontDeskRuntimeScope>;
  try {
    scope = frontDeskRuntimeScope(viewer);
  } catch (error) {
    const selectionRequired =
      error instanceof ConversationStoreError && error.code === 'scope_selection_required';
    return NextResponse.json(
      {
        ok: false,
        error: selectionRequired
          ? 'conversation_scope_selection_required'
          : 'conversation_identity_required',
        retry_safe: true,
        ...(selectionRequired
          ? {
              next_action: {
                kind: 'select_scope',
                fields: ['tenant', 'organizationId', 'projectId'],
              },
            }
          : {}),
      },
      { status: selectionRequired ? 409 : 403, headers: NO_STORE }
    );
  }
  if (
    body.requestId !== undefined &&
    (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.requestId))
  ) {
    return NextResponse.json(
      { ok: false, error: 'invalid_request_id' },
      { status: 400, headers: NO_STORE }
    );
  }
  let ref: ReturnType<typeof conversationRef>;
  try {
    ref = conversationRef(viewer);
  } catch {
    return NextResponse.json(
      { ok: false, error: 'conversation_identity_required' },
      { status: 403, headers: NO_STORE }
    );
  }
  const speaker = viewer.principalId!;
  const sessionId = ref.sessionId;
  const durable = body.sessionId !== undefined;
  if (durable && body.sessionId !== sessionId) {
    return NextResponse.json(
      { ok: false, error: 'conversation_scope_changed', retry_safe: true },
      { status: 409, headers: NO_STORE }
    );
  }

  // The voice-hub protocol has no verified thread contract. New durable clients
  // use the orchestrator directly, where this server-owned thread is authoritative.
  {
    let turn: ReturnType<typeof reserveConversationTurn>;
    try {
      turn = reserveConversationTurn(
        viewer,
        text,
        typeof body.requestId === 'string' ? body.requestId : undefined,
        typeof body.requestCreatedAt === 'number' ? body.requestCreatedAt : undefined
      );
    } catch (error) {
      const conflict =
        error instanceof ConversationStoreError &&
        (error.code === 'request_conflict' || error.code === 'request_expired');
      return NextResponse.json(
        {
          ok: false,
          error: conflict
            ? 'conversation_request_conflict'
            : conciergeText('api.history_unavailable', locale),
          retry_safe: !conflict,
        },
        { status: conflict ? 409 : 503, headers: NO_STORE }
      );
    }
    if (!turn.created) {
      return NextResponse.json(
        turn.reply
          ? {
              reply: turn.reply,
              mode: 'history',
              shape: 'reply',
              requestId: turn.id,
              replayed: true,
            }
          : {
              ok: false,
              error: turn.uncertain ? 'conversation_execution_uncertain' : 'conversation_pending',
              requestId: turn.id,
              pending: true,
              retry_safe: false,
            },
        { status: turn.reply ? 200 : 202, headers: NO_STORE }
      );
    }
    let payload: ConversationMessageResponse;
    try {
      const history = completedConversationContext(viewer);
      payload = await replyViaOrchestrator(
        text,
        speaker,
        sessionId,
        locale,
        scope,
        turn.id,
        ref.key,
        history
      );
    } catch (error) {
      if (error instanceof SurfaceConversationAdmissionError) {
        try {
          markConversationTurnNotStarted(viewer, turn.id);
          return NextResponse.json(
            {
              ok: false,
              mode: 'unavailable',
              error: 'conversation_not_started',
              reason: error.code,
              requestId: turn.id,
              retry_safe: true,
              next_action: { kind: 'retry_same_request' },
            },
            { status: 409, headers: NO_STORE }
          );
        } catch {
          // A retry receipt was not persisted; keep this turn non-retryable.
        }
      }
      try {
        markConversationTurnUncertain(viewer, turn.id);
      } catch {
        /* Pending remains non-retryable. */
      }
      if (error instanceof SurfaceConversationCapabilityError) {
        return NextResponse.json(
          {
            ok: false,
            mode: 'unavailable',
            error: 'conversation_capability_unsupported',
            capability: error.capability,
            requestId: turn.id,
            retry_safe: false,
            next_action: { kind: 'continue_direct_conversation' },
          },
          { status: 422, headers: NO_STORE }
        );
      }
      return NextResponse.json(
        {
          ok: false,
          mode: 'unavailable',
          error: 'conversation_execution_uncertain',
          message: conciergeText('dock.history.pending', locale),
          requestId: turn.id,
          retry_safe: false,
          next_action: { kind: 'inspect_setup', href: '/settings' },
        },
        { status: 503, headers: NO_STORE }
      );
    }
    let historySaved = true;
    try {
      completeConversationTurn(viewer, turn.id, payload.reply);
    } catch {
      // Execution may have completed. Return the real reply, never invite a blind retry.
      historySaved = false;
    }
    return NextResponse.json(
      { ...payload, historySaved, requestId: turn.id },
      { headers: NO_STORE }
    );
  }
}
