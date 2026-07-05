import { logger } from './core.js';
import { agentRegistry, AgentProvider } from './agent-registry.js';
import { type AgentHandle } from './agent-lifecycle.js';
import {
  getAgentManifest,
  loadAgentManifests,
  resolveAgentSelectionHints,
} from './agent-manifest.js';
import { auditChain } from './audit-chain.js';
import { isA2ATaskContractLike, validateA2ATaskContract } from './a2a-task-contract.js';
import { recordGovernanceAction } from './kill-switch.js';
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
  stopAgentRuntime,
} from './agent-runtime-supervisor.js';
import {
  askAgentRuntimeViaDaemon,
  createSupervisorBackedAgentHandle,
  ensureAgentRuntimeViaDaemon,
  shutdownAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload,
} from './agent-runtime-supervisor-client.js';
import { type TaskModelHint } from './reasoning-model-routing.js';

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
  };
  payload: any;
}

// Shared secret for HMAC signing (set via env or generated per-session)
const A2A_SECRET = process.env.KYBERION_A2A_SECRET || crypto.randomBytes(32).toString('hex');

export function signA2AMessage(message: A2AMessage): string {
  const content = JSON.stringify({
    header: { ...message.header, signature: undefined },
    payload: message.payload,
  });
  return crypto.createHmac('sha256', A2A_SECRET).update(content).digest('hex');
}

export function verifyA2ASignature(message: A2AMessage): boolean {
  if (!message.header.signature) return false;
  const expected = signA2AMessage(message);
  return crypto.timingSafeEqual(
    Buffer.from(message.header.signature, 'hex'),
    Buffer.from(expected, 'hex')
  );
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
const GLOBAL_LIMIT = Number(process.env.KYBERION_GLOBAL_INFLIGHT_LIMIT || 8);
const AGENT_LIMIT = Number(process.env.KYBERION_AGENT_INFLIGHT_LIMIT || 2);

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
    this.validateSender(envelope.header.sender);

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

    // Parse receiver
    const { agentId, provider } = this.parseReceiver(receiver);
    const correlationId = this.resolveCorrelationId(envelope);
    const taskModelHint = this.extractTaskModelHint(envelope.payload);
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

    // Extract prompt from payload
    let prompt = this.buildPromptFromPayload(envelope.payload);
    let rehydrated = false;

    const conversationId = envelope.header.conversation_id;
    const missionId =
      typeof envelope.payload?.context?.mission_id === 'string'
        ? String(envelope.payload.context.mission_id).toUpperCase()
        : undefined;

    if (conversationId) {
      const history = readConversationHistory(conversationId);
      if (history && history.length > 0) {
        const lastTurn = history[history.length - 1];
        const currentSessionId =
          typeof handle?.getRecord === 'function' ? handle.getRecord()?.sessionId || null : null;
        if (
          lastTurn.provider_session_id &&
          currentSessionId &&
          lastTurn.provider_session_id !== currentSessionId
        ) {
          const rehydrationPrefix = rehydrateConversation(conversationId);
          if (rehydrationPrefix) {
            prompt = rehydrationPrefix + prompt;
            rehydrated = true;
            logger.info(
              `[A2A_BRIDGE] Rehydrating conversation ${conversationId} due to session change from ${lastTurn.provider_session_id} to ${currentSessionId}`
            );
          }
        }
      }

      await appendConversationTurn(conversationId, {
        sender: envelope.header.sender,
        receiver: agentId,
        performative: envelope.header.performative,
        prompt,
        missionId,
      });
    }

    logger.info(`[A2A_BRIDGE] Routing to ${agentId}: "${prompt.slice(0, 80)}..."`);

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
        prompt_excerpt: prompt.slice(0, 240),
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
      },
    });
    recordGovernanceAction(envelope.header.sender, 'a2a_route', agentId, false);

    // Ask the agent
    let responseText: string;
    try {
      try {
        const result = await askAgentRuntimeViaDaemon({
          agentId,
          prompt,
          requestedBy: 'a2a_bridge',
          correlationId,
          ...(taskModelHint ? { taskModelHint } : {}),
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
          const rehydrationPrefix = conversationId ? rehydrateConversation(conversationId) : '';
          const retriedPrompt = rehydrationPrefix
            ? rehydrationPrefix + this.buildPromptFromPayload(envelope.payload)
            : prompt;
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
            ...(taskModelHint ? { taskModelHint } : {}),
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
            askAgentRuntime(agentId, prompt, 'a2a_bridge', {
              correlationId,
              ...(taskModelHint ? { taskModelHint } : {}),
            })
          )
        );
      } catch (inProcessErr: any) {
        if (inProcessErr?.name === 'AgentRuntimeCrashedError') {
          logger.warn(
            `[A2A_BRIDGE] Crash detected during in-process ask. Re-ensuring agent and retrying with rehydrated prompt...`
          );
          await this.ensureAgent(agentId, provider, envelope.payload, runtimeContextKey);
          const rehydrationPrefix = conversationId ? rehydrateConversation(conversationId) : '';
          const retriedPrompt = rehydrationPrefix
            ? rehydrationPrefix + this.buildPromptFromPayload(envelope.payload)
            : prompt;
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
        timestamp: new Date().toISOString(),
      },
      payload: {
        text: responseText,
        ...(rehydrated ? { metadata: { rehydrated: true } } : {}),
      },
    };
    response.header.signature = signA2AMessage(response);

    if (conversationId) {
      const providerSessionId =
        typeof handle?.getRecord === 'function'
          ? handle.getRecord()?.sessionId || undefined
          : undefined;
      await appendConversationTurn(conversationId, {
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

    const supervisorHandle = getAgentRuntimeHandle(agentId);
    const existing = supervisorHandle || this.handles.get(agentId);
    if (existing && this.runtimeContexts.get(agentId) === runtimeContextKey) {
      const record = agentRegistry.get(agentId);
      if (record && ['ready', 'busy', 'booting'].includes(record.status)) {
        this.handles.set(agentId, existing);
        return existing;
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

    const { provider: resolvedProvider, modelId: resolvedModelId } = resolveAgentSelectionHints(
      manifest,
      provider
    );
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

  private syncCachedHandle(agentId: string): void {
    const supervisorHandle = getAgentRuntimeHandle(agentId);
    if (!supervisorHandle) {
      this.handles.delete(agentId);
      this.runtimeContexts.delete(agentId);
      return;
    }
    this.handles.set(agentId, supervisorHandle);
  }

  private validateSender(sender: string): void {
    // Allow registered agents
    if (agentRegistry.get(sender)) return;
    // Allow agents with manifests
    if (getAgentManifest(sender)) return;
    // Allow internal senders (chronos-mirror, etc.)
    if (sender.startsWith('kyberion:')) return;

    logger.warn(`[A2A_BRIDGE] Unknown sender: ${sender}`);
    // Don't throw — allow but log (external senders via gateway are valid)
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
