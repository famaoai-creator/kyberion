/** Request-only adapter. Other Concierge mutation routes retain their localadmin gate. */
import { NextResponse, type NextRequest } from 'next/server';
import { workspaceConversationViewer } from './workspace-conversation';
import {
  authorizeSurfaceMutation,
  surfaceMutationRequestUrl,
  extractSurfaceBearerToken,
  SurfaceViewerScopeError,
} from '@agent/core/surface/surface-mutation-guard';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import {
  loadHumanRequestRuntimeConfig,
  type HumanRequestRuntimeConfig,
} from '@agent/core/surface/human-request-runtime-config';
import {
  resolveBrowserHumanRequestIdentity,
  authorizeBrowserHumanRequest,
} from '@agent/core/surface/browser-human-request';
import type { FrontDeskConversationViewer } from '@agent/core/surface/front-desk-conversation-store';
import { requireConciergeMutationAccess } from './api-guard';
import {
  conciergeCredential,
  guardConciergeRequest,
  type ConciergeViewerContext,
} from './viewer-context';
import { conversationViewerForSelection } from './selected-tenant';

const NO_STORE = { 'Cache-Control': 'no-store' };
export function humanRequestError(error?: unknown): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'conversation_request_unavailable' },
    {
      status: error instanceof SurfaceViewerScopeError ? 403 : 503,
      headers: NO_STORE,
    }
  );
}
function denied(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'conversation_scope_denied' },
    { status: 403, headers: NO_STORE }
  );
}
type Prepared =
  | { context: ConciergeViewerContext; config: HumanRequestRuntimeConfig; response?: never }
  | { response: NextResponse; context?: never; config?: never };

/** Resolve authentication once on the enabled path; body hints can only narrow it later. */
export function prepareConciergeHumanRequest(req: NextRequest, mutation: boolean): Prepared {
  // Explicit malformed credentials must never silently become cookie authentication.
  const authorization = req.headers.get('authorization');
  if (authorization !== null && !extractSurfaceBearerToken(authorization))
    return { response: denied() };
  let config: HumanRequestRuntimeConfig;
  try {
    config = loadHumanRequestRuntimeConfig();
  } catch (error) {
    return { response: humanRequestError(error) };
  }
  if (config.browser?.enabled !== true) {
    if (mutation) {
      const response = requireConciergeMutationAccess(req);
      if (response) return { response };
    }
    const selected = conversationViewerForSelection(req);
    return selected.response
      ? { response: selected.response }
      : { context: selected.context, config };
  }
  const limited = guardConciergeRequest(req);
  if (limited) return { response: limited };
  const credential = conciergeCredential(req);
  if (mutation) {
    if (
      credential.source === 'session-cookie' &&
      !isSameOriginMutation({
        method: req.method,
        headers: req.headers,
        expectedHost: req.headers.get('host') ?? new URL(req.url).host,
      })
    )
      return { response: denied() };
    const transport = authorizeSurfaceMutation({
      url: surfaceMutationRequestUrl(req),
      getHeader: (name) => req.headers.get(name),
    });
    if (!transport.ok)
      return {
        response: NextResponse.json(
          { ok: false, error: transport.reason },
          { status: transport.status, headers: NO_STORE }
        ),
      };
  }
  const selected = conversationViewerForSelection(req);
  if (selected.response) return { response: selected.response };
  // This only defers the role gate. The verified proof, strict registry, scoped
  // operation permission and mandatory audit must all pass before any effect.
  if (
    mutation &&
    selected.context.principal?.provider !== 'browser-session' &&
    credential.token &&
    selected.context.role !== 'localadmin'
  ) {
    return {
      response: NextResponse.json(
        { ok: false, error: 'Concierge mutation requires a localadmin viewer.' },
        { status: 403, headers: NO_STORE }
      ),
    };
  }
  return { context: selected.context, config };
}

/** Call after selection and input narrowing, immediately before the store/service. */
export function authorizeConciergeHumanRequest(
  selected: ConciergeViewerContext,
  narrowed: FrontDeskConversationViewer,
  config: HumanRequestRuntimeConfig,
  operation: 'receive' | 'result' | 'history',
  requestId?: string
): FrontDeskConversationViewer {
  const identity = resolveBrowserHumanRequestIdentity(
    { ...narrowed, principal: selected.principal },
    config
  );
  if (!identity) return narrowed;
  authorizeBrowserHumanRequest(identity, operation, requestId);
  return narrowed.workspaceOperationId
    ? workspaceConversationViewer(identity.viewer, {
        operationId: narrowed.workspaceOperationId,
        tenant:
          narrowed.tenantSlugs !== 'all' && narrowed.tenantSlugs.length === 1
            ? narrowed.tenantSlugs[0]
            : undefined,
        organizationId:
          narrowed.organizationIds !== 'all' && narrowed.organizationIds.length === 1
            ? narrowed.organizationIds[0]
            : undefined,
      })
    : identity.viewer;
}
