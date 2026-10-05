/** Shared durable front-desk conversation. The outer surface guard still owns
 * authentication, CSRF and rate limits; mutations remain loopback-only. */
import type express from 'express';
import { randomUUID } from 'node:crypto';
import { t } from '@agent/core/t';
import { normalizeLocale } from '@agent/core/locale-normalize';
import { pathResolver } from '@agent/core/path-resolver';
import { logger } from '@agent/core/core';
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
  presenceFrontDeskConversationViewer,
  completedConversationContext,
  narrowFrontDeskConversationViewer,
  markConversationTurnNotStarted,
  ConversationStoreError,
} from '@agent/core/surface/front-desk-conversation-store';
import { SurfaceViewerScopeError } from '@agent/core/surface/surface-mutation-guard';
import {
  SurfaceConversationAdmissionError,
  SurfaceConversationCapabilityError,
} from '@agent/core/surface/surface-conversation-runtime-context';
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import { loadStandardIntentCatalog } from '@agent/core/intent/intent-resolution';
import { resolveIntentLabel, viewFromIntentResolution } from './ask-view.js';
import {
  PresenceStudioViewerError,
  resolvePresenceStudioViewerContext,
  requirePresenceStudioLocalAdmin,
  narrowPresenceStudioTenant,
  toFrontDeskViewerScope,
  presenceStudioConversationSchema,
} from './security.js';

function viewerFor(
  req: express.Request,
  tenant?: string,
  organizationId?: string,
  projectId?: string
) {
  const viewer = resolvePresenceStudioViewerContext(req);
  requirePresenceStudioLocalAdmin(viewer);
  return narrowFrontDeskConversationViewer(
    presenceFrontDeskConversationViewer(
      toFrontDeskViewerScope({
        ...viewer,
        tenantSlugs: narrowPresenceStudioTenant(viewer, tenant),
      })
    ),
    { tenant, organizationId, projectId }
  );
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

export function registerConversationRoutes(app: express.Express): void {
  app.get('/api/conversation', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const tenant = typeof req.query.tenant === 'string' ? req.query.tenant : undefined;
      const viewer = viewerFor(
        req,
        tenant,
        typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined,
        typeof req.query.projectId === 'string' ? req.query.projectId : undefined
      );
      return res.json({
        ok: true,
        ...readConversationHistory(viewer),
        next_action: { kind: 'inspect_setup', href: setupHref() },
      });
    } catch (error) {
      const status =
        error instanceof PresenceStudioViewerError
          ? error.status
          : error instanceof SurfaceViewerScopeError
            ? 403
            : 503;
      return res.status(status).json({
        ok: false,
        error: 'conversation_history_unavailable',
        retry_safe: true,
        next_action: { kind: 'inspect_setup', href: setupHref() },
      });
    }
  });

  app.post('/api/conversation', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = presenceStudioConversationSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ ok: false, error: 'invalid_conversation_request', retry_safe: true });
    const { text, tenant } = parsed.data;
    const locale = normalizeLocale(parsed.data.locale) ?? 'en';
    let viewer: ReturnType<typeof viewerFor>;
    try {
      viewer = viewerFor(req, tenant, parsed.data.organizationId, parsed.data.projectId);
    } catch (error) {
      return res
        .status(
          error instanceof PresenceStudioViewerError
            ? error.status
            : error instanceof SurfaceViewerScopeError
              ? 403
              : 503
        )
        .json({ ok: false, error: 'conversation_access_denied', retry_safe: true });
    }
    let scope: ReturnType<typeof frontDeskRuntimeScope>;
    try {
      scope = frontDeskRuntimeScope(viewer);
    } catch {
      return res.status(409).json({
        ok: false,
        error: 'conversation_scope_selection_required',
        retry_safe: true,
        next_action: { kind: 'select_scope', href: setupHref() },
      });
    }
    const ref = conversationRef(viewer);
    if (parsed.data.conversation_id && parsed.data.conversation_id !== ref.sessionId) {
      return res
        .status(409)
        .json({ ok: false, error: 'conversation_scope_changed', retry_safe: true });
    }
    const requestId = parsed.data.request_id ?? randomUUID();
    let turn: ReturnType<typeof reserveConversationTurn>;
    try {
      turn = reserveConversationTurn(
        viewer,
        text,
        requestId,
        parsed.data.request_created_at,
        locale
      );
    } catch (error) {
      const conflict =
        error instanceof ConversationStoreError &&
        (error.code === 'request_conflict' || error.code === 'request_expired');
      return res.status(conflict ? 409 : 503).json({
        ok: false,
        error: conflict ? 'conversation_request_conflict' : 'conversation_history_unavailable',
        request_id: requestId,
        retry_safe: !conflict,
      });
    }
    if (!turn.created) {
      // History replay is display-only: never replay approval actions or execute again.
      if (turn.reply)
        return res.json({
          ok: true,
          reply: turn.reply,
          shape: 'reply',
          mode: 'history',
          replayed: true,
          request_id: requestId,
          session_id: ref.sessionId,
        });
      return res.status(202).json({
        ...unavailable(locale, requestId),
        error: turn.uncertain ? 'conversation_execution_uncertain' : 'conversation_pending',
        pending: true,
      });
    }
    if (turn.routing?.reply) {
      let historySaved = true;
      try {
        completeConversationTurn(viewer, turn.id, turn.routing.reply);
      } catch {
        historySaved = false;
      }
      return res.json({
        ok: true,
        reply: turn.routing.reply,
        mode: 'intake',
        shape:
          turn.routing.kind === 'clarification'
            ? 'clarification'
            : turn.routing.kind === 'status'
              ? 'status_summary'
              : 'reply',
        request_id: requestId,
        session_id: ref.sessionId,
        historySaved,
      });
    }
    try {
      // No timeout-driven second execution path: a lost bridge reply cannot safely
      // prove that no work started. Durable turns use the shared orchestrator once.
      const context = completedConversationContext(viewer);
      const conversation = await runSurfaceMessageConversation({
        surface: 'presence',
        text,
        locale,
        senderAgentId: 'kyberion:front-desk',
        agentId: 'presence-surface-agent',
        actorId: viewer.principalId,
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
      return res.json({
        ok: true,
        reply,
        mode: 'orchestrator',
        shape: view.shape,
        conversation_runtime: conversation.conversationRuntime,
        ...(view.nextActions ? { next_actions: view.nextActions } : {}),
        ...(contract ? { intent_resolution: contract } : {}),
        ...(intentLabel
          ? { intent_label: intentLabel.label, intent_label_source: intentLabel.source }
          : {}),
        request_id: requestId,
        session_id: ref.sessionId,
        historySaved,
        progress_href:
          '/progress?request=' +
          encodeURIComponent(requestId) +
          (tenant ? '&tenant=' + encodeURIComponent(tenant) : '') +
          (parsed.data.organizationId
            ? '&organizationId=' + encodeURIComponent(parsed.data.organizationId)
            : '') +
          (parsed.data.projectId ? '&projectId=' + encodeURIComponent(parsed.data.projectId) : ''),
      });
    } catch (error) {
      if (error instanceof SurfaceConversationAdmissionError) {
        try {
          markConversationTurnNotStarted(viewer, turn.id);
          return res.status(409).json({
            ok: false,
            error: 'conversation_not_started',
            reason: error.code,
            request_id: requestId,
            retry_safe: true,
          });
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
        return res.status(422).json({
          ok: false,
          mode: 'unavailable',
          error: 'conversation_capability_unsupported',
          capability: error.capability,
          request_id: requestId,
          retry_safe: false,
          next_action: { kind: 'inspect_setup', href: setupHref() },
        });
      }
      logger.warn(
        '[presence-studio][ask] conversation failed — execution outcome is uncertain | inspect setup and progress before another request | request=' +
          requestId
      );
      try {
        markConversationTurnUncertain(viewer, turn.id);
      } catch {
        /* Keep pending: never imply retry is safe. */
      }
      return res.status(503).json(unavailable(locale, requestId));
    }
  });
}
