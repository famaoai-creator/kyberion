import type { SupportedLocale } from '../locale-normalize.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';
import type { FrontDeskArtifactRevisionInput } from './front-desk-artifact-revision-contract.js';
import {
  reserveConversationTurn,
  completedConversationContext,
  frontDeskRuntimeScope,
  conversationRef,
  completeConversationTurn,
  classifyConversationTurnOutcome,
  markConversationTurnNotStarted,
  markConversationTurnUncertain,
  ConversationStoreError,
  type ConversationTurnOutcome,
} from './front-desk-conversation-store.js';
import {
  SurfaceConversationAdmissionError,
  SurfaceConversationCapabilityError,
} from './surface-conversation-runtime-context.js';
import {
  projectFrontDeskConversationReply,
  type FrontDeskRequestReply,
} from './front-desk-request-projection.js';

/** Untrusted request data. No field may select an actor, owner, or authorization scope. */
export interface FrontDeskRequestInput {
  text: string;
  locale?: SupportedLocale;
  requestId?: string;
  requestCreatedAt?: number;
  /** Optional optimistic binding; this never selects a conversation. */
  sessionId?: string;
  artifactRevision?: FrontDeskArtifactRevisionInput;
}

export type FrontDeskRequestRejection =
  ConversationStoreError['code'] | 'scope_changed' | 'history_unavailable';

/** Conversation lifecycle only: a reply never claims generic durable task execution. */
export type FrontDeskRequestOutcome =
  | { kind: 'replied'; requestId: string; payload: FrontDeskRequestReply; historySaved: boolean }
  | { kind: 'replayed'; requestId: string; reply: string }
  | { kind: 'pending'; requestId: string }
  | { kind: 'uncertain'; requestId: string; existing: boolean }
  | {
      kind: 'not_started';
      requestId: string;
      reason: SurfaceConversationAdmissionError['code'];
    }
  | {
      kind: 'capability_unsupported';
      requestId: string;
      capability: SurfaceConversationCapabilityError['capability'];
    }
  | {
      kind: 'rejected';
      stage: 'scope' | 'session' | 'reservation';
      reason: FrontDeskRequestRejection;
    };

/**
 * Execute one front-desk turn for an already authenticated and authorized viewer.
 * The adapter owns mutation authorization and input parsing, and must pass the
 * trusted viewer separately from request data. Scope selections may only narrow
 * that viewer before this call. This service does not authenticate a transport.
 *
 * Reserve before execution, then complete or retain a non-retryable interruption.
 * Only a typed pre-execution admission rejection with a durable not-started
 * receipt permits another attempt. Restoring a reply never restores approval.
 */
export async function runFrontDeskRequest(
  trustedViewer: SurfaceViewerScope,
  input: FrontDeskRequestInput
): Promise<FrontDeskRequestOutcome> {
  // Pin the caller's resolved identity and request across asynchronous execution.
  const viewer: SurfaceViewerScope = {
    ...trustedViewer,
    tenantSlugs: trustedViewer.tenantSlugs === 'all' ? 'all' : [...trustedViewer.tenantSlugs],
    organizationIds:
      trustedViewer.organizationIds === 'all' ? 'all' : [...trustedViewer.organizationIds],
    projectIds: trustedViewer.projectIds === 'all' ? 'all' : [...trustedViewer.projectIds],
    tierAccess: [...trustedViewer.tierAccess],
    ...(trustedViewer.canonicalHuman
      ? { canonicalHuman: { ...trustedViewer.canonicalHuman } }
      : {}),
  };
  const request: FrontDeskRequestInput = { ...input };
  let scope: ReturnType<typeof frontDeskRuntimeScope>;
  let ref: ReturnType<typeof conversationRef>;
  try {
    scope = frontDeskRuntimeScope(viewer);
    ref = conversationRef(viewer);
  } catch (error) {
    return {
      kind: 'rejected',
      stage: 'scope',
      reason:
        error instanceof ConversationStoreError && error.code === 'scope_selection_required'
          ? 'scope_selection_required'
          : 'identity_required',
    };
  }
  if (request.sessionId !== undefined && request.sessionId !== ref.sessionId)
    return { kind: 'rejected', stage: 'session', reason: 'scope_changed' };

  let turn: ReturnType<typeof reserveConversationTurn>;
  try {
    turn = reserveConversationTurn(
      viewer,
      request.text,
      request.requestId,
      request.requestCreatedAt,
      request.locale,
      request.artifactRevision
    );
  } catch (error) {
    return {
      kind: 'rejected',
      stage: 'reservation',
      reason: error instanceof ConversationStoreError ? error.code : 'history_unavailable',
    };
  }
  if (!turn.created) {
    if (turn.reply) return { kind: 'replayed', requestId: turn.id, reply: turn.reply };
    return turn.uncertain
      ? { kind: 'uncertain', requestId: turn.id, existing: true }
      : { kind: 'pending', requestId: turn.id };
  }

  let payload: FrontDeskRequestReply;
  let outcome: ConversationTurnOutcome | undefined;
  try {
    if (turn.routing?.reply) {
      // Intake state is not task execution or an approval grant.
      payload = {
        reply: turn.routing.reply,
        mode: 'intake',
        shape:
          turn.routing.kind === 'clarification'
            ? 'clarification'
            : turn.routing.kind === 'status'
              ? 'status_summary'
              : 'reply',
      };
    } else {
      const history = completedConversationContext(viewer);
      const [channelSurface, pathResolverModule] = await Promise.all([
        import('./channel-surface.js'),
        import('../path-resolver.js'),
      ]);
      const conversation = await channelSurface.runSurfaceMessageConversation({
        surface: 'presence',
        text: request.text,
        locale: request.locale,
        senderAgentId: 'kyberion:front-desk',
        correlationId: turn.id,
        messageId: turn.id,
        agentId: 'presence-surface-agent',
        actorId: viewer.principalId!,
        threadTs: ref.sessionId,
        cwd: pathResolverModule.pathResolver.rootDir(),
        scope,
        conversationKey: ref.key,
        conversationHistory: history.messages,
        conversationHistoryTruncated: history.truncated,
      });
      payload = projectFrontDeskConversationReply(conversation, request.locale);
      outcome = classifyConversationTurnOutcome(conversation);
    }
  } catch (error) {
    if (error instanceof SurfaceConversationAdmissionError) {
      try {
        markConversationTurnNotStarted(viewer, turn.id);
        return { kind: 'not_started', requestId: turn.id, reason: error.code };
      } catch {
        // A retry receipt was not persisted; the turn remains non-retryable.
      }
    }
    try {
      markConversationTurnUncertain(viewer, turn.id);
    } catch {
      // The original pending receipt remains non-retryable.
    }
    if (error instanceof SurfaceConversationCapabilityError)
      return {
        kind: 'capability_unsupported',
        requestId: turn.id,
        capability: error.capability,
      };
    return { kind: 'uncertain', requestId: turn.id, existing: false };
  }

  let historySaved = true;
  try {
    completeConversationTurn(viewer, turn.id, payload.reply, outcome);
  } catch {
    // Return the real reply when completion cannot be saved; never invite retry.
    historySaved = false;
  }
  return { kind: 'replied', payload, historySaved, requestId: turn.id };
}
