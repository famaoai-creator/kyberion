import { NextRequest, NextResponse } from 'next/server';
import { parseFrontDeskArtifactRevisionInput } from '@agent/core/surface/front-desk-execution-contract';
import {
  runFrontDeskRequest,
  type FrontDeskRequestOutcome,
} from '@agent/core/surface/front-desk-request-service';
import { readFrontDeskRequest } from '@agent/core/surface/front-desk-request-result';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { conversationViewerForSelection } from '../../../lib/selected-tenant';
import { conciergeText, resolveConciergeLocale, type ConciergeLocale } from '../../../lib/i18n';
import { CONVERSATION_MAX_INPUT } from '../../../lib/conversation-history';
import {
  narrowFrontDeskConversationViewer,
  readConversationHistory,
  ConversationStoreError,
} from '@agent/core/surface/front-desk-conversation-store';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

/** Restore only the current server-owned conversation; query IDs never select an owner. */
export function GET(req: NextRequest) {
  const resolved = conversationViewerForSelection(req);
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
  const requestId = req.nextUrl.searchParams.get('requestId');
  if (
    requestId !== null &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)
  ) {
    return NextResponse.json(
      { ok: false, error: 'invalid_request_id' },
      { status: 400, headers: NO_STORE }
    );
  }
  try {
    if (requestId !== null) {
      const result = readFrontDeskRequest(viewer, requestId);
      return result
        ? NextResponse.json(result, { headers: NO_STORE })
        : NextResponse.json(
            { ok: false, error: 'conversation_request_not_found' },
            { status: 404, headers: NO_STORE }
          );
    }
    return NextResponse.json(readConversationHistory(viewer, { readOnly: true }), {
      headers: NO_STORE,
    });
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

/** HTTP status, localized errors, and Web navigation stay at the transport boundary. */
function requestResponse(result: FrontDeskRequestOutcome, locale: ConciergeLocale) {
  if (result.kind === 'rejected') {
    if (result.stage === 'scope') {
      const selectionRequired = result.reason === 'scope_selection_required';
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
    if (result.stage === 'session') {
      return NextResponse.json(
        { ok: false, error: 'conversation_scope_changed', retry_safe: true },
        { status: 409, headers: NO_STORE }
      );
    }
    const revisionError = [
      'revision_conflict',
      'revision_target_unavailable',
      'invalid_revision',
    ].includes(result.reason)
      ? result.reason
      : undefined;
    const conflict = result.reason === 'request_conflict' || result.reason === 'request_expired';
    return NextResponse.json(
      {
        ok: false,
        error: revisionError
          ? 'conversation_' + revisionError
          : conflict
            ? 'conversation_request_conflict'
            : conciergeText('api.history_unavailable', locale),
        retry_safe: Boolean(revisionError) || !conflict,
      },
      {
        status: revisionError === 'invalid_revision' ? 400 : revisionError || conflict ? 409 : 503,
        headers: NO_STORE,
      }
    );
  }
  if (result.kind === 'replied') {
    return NextResponse.json(
      { ...result.payload, historySaved: result.historySaved, requestId: result.requestId },
      { headers: NO_STORE }
    );
  }
  if (result.kind === 'replayed') {
    return NextResponse.json(
      {
        reply: result.reply,
        mode: 'history',
        shape: 'reply',
        requestId: result.requestId,
        replayed: true,
      },
      { headers: NO_STORE }
    );
  }
  if (result.kind === 'pending' || (result.kind === 'uncertain' && result.existing)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          result.kind === 'uncertain' ? 'conversation_execution_uncertain' : 'conversation_pending',
        requestId: result.requestId,
        pending: true,
        retry_safe: false,
      },
      { status: 202, headers: NO_STORE }
    );
  }
  if (result.kind === 'not_started') {
    return NextResponse.json(
      {
        ok: false,
        mode: 'unavailable',
        error: 'conversation_not_started',
        reason: result.reason,
        requestId: result.requestId,
        retry_safe: true,
        next_action: { kind: 'retry_same_request' },
      },
      { status: 409, headers: NO_STORE }
    );
  }
  if (result.kind === 'capability_unsupported') {
    return NextResponse.json(
      {
        ok: false,
        mode: 'unavailable',
        error: 'conversation_capability_unsupported',
        capability: result.capability,
        requestId: result.requestId,
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
      requestId: result.requestId,
      retry_safe: false,
      next_action: { kind: 'inspect_setup', href: '/settings' },
    },
    { status: 503, headers: NO_STORE }
  );
}

// Text clients share the authenticated durable partition. A timeout never starts a second execution.
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const resolved = conversationViewerForSelection(req);
  if (resolved.response) return resolved.response;
  let viewer: ReturnType<typeof narrowFrontDeskConversationViewer> = resolved.context;
  const parsedBody = await readRequestObject(req, 'request body', [
    'text',
    'locale',
    'speaker',
    'sessionId',
    'requestId',
    'requestCreatedAt',
    'artifactRevision',
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
  const artifactRevision = parseFrontDeskArtifactRevisionInput(body.artifactRevision);
  if (body.artifactRevision !== undefined && !artifactRevision) {
    return NextResponse.json(
      { ok: false, error: 'conversation_invalid_revision', retry_safe: true },
      { status: 400, headers: NO_STORE }
    );
  }
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
  if (
    body.requestId !== undefined &&
    (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.requestId))
  ) {
    return NextResponse.json(
      { ok: false, error: 'invalid_request_id' },
      { status: 400, headers: NO_STORE }
    );
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
    return NextResponse.json(
      { ok: false, error: 'conversation_scope_changed', retry_safe: true },
      { status: 409, headers: NO_STORE }
    );
  }

  return requestResponse(
    await runFrontDeskRequest(viewer, {
      text,
      locale,
      sessionId: body.sessionId,
      requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
      requestCreatedAt:
        typeof body.requestCreatedAt === 'number' ? body.requestCreatedAt : undefined,
      artifactRevision,
    }),
    locale
  );
}
