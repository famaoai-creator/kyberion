import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { parseFrontDeskArtifactRevisionInput } from '@agent/core/surface/front-desk-execution-contract';
import { listTaskSessions } from '@agent/core/task/task-session';
import { t } from '@agent/core/t';
import { normalizeLocale } from '@agent/core/foundation/locale-normalize';
import { pathResolver } from '@agent/core/path-resolver';
import { createLogger } from '@agent/core/logger';
import { runSurfaceMessageConversation } from '@agent/core/surface/channel-surface';
import { isSimpleGreetingText } from '@agent/core/intent/intent-contract';
import { checkAndRepairSurfaceUxContract } from '@agent/core/surface/surface-ux-contract';
import {
  conversationRef,
  readConversationHistory,
  reserveConversationTurn,
  completeConversationTurn,
  classifyConversationTurnOutcome,
  markConversationTurnUncertain,
  frontDeskRuntimeScope,
  completedConversationContext,
  markConversationTurnNotStarted,
  ConversationStoreError,
  type FrontDeskConversationViewer,
} from '@agent/core/surface/front-desk-conversation-store';
import {
  SurfaceConversationAdmissionError,
  SurfaceConversationCapabilityError,
} from '@agent/core/surface/surface-conversation-runtime-context';
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import { SurfaceViewerScopeError } from '@agent/core/surface/surface-mutation-guard';
import { WorkspaceScopeError } from '@agent/core/surface/workspace-scope';
import { loadStandardIntentCatalog } from '@agent/core/intent/intent-resolution';
import {
  askConversationRequestSchema,
  projectConversationNavigation,
  resolveIntentLabel,
  viewFromIntentResolution,
  type NavigationSession,
} from '@agent/core/surface/ask-view';
import { loadHumanRequestRuntimeConfig } from '@agent/core/surface/human-request-runtime-config';
import { readHearingBody, resolveHearingAccess } from '../../../lib/hearing-access';
import { authorizeConciergeHumanRequest } from '../../../lib/browser-human-request';
import { conversationViewerForSelection } from '../../../lib/selected-tenant';
import { workspaceConversationViewer } from '../../../lib/workspace-conversation';
import { taskSessionVisible } from '../../../lib/progress-server';
import { withCompanyFanoutInvalidation } from '../../../lib/company-fanout-cache';

export const dynamic = 'force-dynamic';

const logger = createLogger('concierge-ask-conversation');
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * 頼む: the shared durable front-desk conversation the ask page talks to
 * (moved from presence-studio `GET/POST /api/conversation`, Kyberion server
 * phase 2). Studio served it to its local admin only; here the installation
 * owner reads it and, same origin, writes it (`lib/hearing-access.ts`). The
 * conversation viewer is the dock's (`/api/message`): the selected company
 * (`conversationViewerForSelection`), narrowed by `workspaceConversationViewer`
 * and the verified-human binding (`authorizeConciergeHumanRequest`), so the
 * dock and this page share one transcript (`conversationRef`). The turn runs
 * through the same orchestrator call the dock's shared front-desk request
 * service makes (`surface: 'presence'`, agent `presence-surface-agent` — the
 * front-desk conversation identity both surfaces use). Bodies,
 * statuses and error codes are Studio's; a refusal of the gate keeps its
 * status (and `Retry-After`) under Studio's code for that request.
 */

/** A selection outside the viewer (or not in the registry): the dock's 403. */
function scopeDenied(error: unknown): boolean {
  return error instanceof SurfaceViewerScopeError || error instanceof WorkspaceScopeError;
}

function setupHref(): string {
  try {
    return resolveSurfaceBrowserUrl('concierge') + '/settings';
  } catch {
    return '/onboarding';
  }
}

function unavailable(locale: NonNullable<ReturnType<typeof normalizeLocale>>, requestId?: string) {
  return {
    ok: false,
    mode: 'unavailable',
    error: 'conversation_execution_uncertain',
    message: t('concierge:dock.history.pending', undefined, locale),
    request_id: requestId,
    retry_safe: false,
    next_action: { kind: 'inspect_setup', href: setupHref() },
  };
}

/** A gate refusal under Studio's code for this request, keeping status and `Retry-After`. */
async function gateRefusal(response: Response, code: string, withSetup: boolean) {
  const original = (await response
    .clone()
    .json()
    .catch(() => null)) as { error_code?: unknown } | null;
  const refused = NextResponse.json(
    {
      ok: false,
      error: code,
      ...(typeof original?.error_code === 'string' ? { error_code: original.error_code } : {}),
      retry_safe: true,
      ...(withSetup ? { next_action: { kind: 'inspect_setup', href: setupHref() } } : {}),
    },
    { status: response.status, headers: NO_STORE }
  );
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) refused.headers.set('Retry-After', retryAfter);
  return refused;
}

/** The dock's conversation viewer for this request and selection (throws on a denied scope). */
function conversationViewer(
  req: NextRequest,
  selection: { tenant?: string; organizationId?: string; projectId?: string },
  operation: 'receive' | 'history',
  requestId?: string
): { viewer: FrontDeskConversationViewer; response?: never } | { response: Response } {
  const selected = conversationViewerForSelection(req);
  if (selected.response) return { response: selected.response };
  const config = loadHumanRequestRuntimeConfig();
  const narrowed = workspaceConversationViewer(selected.context, selection);
  return {
    viewer: authorizeConciergeHumanRequest(
      selected.context,
      narrowed,
      config,
      operation,
      requestId
    ),
  };
}

function historyWithNavigation(viewer: FrontDeskConversationViewer) {
  const history = readConversationHistory(viewer, { readOnly: true });
  let sessions: NavigationSession[] = [];
  try {
    sessions = listTaskSessions('presence').filter((session) =>
      taskSessionVisible(viewer, session)
    );
  } catch {
    // Optional navigation evidence must never break history or imply no work started.
  }
  return projectConversationNavigation(history, sessions);
}

function queryValue(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined;
}

export async function GET(req: NextRequest) {
  const access = resolveHearingAccess(req, 'owner-read', 'conversation.read', { narrow: false });
  if (access.response)
    return gateRefusal(access.response, 'conversation_history_unavailable', true);
  try {
    const resolved = conversationViewer(
      req,
      {
        tenant: queryValue(req, 'tenant'),
        organizationId: queryValue(req, 'organizationId'),
        projectId: queryValue(req, 'projectId'),
      },
      'history'
    );
    if (resolved.response)
      return gateRefusal(resolved.response, 'conversation_history_unavailable', true);
    const viewer = resolved.viewer;
    return NextResponse.json(
      {
        ok: true,
        ...historyWithNavigation(viewer),
        next_action: { kind: 'inspect_setup', href: setupHref() },
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    const status = scopeDenied(error) ? 403 : 503;
    return NextResponse.json(
      {
        ok: false,
        error: 'conversation_history_unavailable',
        retry_safe: true,
        next_action: { kind: 'inspect_setup', href: setupHref() },
      },
      { status, headers: NO_STORE }
    );
  }
}

async function handlePost(req: NextRequest) {
  const access = resolveHearingAccess(req, 'write', 'conversation.turn', { narrow: false });
  if (access.response) return gateRefusal(access.response, 'conversation_access_denied', false);
  const read = await readHearingBody(req);
  const parsed = askConversationRequestSchema.safeParse(read.invalid ? null : read.body);
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, error: 'invalid_conversation_request', retry_safe: true },
      { status: 400, headers: NO_STORE }
    );
  const { text, tenant } = parsed.data;
  const artifactRevision = parseFrontDeskArtifactRevisionInput(parsed.data.artifactRevision);
  if (parsed.data.artifactRevision !== undefined && !artifactRevision)
    return NextResponse.json(
      { ok: false, error: 'conversation_invalid_revision', retry_safe: true },
      { status: 400, headers: NO_STORE }
    );
  const locale = normalizeLocale(parsed.data.locale) ?? 'en';
  let viewer: FrontDeskConversationViewer;
  try {
    const resolved = conversationViewer(
      req,
      { tenant, organizationId: parsed.data.organizationId, projectId: parsed.data.projectId },
      'receive',
      parsed.data.request_id
    );
    if (resolved.response)
      return gateRefusal(resolved.response, 'conversation_access_denied', false);
    viewer = resolved.viewer;
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'conversation_access_denied', retry_safe: true },
      {
        status: scopeDenied(error) ? 403 : 503,
        headers: NO_STORE,
      }
    );
  }
  let scope: ReturnType<typeof frontDeskRuntimeScope>;
  try {
    scope = frontDeskRuntimeScope(viewer);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: 'conversation_scope_selection_required',
        retry_safe: true,
        next_action: { kind: 'select_scope', href: setupHref() },
      },
      { status: 409, headers: NO_STORE }
    );
  }
  const ref = conversationRef(viewer);
  if (parsed.data.conversation_id && parsed.data.conversation_id !== ref.sessionId) {
    return NextResponse.json(
      { ok: false, error: 'conversation_scope_changed', retry_safe: true },
      { status: 409, headers: NO_STORE }
    );
  }
  const requestId = parsed.data.request_id ?? randomUUID();
  const navigation = () => {
    try {
      return (
        historyWithNavigation(viewer).messages.find((message) => message.id === requestId + '-user')
          ?.navigation ?? []
      );
    } catch {
      return [];
    }
  };
  let turn: ReturnType<typeof reserveConversationTurn>;
  try {
    turn = reserveConversationTurn(
      viewer,
      text,
      requestId,
      parsed.data.request_created_at,
      locale,
      artifactRevision
    );
  } catch (error) {
    const revisionError =
      error instanceof ConversationStoreError &&
      ['revision_conflict', 'revision_target_unavailable', 'invalid_revision'].includes(error.code)
        ? error.code
        : undefined;
    const conflict =
      error instanceof ConversationStoreError &&
      (error.code === 'request_conflict' || error.code === 'request_expired');
    return NextResponse.json(
      {
        ok: false,
        error: revisionError
          ? 'conversation_' + revisionError
          : conflict
            ? 'conversation_request_conflict'
            : 'conversation_history_unavailable',
        request_id: requestId,
        retry_safe: Boolean(revisionError) || !conflict,
      },
      {
        status: revisionError === 'invalid_revision' ? 400 : revisionError || conflict ? 409 : 503,
        headers: NO_STORE,
      }
    );
  }
  if (!turn.created) {
    // History replay is display-only: never replay approval actions or execute again.
    if (turn.reply)
      return NextResponse.json(
        {
          ok: true,
          reply: turn.reply,
          shape: 'reply',
          mode: 'history',
          replayed: true,
          navigation: navigation(),
          request_id: requestId,
          session_id: ref.sessionId,
        },
        { headers: NO_STORE }
      );
    return NextResponse.json(
      {
        ...unavailable(locale, requestId),
        error: turn.uncertain ? 'conversation_execution_uncertain' : 'conversation_pending',
        pending: true,
      },
      { status: 202, headers: NO_STORE }
    );
  }
  if (turn.routing?.reply) {
    let historySaved = true;
    try {
      completeConversationTurn(viewer, turn.id, turn.routing.reply);
    } catch {
      historySaved = false;
    }
    return NextResponse.json(
      {
        ok: true,
        reply: turn.routing.reply,
        mode: 'intake',
        navigation: navigation(),
        shape:
          turn.routing.kind === 'clarification'
            ? 'clarification'
            : turn.routing.kind === 'status'
              ? 'status_summary'
              : 'reply',
        request_id: requestId,
        session_id: ref.sessionId,
        historySaved,
      },
      { headers: NO_STORE }
    );
  }
  try {
    // No timeout-driven second execution path: a lost reply cannot safely prove
    // that no work started. Durable turns use the shared orchestrator once.
    const context = completedConversationContext(viewer);
    const conversation = await runSurfaceMessageConversation({
      surface: 'presence',
      text,
      locale,
      senderAgentId: 'kyberion:front-desk',
      agentId: 'presence-surface-agent',
      actorId: viewer.principalId!,
      threadTs: ref.sessionId,
      correlationId: requestId,
      messageId: requestId,
      cwd: pathResolver.rootDir(),
      scope,
      conversationKey: ref.key,
      conversationHistory: context.messages,
      conversationHistoryTruncated: context.truncated,
    });
    const rawReply = typeof conversation?.text === 'string' ? conversation.text.trim() : '';
    if (!rawReply) throw new Error('empty conversation reply');
    const contract = conversation.intentResolution;
    const view = contract ? viewFromIntentResolution(contract) : { shape: 'reply' as const };
    const reply = checkAndRepairSurfaceUxContract(rawReply, {
      allow_conversational_reply: isSimpleGreetingText(text),
      approval_required: contract?.authority_level === 'approval_required',
    }).text;
    const intentLabel = contract
      ? resolveIntentLabel(
          contract.normalized_intent,
          new Map(
            loadStandardIntentCatalog()
              .filter((intent): intent is typeof intent & { id: string } => Boolean(intent.id))
              .map((intent) => [intent.id, intent.description ?? ''])
          )
        )
      : undefined;
    let historySaved = true;
    try {
      completeConversationTurn(
        viewer,
        turn.id,
        reply,
        classifyConversationTurnOutcome(conversation)
      );
    } catch {
      historySaved = false;
    }
    return NextResponse.json(
      {
        ok: true,
        reply,
        mode: 'orchestrator',
        shape: view.shape,
        conversation_runtime: conversation.conversationRuntime,
        ...(historySaved && view.nextActions ? { next_actions: view.nextActions } : {}),
        ...(contract ? { intent_resolution: contract } : {}),
        ...(intentLabel
          ? { intent_label: intentLabel.label, intent_label_source: intentLabel.source }
          : {}),
        request_id: requestId,
        session_id: ref.sessionId,
        historySaved,
        navigation: navigation(),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof SurfaceConversationAdmissionError) {
      try {
        markConversationTurnNotStarted(viewer, turn.id);
        return NextResponse.json(
          {
            ok: false,
            error: 'conversation_not_started',
            reason: error.code,
            request_id: requestId,
            retry_safe: true,
          },
          { status: 409, headers: NO_STORE }
        );
      } catch {
        /* A failed receipt write cannot establish safe retry. */
      }
    }
    if (error instanceof SurfaceConversationCapabilityError) {
      try {
        markConversationTurnUncertain(viewer, turn.id);
      } catch {
        /* Preserve pending. */
      }
      return NextResponse.json(
        {
          ok: false,
          mode: 'unavailable',
          error: 'conversation_capability_unsupported',
          capability: error.capability,
          request_id: requestId,
          retry_safe: false,
          next_action: { kind: 'inspect_setup', href: setupHref() },
        },
        { status: 422, headers: NO_STORE }
      );
    }
    logger.warn(
      'POST /api/conversation failed — execution outcome is uncertain | next: inspect setup and progress before another request | evidence: request=' +
        requestId
    );
    try {
      markConversationTurnUncertain(viewer, turn.id);
    } catch {
      /* Keep pending: never imply retry is safe. */
    }
    return NextResponse.json(unavailable(locale, requestId), { status: 503, headers: NO_STORE });
  }
}

/**
 * This route reaches the deliverable inbox through `progress-server` (it only
 * reads task-session visibility there), so it follows the company fan-out
 * boundary: the personal fan-out cache is cleared once a turn settles.
 */
export const POST = withCompanyFanoutInvalidation(handlePost);
