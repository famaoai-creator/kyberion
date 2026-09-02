import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { agentRegistry, AgentProvider } from './agent-registry.js';
import {
  canonicalA2AEnvelopeContent,
  resolveA2ASignatureMode,
  signA2AContent,
  verifyA2AContent,
} from './a2a-envelope-signature.js';
import { enforceNhiActorPolicy } from './nhi-actor-verification.js';
import {
  DelegationAttenuationError,
  parseDelegationChain,
  serializeDelegationChain,
  validateChainAttenuation,
  type DelegationChain,
} from './delegation-chain.js';
import { type AgentHandle } from './agent-lifecycle.js';
import { getAgentManifest, resolveAgentSelectionHints } from './agent-manifest.js';
import { resolveAgentProviderTarget } from './agent-provider-resolution.js';
import { listDemotedProviders } from './provider-health-registry.js';
import { auditChain } from './audit-chain.js';
import { isA2ATaskContractLike, validateA2ATaskContract } from './a2a-task-contract.js';
import { recordGovernanceAction } from './governance-action-recorder.js';
import { registerA2ARoute } from './a2a-route-port.js';
import { emitMissionOrchestrationObservation } from './mission-orchestration-events.js';
import * as crypto from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { ensureAgentRuntimeRoot } from './agent-runtime-root.js';
import {
  appendConversationTurn,
  readConversationHistory,
  rehydrateConversation,
} from './a2a-conversation-store.js';
import { Semaphore } from './semaphore.js';
import {
  appendSupervisorEvent,
  askAgentRuntime,
  ensureAgentRuntime,
  getAgentRuntimeHandle,
  refreshAgentRuntime,
  stopAgentRuntime,
} from './agent-runtime-supervisor.js';
import {
  askAgentRuntimeViaDaemon,
  createSupervisorBackedAgentHandle,
  ensureAgentRuntimeViaDaemon,
  refreshAgentRuntimeViaDaemon,
  shutdownAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload,
} from './agent-runtime-supervisor-client.js';
import { normalizeAgentContextMode, type AgentContextMode } from './context-boundary.js';
import { type TaskModelHint } from './reasoning-model-routing.js';
import {
  validateContextSecurityScope,
  validateReasoningEgress,
  type ContextSecurityScope,
} from './context-security-scope.js';

/**
 * A2A-to-ACP Bridge v1.1 [SECURITY HARDENED]
 * Routes A2A envelope messages to the correct agent's ACP session.
 *
 * Security:
 * - HMAC signature validation on incoming messages
 * - Whitelist-only agent spawning (must have .agent.md manifest)
 * - Sender validation against registered agents
 * - All routing decisions are audit-logged
 */

export interface A2AMessage {
  a2a_version: string;
  header: {
    msg_id: string;
    parent_id?: string;
    sender: string;
    receiver?: string;
    conversation_id?: string;
    correlation_id?: string;
    performative: 'request' | 'propose' | 'inform' | 'accept' | 'reject' | 'query' | 'result';
    timestamp?: string;
    signature?: string;
    sig_alg?: string;
    /**
     * NI-02 sender identity claim: the canonical NHI id
     * (`kyberion://agent/<org>/<slug>`, agent-identity.ts) of the sending
     * agent. Part of the HMAC-signed content (the whole header is signed —
     * see canonicalA2AEnvelopeContent), so within AA-03's same-host
     * integrity boundary the claim cannot be altered without breaking the
     * signature. Optional: legacy envelopes without it still verify.
     * Per-agent keys (a claim *proof* rather than a tamper-evident claim)
     * remain E4's public-key scope.
     */
    sender_nhi_id?: string;
    /**
     * NI-03 delegation-chain claim: the compact-serialized
     * {@link DelegationChain} (root-first `DelegationLink[]` JSON — see
     * delegation-chain.ts) recording who delegated the work this envelope
     * carries. Like `sender_nhi_id`, it sits inside the HMAC-signed content
     * (the whole header is signed), so within AA-03's same-host integrity
     * boundary the chain cannot be altered or stripped without breaking the
     * signature. Optional: legacy chain-less envelopes canonicalize (and
     * verify) byte-for-byte as before.
     */
    delegation_chain?: string;
  };
  payload: any;
}

// AA-03: signing/verification delegate to the shared envelope-signature
// module (persistent host-local secret; per-process throwaway keys are gone).
// NI-02: canonicalization moved into that module (canonicalA2AEnvelopeContent)
// so the sender_nhi_id claim's signature coverage is defined next to the HMAC.
function envelopeContent(message: A2AMessage): string {
  return canonicalA2AEnvelopeContent(message);
}

export function signA2AMessage(message: A2AMessage): string {
  return signA2AContent(envelopeContent(message)).signature;
}

export function verifyA2ASignature(message: A2AMessage): boolean {
  return verifyA2AContent(envelopeContent(message), message.header.signature).valid;
}

/**
 * NI-02 verification side of the sender claim: the envelope's
 * `sender_nhi_id`, but only when the envelope carries a valid signature —
 * an unsigned or tampered claim is not exposed. Callers receiving a routed
 * message use this to attribute it to a durable identity.
 */
export function extractVerifiedSenderNhiId(message: A2AMessage): string | undefined {
  const claim = message.header.sender_nhi_id;
  if (!claim) return undefined;
  return verifyA2ASignature(message) ? claim : undefined;
}

/**
 * NI-03 verification side of the delegation-chain claim, mirroring
 * {@link extractVerifiedSenderNhiId}: the parsed chain from the envelope's
 * `delegation_chain` header, but only when the envelope carries a valid
 * signature — an unsigned, tampered, or malformed claim is not exposed.
 */
export function extractVerifiedDelegationChain(message: A2AMessage): DelegationChain | undefined {
  const claim = message.header.delegation_chain;
  if (!claim) return undefined;
  if (!verifyA2ASignature(message)) return undefined;
  return parseDelegationChain(claim) ?? undefined;
}

export class AgentBusyError extends Error {
  public readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 1000) {
    super(message);
    this.name = 'AgentBusyError';
    this.retryAfterMs = retryAfterMs;
  }
}

// In-process fallback semaphores
const GLOBAL_LIMIT = Number(getRegisteredEnvText('KYBERION_GLOBAL_INFLIGHT_LIMIT') || 8);
const AGENT_LIMIT = Number(getRegisteredEnvText('KYBERION_AGENT_INFLIGHT_LIMIT') || 2);

const globalSemaphore = new Semaphore(GLOBAL_LIMIT);
const agentSemaphores = new Map<string, Semaphore>();

function getAgentSemaphore(agentId: string): Semaphore {
  let sem = agentSemaphores.get(agentId);
  if (!sem) {
    sem = new Semaphore(AGENT_LIMIT);
    agentSemaphores.set(agentId, sem);
  }
  return sem;
}

class A2ABridgeImpl {
  private handles: Map<string, AgentHandle> = new Map();
  private responseHandlers: Map<string, ((envelope: A2AMessage) => void)[]> = new Map();
  private knownManifestIds: Set<string> | null = null;
  private runtimeContexts: Map<string, string> = new Map();

  /**
   * Route an A2A envelope to the target agent and return a result envelope.
   */
  async route(envelope: A2AMessage): Promise<A2AMessage> {
    const receiver = envelope.header.receiver;
    if (!receiver) {
      throw new Error('A2A message missing receiver');
    }

    // Security: Validate sender is a known agent (registered or has manifest)
    this.validateSender(envelope.header.sender, envelope.header.correlation_id);

    // AA-03 Task 2: staged signature requirement. warn (default) records
    // unsigned internal traffic in the audit chain; enforce rejects it.
    if (!envelope.header.signature) {
      const mode = resolveA2ASignatureMode();
      auditChain.record({
        agentId: envelope.header.sender,
        action: 'a2a_signature_missing',
        operation: 'route',
        result: mode === 'enforce' ? 'denied' : 'allowed',
        reason: `Unsigned A2A message ${envelope.header.msg_id} (mode: ${mode})`,
        correlationId: envelope.header.correlation_id,
      });
      if (mode === 'enforce') {
        recordGovernanceAction(envelope.header.sender, 'a2a_signature_missing', 'system', true);
        throw new Error(
          'A2A message rejected: unsigned messages are not accepted (KYBERION_A2A_SIGNATURE=enforce)'
        );
      }
    }

    // Security: Validate signature if present (internal messages are signed)
    if (envelope.header.signature) {
      try {
        if (!verifyA2ASignature(envelope)) {
          auditChain.record({
            agentId: envelope.header.sender,
            action: 'a2a_signature_invalid',
            operation: 'route',
            result: 'denied',
            reason: `Invalid signature on message ${envelope.header.msg_id}`,
            correlationId: envelope.header.correlation_id,
          });
          recordGovernanceAction(envelope.header.sender, 'a2a_signature_invalid', 'system', true);
          throw new Error('A2A message signature verification failed');
        }
      } catch (e: any) {
        if (e.message.includes('signature verification')) throw e;
        // Buffer length mismatch etc - treat as invalid
        throw new Error('A2A message signature malformed');
      }
    }

    // NI-02: sender identity claim. When present, the claim is checked
    // against the NI-01 registry through the shared actor-policy seam: warn
    // (default) audits an unregistered/retired/suspended sender identity and
    // allows; KYBERION_NHI_ACTOR=enforce rejects it (typed
    // NhiActorPolicyError + audit event). The claim counts as VERIFIED —
    // and is exposed downstream (audit metadata below,
    // extractVerifiedSenderNhiId for callers) — only when the envelope
    // signature validated above, since the claim is inside the signed content.
    const senderNhiClaim = envelope.header.sender_nhi_id;
    if (senderNhiClaim) {
      enforceNhiActorPolicy(senderNhiClaim, 'a2a-bridge.route.sender_nhi_id');
    }
    const verifiedSenderNhiId =
      senderNhiClaim && envelope.header.signature ? senderNhiClaim : undefined;

    // NI-03: delegation-chain claim. Presence is optional (legacy chain-less
    // envelopes route unchanged), but a PRESENT chain is validated before any
    // dispatch: a malformed serialization or an attenuation violation (a
    // child link granted more than its parent) is a bug, not a policy
    // choice, and fails closed regardless of KYBERION_* modes. Like the
    // sender claim, the chain counts as VERIFIED (exposed via
    // extractVerifiedDelegationChain / audit metadata) only when the
    // envelope signature validated, since it is inside the signed content.
    const delegationChainClaim = envelope.header.delegation_chain;
    let routedDelegationChain: DelegationChain | undefined;
    if (delegationChainClaim !== undefined) {
      const parsedChain = parseDelegationChain(delegationChainClaim);
      if (!parsedChain) {
        auditChain.record({
          agentId: envelope.header.sender,
          action: 'a2a_delegation_chain_invalid',
          operation: 'route',
          result: 'denied',
          reason: `Malformed delegation_chain header on message ${envelope.header.msg_id}`,
          correlationId: envelope.header.correlation_id,
        });
        recordGovernanceAction(
          envelope.header.sender,
          'a2a_delegation_chain_invalid',
          'system',
          true
        );
        throw new DelegationAttenuationError([
          `malformed delegation_chain header on message ${envelope.header.msg_id}`,
        ]);
      }
      const attenuation = validateChainAttenuation(parsedChain);
      if (!attenuation.ok) {
        auditChain.record({
          agentId: envelope.header.sender,
          action: 'a2a_delegation_attenuation_violation',
          operation: 'route',
          result: 'denied',
          reason: `Delegation attenuation violation on message ${envelope.header.msg_id}: ${attenuation.violations.join('; ')}`,
          correlationId: envelope.header.correlation_id,
        });
        recordGovernanceAction(
          envelope.header.sender,
          'a2a_delegation_attenuation_violation',
          'system',
          true
        );
        throw new DelegationAttenuationError(attenuation.violations);
      }
      routedDelegationChain = parsedChain;
    }
    const verifiedDelegationChain =
      routedDelegationChain && envelope.header.signature ? routedDelegationChain : undefined;

    // Parse receiver
    const { agentId, provider: receiverProvider } = this.parseReceiver(receiver);
    const payloadProvider = this.extractProvider(envelope.payload);
    const provider = payloadProvider || receiverProvider;
    const securityScope = this.extractSecurityScope(envelope.payload);
    if (securityScope) {
      const scopeErrors = validateContextSecurityScope(securityScope);
      if (scopeErrors.length > 0) {
        throw new Error(`[A2A_SCOPE_INVALID] ${scopeErrors.join('; ')}`);
      }
      if (provider) {
        const egress = validateReasoningEgress(securityScope, provider);
        if (!egress.allowed) throw new Error(egress.reason);
      }
    }
    const correlationId = this.resolveCorrelationId(envelope);
    const taskModelHint = this.extractTaskModelHint(envelope.payload);
    const dispatchTimeoutMs = this.extractDispatchTimeoutMs(envelope.payload);
    const taskContractValidation = this.validateTaskContractPayload(envelope.payload);
    if (!taskContractValidation.valid) {
      auditChain.record({
        agentId: envelope.header.sender,
        action: 'a2a_task_contract_invalid',
        operation: 'route',
        result: 'denied',
        reason: `Invalid A2A task contract on message ${envelope.header.msg_id}: ${taskContractValidation.errors.join('; ')}`,
      });
      recordGovernanceAction(envelope.header.sender, 'a2a_task_contract_invalid', 'system', true);
      throw new Error(
        `A2A task contract validation failed: ${taskContractValidation.errors.join('; ')}`
      );
    }

    // Security: Only spawn agents that have a manifest (whitelist)
    const runtimeContextKey = this.getRuntimeContextKey(envelope.payload);
    const handle = await this.ensureAgent(agentId, provider, envelope.payload, runtimeContextKey);
    const conversationId = envelope.header.conversation_id;
    const contextMode = this.extractContextMode(envelope.payload, Boolean(conversationId));
    if (contextMode === 'fresh') {
      await this.resetAgentContext(agentId);
    }

    // Extract prompt from payload
    const rawPrompt = this.buildPromptFromPayload(envelope.payload);
    let runtimePrompt = rawPrompt;
    let rehydrated = false;

    const storageConversationId = conversationId
      ? this.scopeConversationId(conversationId, securityScope)
      : undefined;
    const missionId =
      typeof envelope.payload?.context?.mission_id === 'string'
        ? String(envelope.payload.context.mission_id).toUpperCase()
        : undefined;

    if (storageConversationId) {
      const history = readConversationHistory(storageConversationId);
      if (contextMode !== 'fresh' && history && history.length > 0) {
        const lastTurn = history[history.length - 1];
        const currentSessionId =
          typeof handle?.getRecord === 'function' ? handle.getRecord()?.sessionId || null : null;
        if (
          lastTurn.provider_session_id &&
          currentSessionId &&
          lastTurn.provider_session_id !== currentSessionId
        ) {
          const rehydrationPrefix = rehydrateConversation(storageConversationId);
          if (rehydrationPrefix) {
            runtimePrompt = rehydrationPrefix + rawPrompt;
            rehydrated = true;
            logger.info(
              `[A2A_BRIDGE] Rehydrating conversation ${conversationId} due to session change from ${lastTurn.provider_session_id} to ${currentSessionId}`
            );
          }
        }
      }

      await appendConversationTurn(storageConversationId, {
        sender: envelope.header.sender,
        receiver: agentId,
        performative: envelope.header.performative,
        prompt: rawPrompt,
        missionId,
      });
    }

    logger.info(`[A2A_BRIDGE] Routing to ${agentId}: "${runtimePrompt.slice(0, 80)}..."`);

    try {
      emitMissionOrchestrationObservation({
        decision: 'a2a_message_routed',
        mission_id: missionId,
        requested_by: envelope.header.sender,
        agent_id: agentId,
        sender: envelope.header.sender,
        receiver: agentId,
        team_role:
          typeof envelope.payload?.context?.team_role === 'string'
            ? String(envelope.payload.context.team_role)
            : undefined,
        channel:
          typeof envelope.payload?.context?.channel === 'string'
            ? String(envelope.payload.context.channel)
            : undefined,
        thread:
          typeof envelope.payload?.context?.thread === 'string'
            ? String(envelope.payload.context.thread)
            : undefined,
        correlation_id: correlationId,
        performative: envelope.header.performative,
        intent:
          typeof envelope.payload?.intent === 'string'
            ? String(envelope.payload.intent)
            : undefined,
        prompt_excerpt: runtimePrompt.slice(0, 240),
      });
    } catch (error: any) {
      logger.warn(
        `[A2A_BRIDGE] Failed to record orchestration observation: ${error?.message || error}`
      );
    }

    // Audit log the routing
    auditChain.record({
      agentId: envelope.header.sender,
      action: 'a2a_route',
      operation: `delegate_to:${agentId}`,
      result: 'completed',
      metadata: {
        receiver: agentId,
        performative: envelope.header.performative,
        correlation_id: correlationId,
        // NI-02: durable identity attribution for the routed message, only
        // when the claim was covered by a valid signature.
        ...(verifiedSenderNhiId ? { sender_nhi_id: verifiedSenderNhiId } : {}),
        // NI-03: delegation attribution (root principal + chain depth), only
        // when the chain claim was covered by a valid signature.
        ...(verifiedDelegationChain && verifiedDelegationChain.length > 0
          ? {
              delegation_root_actor: verifiedDelegationChain[0].actor,
              delegation_chain_length: verifiedDelegationChain.length,
            }
          : {}),
      },
    });
    recordGovernanceAction(envelope.header.sender, 'a2a_route', agentId, false);

    // Ask the agent
    let responseText: string;
    try {
      try {
        const result = await askAgentRuntimeViaDaemon({
          agentId,
          prompt: runtimePrompt,
          requestedBy: 'a2a_bridge',
          correlationId,
          ...(dispatchTimeoutMs ? { timeoutMs: dispatchTimeoutMs } : {}),
          ...(taskModelHint ? { taskModelHint } : {}),
          ...(missionId ? { missionId } : {}),
        });
        responseText = result.text;
      } catch (err: any) {
        if (err?.errorDetail?.type === 'busy') {
          throw new AgentBusyError(err.message, err.errorDetail.retry_after_ms);
        }
        if (err?.name === 'AgentRuntimeCrashedError') {
          logger.warn(
            `[A2A_BRIDGE] Crash detected during ask. Re-ensuring agent and retrying with rehydrated prompt...`
          );
          await this.ensureAgent(agentId, provider, envelope.payload, runtimeContextKey);
          const rehydrationPrefix = storageConversationId
            ? rehydrateConversation(storageConversationId)
            : '';
          const retriedPrompt = rehydrationPrefix ? rehydrationPrefix + rawPrompt : runtimePrompt;
          rehydrated = true;

          appendSupervisorEvent({
            decision: 'a2a_conversation_rehydrated',
            conversation_id: conversationId || 'NONE',
            agent_id: agentId,
            mission_id: missionId || 'NONE',
          });

          const result = await askAgentRuntimeViaDaemon({
            agentId,
            prompt: retriedPrompt,
            requestedBy: 'a2a_bridge',
            correlationId,
            ...(dispatchTimeoutMs ? { timeoutMs: dispatchTimeoutMs } : {}),
            ...(taskModelHint ? { taskModelHint } : {}),
            ...(missionId ? { missionId } : {}),
          });
          responseText = result.text;
        } else {
          throw err;
        }
      }
    } catch (daemonErr: any) {
      if (daemonErr instanceof AgentBusyError) throw daemonErr;

      // Fallback in-process route with Semaphore limits
      const agentSem = getAgentSemaphore(agentId);
      if (
        globalSemaphore.getActiveCount() >= GLOBAL_LIMIT ||
        agentSem.getActiveCount() >= AGENT_LIMIT
      ) {
        throw new AgentBusyError(
          `In-process capacity exceeded for ${agentId}. Global: ${globalSemaphore.getActiveCount()}/${GLOBAL_LIMIT}, Agent: ${agentSem.getActiveCount()}/${AGENT_LIMIT}`
        );
      }

      try {
        responseText = await globalSemaphore.run(() =>
          agentSem.run(() =>
            askAgentRuntime(agentId, runtimePrompt, 'a2a_bridge', {
              correlationId,
              ...(taskModelHint ? { taskModelHint } : {}),
              ...(missionId ? { missionId } : {}),
            })
          )
        );
      } catch (inProcessErr: any) {
        if (inProcessErr?.name === 'AgentRuntimeCrashedError') {
          logger.warn(
            `[A2A_BRIDGE] Crash detected during in-process ask. Re-ensuring agent and retrying with rehydrated prompt...`
          );
          await this.ensureAgent(agentId, provider, envelope.payload, runtimeContextKey);
          const rehydrationPrefix = storageConversationId
            ? rehydrateConversation(storageConversationId)
            : '';
          const retriedPrompt = rehydrationPrefix ? rehydrationPrefix + rawPrompt : runtimePrompt;
          rehydrated = true;

          appendSupervisorEvent({
            decision: 'a2a_conversation_rehydrated',
            conversation_id: conversationId || 'NONE',
            agent_id: agentId,
            mission_id: missionId || 'NONE',
          });

          responseText = await globalSemaphore.run(() =>
            agentSem.run(() =>
              askAgentRuntime(agentId, retriedPrompt, 'a2a_bridge', {
                correlationId,
                ...(taskModelHint ? { taskModelHint } : {}),
                ...(missionId ? { missionId } : {}),
              })
            )
          );
        } else {
          throw inProcessErr;
        }
      }
    }

    // Build signed response envelope
    const response: A2AMessage = {
      a2a_version: envelope.a2a_version || '1.0',
      header: {
        msg_id: `RES-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        parent_id: envelope.header.msg_id,
        sender: agentId,
        receiver: envelope.header.sender,
        conversation_id: envelope.header.conversation_id,
        correlation_id: correlationId,
        performative: 'result',
        timestamp: nowIso(),
      },
      payload: {
        text: responseText,
        ...(rehydrated ? { metadata: { rehydrated: true } } : {}),
      },
    };
    // NI-02: stamp the responding agent's durable identity (NI-01 attaches
    // it to the runtime registry record at spawn) BEFORE signing, so the
    // claim is covered by the HMAC. Optional chaining: registry doubles/
    // mocks without the NI-01 accessor simply produce a claim-less envelope.
    const responderNhiId = agentRegistry.getRuntimeIdentity?.(agentId);
    if (responderNhiId) response.header.sender_nhi_id = responderNhiId;
    // NI-03: echo the (already-validated) request chain onto the signed
    // result envelope, so the chain survives the round trip under the
    // response's own HMAC and the caller can attribute the result to the
    // full delegation path.
    if (routedDelegationChain) {
      response.header.delegation_chain = serializeDelegationChain(routedDelegationChain);
    }
    response.header.signature = signA2AMessage(response);
    response.header.sig_alg = 'hmac-sha256';

    if (storageConversationId) {
      const providerSessionId =
        typeof handle?.getRecord === 'function'
          ? handle.getRecord()?.sessionId || undefined
          : undefined;
      await appendConversationTurn(storageConversationId, {
        sender: agentId,
        receiver: envelope.header.sender,
        performative: 'result',
        result: responseText,
        provider_session_id: providerSessionId,
        missionId,
      });
    }

    // Notify handlers
    const handlers = this.responseHandlers.get(envelope.header.sender) || [];
    for (const handler of handlers) {
      try {
        handler(response);
      } catch (err: any) {
        logger.warn(`[A2A_BRIDGE] Response handler failed: ${err?.message || err}`);
      }
    }

    return response;
  }

  onResponse(agentId: string, handler: (envelope: A2AMessage) => void): void {
    const existing = this.responseHandlers.get(agentId) || [];
    existing.push(handler);
    this.responseHandlers.set(agentId, existing);
  }

  /**
   * Auto-spawn an agent ONLY if it has a manifest (whitelist enforcement).
   */
  async ensureAgent(
    agentId: string,
    provider?: AgentProvider,
    payload?: unknown,
    runtimeContextKey = 'default'
  ): Promise<AgentHandle> {
    this.syncCachedHandle(agentId);

    const securityScope = this.extractSecurityScope(payload);
    const runtimeMissionId =
      securityScope?.mission_id ||
      (typeof (payload as any)?.context?.mission_id === 'string'
        ? String((payload as any).context.mission_id)
        : undefined);
    const runtimeScope = securityScope
      ? {
          scope_kind: 'mission' as const,
          tier: securityScope.write_tier,
          ...(securityScope.tenant_slug || securityScope.tenant_id
            ? { tenant_slug: securityScope.tenant_slug || securityScope.tenant_id }
            : {}),
          ...(securityScope.organization_id
            ? { organization_id: securityScope.organization_id }
            : {}),
          ...(securityScope.project_id ? { project_id: securityScope.project_id } : {}),
          mission_id: securityScope.mission_id,
        }
      : undefined;

    const supervisorHandle = getAgentRuntimeHandle(agentId);
    const existing = supervisorHandle || this.handles.get(agentId);
    const requestedProvider = this.extractProvider(payload) || provider;
    const requestedModelId = this.extractProviderModelId(payload);
    const existingHandleRecord =
      existing && typeof existing.getRecord === 'function' ? existing.getRecord() : undefined;
    const existingRecord = existingHandleRecord || agentRegistry.get(agentId);
    const runtimeMatches =
      (!requestedProvider || existingRecord?.provider === requestedProvider) &&
      (!requestedModelId || existingRecord?.modelId === requestedModelId);
    if (existing && this.runtimeContexts.get(agentId) === runtimeContextKey) {
      const record = agentRegistry.get(agentId);
      if (record && ['ready', 'busy', 'booting'].includes(record.status)) {
        // A live runtime on a demoted provider (rate limit / repeated failure)
        // must not be reused — fall through to the recreate path so the spawn
        // below re-resolves the provider dynamically.
        const providerDemoted = listDemotedProviders().includes(record.provider);
        if (!providerDemoted && runtimeMatches) {
          this.handles.set(agentId, existing);
          return existing;
        }
        logger.info(
          `[A2A_BRIDGE] Recreating ${agentId}: ${
            providerDemoted ? `provider ${record.provider} is demoted` : 'runtime target changed'
          }.`
        );
        try {
          await shutdownAgentRuntimeViaDaemon(agentId, 'a2a_bridge');
        } catch (_) {
          await stopAgentRuntime(agentId, 'a2a_bridge');
        }
        this.handles.delete(agentId);
        this.runtimeContexts.delete(agentId);
      }
    }

    if (existing && this.runtimeContexts.get(agentId) !== runtimeContextKey) {
      logger.info(`[A2A_BRIDGE] Recreating ${agentId} for runtime context ${runtimeContextKey}`);
      try {
        await shutdownAgentRuntimeViaDaemon(agentId, 'a2a_bridge');
      } catch (_) {
        await stopAgentRuntime(agentId, 'a2a_bridge');
      }
      this.handles.delete(agentId);
      this.runtimeContexts.delete(agentId);
    }

    // Security: Only spawn agents with a known manifest
    const manifest = getAgentManifest(agentId);
    if (!manifest) {
      recordGovernanceAction(agentId, 'a2a_spawn_denied', 'no_manifest', true);
      throw new Error(
        `Cannot auto-spawn "${agentId}": no agent manifest found. Add knowledge/product/agents/${agentId}.agent.md to allow.`
      );
    }

    const manifestHint = resolveAgentSelectionHints(manifest, provider);
    const hasExplicitRuntimeTarget = Boolean(requestedProvider && requestedModelId);
    const hinted = requestedProvider
      ? {
          provider: requestedProvider,
          modelId: requestedModelId || manifestHint.modelId,
        }
      : manifestHint;
    // Dynamic-selection alignment: run the static hint through the provider
    // resolver so a demoted backend (rate limit reported into the shared
    // provider-health registry) fails over per the profile's strategy instead
    // of being spawned verbatim.
    const dynamicTarget = resolveAgentProviderTarget({
      preferredProvider: hinted.provider,
      preferredModelId: hinted.modelId,
      providerStrategy: hasExplicitRuntimeTarget
        ? 'strict'
        : manifest.selection_hints?.provider_strategy,
      fallbackProviders: manifest.selection_hints?.fallback_providers,
      requiredCapabilities: manifest.capabilities,
    });
    const resolvedProvider = dynamicTarget.provider as AgentProvider;
    // A mission assignment is a concrete provider/model target, not merely a
    // preference hint. Keep the requested model when the provider remains the
    // requested provider; the resolver may still fail over the provider when
    // health policy requires it.
    const resolvedModelId =
      requestedProvider && requestedModelId && resolvedProvider === requestedProvider
        ? requestedModelId
        : dynamicTarget.modelId;
    if (resolvedProvider !== hinted.provider) {
      logger.info(
        `[A2A_BRIDGE] Provider failover for ${agentId}: ${hinted.provider} → ${resolvedProvider} (${dynamicTarget.strategy})`
      );
    }
    const cwd = this.resolveSpawnCwd(
      agentId,
      resolvedProvider,
      manifest.systemPrompt,
      payload,
      runtimeContextKey
    );

    const spawnOptions = {
      agentId,
      provider: resolvedProvider,
      modelId: resolvedModelId,
      ...(runtimeMissionId ? { missionId: runtimeMissionId } : {}),
      ...(runtimeScope ? { scope: runtimeScope } : {}),
      systemPrompt: manifest.systemPrompt,
      capabilities: manifest.capabilities,
      cwd,
      requestedBy: 'a2a_bridge',
      runtimeOwnerId:
        typeof (payload as any)?.context?.mission_id === 'string'
          ? String((payload as any).context.mission_id)
          : agentId,
      runtimeOwnerType:
        typeof (payload as any)?.context?.mission_id === 'string' ? 'mission' : 'agent',
      runtimeMetadata: {
        lease_kind: 'a2a',
        execution_mode: this.extractExecutionMode(payload) || 'default',
        mission_id:
          typeof (payload as any)?.context?.mission_id === 'string'
            ? String((payload as any).context.mission_id)
            : undefined,
        team_role:
          typeof (payload as any)?.context?.team_role === 'string'
            ? String((payload as any).context.team_role)
            : undefined,
        channel:
          typeof (payload as any)?.context?.channel === 'string'
            ? String((payload as any).context.channel)
            : undefined,
        thread:
          typeof (payload as any)?.context?.thread === 'string'
            ? String((payload as any).context.thread)
            : undefined,
        correlation_id:
          typeof (payload as any)?.context?.correlation_id === 'string'
            ? String((payload as any).context.correlation_id)
            : undefined,
        // Mission assignments are concrete runtime targets. Do not run the
        // lifecycle's capability-based provider resolver a second time and
        // silently replace an explicitly assigned provider/model.
        ...(hasExplicitRuntimeTarget
          ? { provider_strategy: 'strict', skip_provider_resolution: true }
          : {}),
        task_model_hint: this.extractTaskModelHint(payload),
        intent:
          typeof (payload as any)?.intent === 'string'
            ? String((payload as any).intent)
            : undefined,
      },
    } as const;
    let handle: AgentHandle;
    try {
      const snapshot = await ensureAgentRuntimeViaDaemon(toSupervisorEnsurePayload(spawnOptions));
      handle = createSupervisorBackedAgentHandle(agentId, 'a2a_bridge', snapshot);
    } catch (_) {
      handle = await ensureAgentRuntime(spawnOptions);
    }
    this.handles.set(agentId, handle);
    this.runtimeContexts.set(agentId, runtimeContextKey);
    logger.info(`[A2A_BRIDGE] Auto-spawned agent: ${agentId} (manifest-verified)`);
    return handle;
  }

  private async resetAgentContext(agentId: string): Promise<void> {
    appendSupervisorEvent({
      decision: 'agent_runtime_context_reset_requested',
      agent_id: agentId,
      requested_by: 'a2a_bridge',
    });
    try {
      await refreshAgentRuntimeViaDaemon(agentId, 'a2a_bridge');
    } catch (_) {
      await refreshAgentRuntime(agentId, 'a2a_bridge');
    }
    appendSupervisorEvent({
      decision: 'agent_runtime_context_reset_completed',
      agent_id: agentId,
      requested_by: 'a2a_bridge',
    });
  }

  private syncCachedHandle(agentId: string): void {
    const supervisorHandle = getAgentRuntimeHandle(agentId);
    if (!supervisorHandle) {
      this.handles.delete(agentId);
      this.runtimeContexts.delete(agentId);
      return;
    }
    this.handles.set(agentId, supervisorHandle);
  }

  private validateSender(sender: string, correlationId?: string): void {
    // Allow registered agents
    if (agentRegistry.get(sender)) return;
    // Allow agents with manifests
    if (getAgentManifest(sender)) return;
    // Allow internal senders (chronos-mirror, etc.)
    if (sender.startsWith('kyberion:')) return;

    // AA-03 Task 2.3: unknown senders are recorded (warn) or rejected
    // (enforce). External gateway senders should be present in the manifest
    // catalog or the kyberion: namespace; anything else is suspicious.
    const mode = resolveA2ASignatureMode();
    logger.warn(`[A2A_BRIDGE] Unknown sender: ${sender} (mode: ${mode})`);
    auditChain.record({
      agentId: sender,
      action: 'a2a_unknown_sender',
      operation: 'route',
      result: mode === 'enforce' ? 'denied' : 'allowed',
      reason: `Sender ${sender} has no registry entry or manifest`,
      correlationId,
    });
    if (mode === 'enforce') {
      recordGovernanceAction(sender, 'a2a_unknown_sender', 'system', true);
      throw new Error(
        `A2A message rejected: unknown sender ${sender} (KYBERION_A2A_SIGNATURE=enforce)`
      );
    }
  }

  private parseReceiver(receiver: string): { agentId: string; provider?: AgentProvider } {
    const parts = receiver.split(':');
    if (parts.length >= 3 && parts[0] === 'kyberion') {
      const provider = parts[2] as AgentProvider;
      const agentId = `${provider}-${parts[1]}`;
      return { agentId, provider };
    }
    return { agentId: receiver };
  }

  private getRuntimeContextKey(payload: unknown): string {
    const executionMode = this.extractExecutionMode(payload);
    return executionMode === 'conversation' ? 'conversation' : 'default';
  }

  private extractExecutionMode(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const context = (payload as Record<string, unknown>).context;
    if (!context || typeof context !== 'object') return undefined;
    const executionMode = (context as Record<string, unknown>).execution_mode;
    return typeof executionMode === 'string' ? executionMode : undefined;
  }

  private extractSecurityScope(payload: unknown): ContextSecurityScope | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const context = (payload as Record<string, unknown>).context;
    if (!context || typeof context !== 'object') return undefined;
    const scope = (context as Record<string, unknown>).security_scope;
    return scope && typeof scope === 'object' ? (scope as ContextSecurityScope) : undefined;
  }

  private scopeConversationId(
    conversationId: string,
    securityScope?: ContextSecurityScope
  ): string {
    if (!securityScope) return conversationId;
    const fingerprint = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          tenant_id: securityScope.tenant_id,
          organization_id: securityScope.organization_id || null,
          project_id: securityScope.project_id || null,
          mission_id: securityScope.mission_id,
          participant_id: securityScope.participant_id || null,
          read_tiers: [...securityScope.read_tiers].sort(),
          write_tier: securityScope.write_tier,
          purpose: securityScope.purpose,
        })
      )
      .digest('hex')
      .slice(0, 16);
    return `${conversationId.slice(0, 110)}.${fingerprint}`;
  }

  private extractTaskModelHint(payload: unknown): TaskModelHint | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    const candidate =
      record.task_model_hint ||
      record.model_hint ||
      (record.context && typeof record.context === 'object'
        ? (record.context as Record<string, unknown>).task_model_hint ||
          (record.context as Record<string, unknown>).model_hint
        : undefined);
    if (!candidate || typeof candidate !== 'object') return undefined;

    const hint = candidate as Record<string, unknown>;
    const modelId = typeof hint.model_id === 'string' ? hint.model_id : undefined;
    const tier = typeof hint.tier === 'string' ? hint.tier : undefined;
    const effort = typeof hint.effort === 'string' ? hint.effort : undefined;
    const routeReason = typeof hint.route_reason === 'string' ? hint.route_reason : undefined;
    if (!modelId || !tier || !effort || !routeReason) return undefined;

    return {
      model_id: modelId,
      tier: tier as TaskModelHint['tier'],
      effort: effort as TaskModelHint['effort'],
      route_reason: routeReason,
    };
  }

  private extractProvider(payload: unknown): AgentProvider | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const context = (payload as Record<string, unknown>).context;
    if (!context || typeof context !== 'object') return undefined;
    const provider = (context as Record<string, unknown>).provider;
    return typeof provider === 'string' && provider.trim()
      ? (provider.trim() as AgentProvider)
      : undefined;
  }

  private extractProviderModelId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const context = (payload as Record<string, unknown>).context;
    if (!context || typeof context !== 'object') return undefined;
    const modelId = (context as Record<string, unknown>).provider_model_id;
    return typeof modelId === 'string' && modelId.trim() ? modelId.trim() : undefined;
  }

  private extractDispatchTimeoutMs(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const context = (payload as Record<string, unknown>).context;
    if (!context || typeof context !== 'object') return undefined;
    const value = (context as Record<string, unknown>).dispatch_timeout_ms;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private extractContextMode(payload: unknown, hasConversation = false): AgentContextMode {
    const fallback: AgentContextMode = hasConversation ? 'continue' : 'fresh';
    if (!payload || typeof payload !== 'object') return fallback;
    const context = (payload as Record<string, unknown>).context;
    if (!context || typeof context !== 'object') return fallback;
    return normalizeAgentContextMode((context as Record<string, unknown>).context_mode, fallback);
  }

  private validateTaskContractPayload(payload: unknown): { valid: boolean; errors: string[] } {
    if (!isA2ATaskContractLike(payload)) {
      return { valid: true, errors: [] };
    }

    const validation = validateA2ATaskContract(payload);
    return {
      valid: validation.valid,
      errors: validation.errors,
    };
  }

  private resolveCorrelationId(envelope: A2AMessage): string {
    const headerCorrelationId = envelope.header.correlation_id;
    if (typeof headerCorrelationId === 'string' && headerCorrelationId.trim()) {
      return headerCorrelationId.trim();
    }
    const payloadCorrelationId = (envelope.payload as any)?.context?.correlation_id;
    if (typeof payloadCorrelationId === 'string' && payloadCorrelationId.trim()) {
      return payloadCorrelationId.trim();
    }
    return crypto.randomUUID();
  }

  private resolveSpawnCwd(
    agentId: string,
    provider: string,
    systemPrompt: string | undefined,
    payload: unknown,
    runtimeContextKey: string
  ): string {
    if (runtimeContextKey !== 'conversation') {
      return pathResolver.rootDir();
    }

    const context =
      payload && typeof payload === 'object'
        ? ((payload as Record<string, unknown>).context as Record<string, unknown> | undefined)
        : undefined;
    const channel = typeof context?.channel === 'string' ? context.channel : 'surface';
    const thread =
      typeof context?.thread === 'string' ? context.thread.replace(/[^\w.-]+/g, '_') : 'default';
    return ensureAgentRuntimeRoot({
      agentId,
      provider,
      mode: 'conversation',
      channel,
      thread,
      systemPrompt,
    });
  }

  private buildPromptFromPayload(payload: unknown): string {
    if (typeof payload === 'string') return payload;
    if (!payload || typeof payload !== 'object') return JSON.stringify(payload);

    const record = payload as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    const intent = typeof record.intent === 'string' ? record.intent.trim() : '';
    const objective = typeof record.objective === 'string' ? record.objective.trim() : '';
    const rationale = typeof record.rationale === 'string' ? record.rationale.trim() : '';
    const acceptanceCriteria = Array.isArray(record.acceptance_criteria)
      ? record.acceptance_criteria
          .filter((entry) => typeof entry === 'string' && entry.trim())
          .map((entry) => entry.trim())
      : [];
    const expectedOutputs = Array.isArray(record.expected_outputs)
      ? record.expected_outputs
          .filter((entry) => typeof entry === 'string' && entry.trim())
          .map((entry) => entry.trim())
      : [];
    const priorDecisions = Array.isArray(record.prior_decisions)
      ? record.prior_decisions
          .filter((entry) => typeof entry === 'string' && entry.trim())
          .map((entry) => entry.trim())
      : [];
    const context =
      record.context && typeof record.context === 'object' ? record.context : undefined;

    if (!intent && !context) {
      return text || JSON.stringify(payload);
    }

    const sections = [
      intent ? `Intent: ${intent}` : '',
      objective ? `Objective: ${objective}` : '',
      context ? `Context:\n${JSON.stringify(context, null, 2)}` : '',
      acceptanceCriteria.length ? `Acceptance criteria:\n- ${acceptanceCriteria.join('\n- ')}` : '',
      expectedOutputs.length ? `Expected outputs:\n- ${expectedOutputs.join('\n- ')}` : '',
      priorDecisions.length ? `Prior decisions:\n- ${priorDecisions.join('\n- ')}` : '',
      rationale ? `Rationale: ${rationale}` : '',
      text ? `Request:\n${text}` : '',
    ].filter(Boolean);

    return sections.join('\n\n');
  }
}

const GLOBAL_KEY = Symbol.for('@kyberion/a2a-bridge');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new A2ABridgeImpl();
}
export const a2aBridge: A2ABridgeImpl = (globalThis as any)[GLOBAL_KEY];

registerA2ARoute((envelope) => a2aBridge.route(envelope));
