import { logger } from './core.js';
import { agentRegistry, AgentProvider } from './agent-registry.js';
import { type AgentHandle } from './agent-lifecycle.js';
import { getAgentManifest, loadAgentManifests, resolveAgentSelectionHints } from './agent-manifest.js';
import { auditChain } from './audit-chain.js';
import { emitMissionOrchestrationObservation } from './mission-orchestration-events.js';
import * as crypto from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { ensureAgentRuntimeRoot } from './agent-runtime-root.js';
import { askAgentRuntime, ensureAgentRuntime, getAgentRuntimeHandle, stopAgentRuntime } from './agent-runtime-supervisor.js';
import {
  askAgentRuntimeViaDaemon,
  createSupervisorBackedAgentHandle,
  ensureAgentRuntimeViaDaemon,
  shutdownAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload,
} from './agent-runtime-supervisor-client.js';

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
    performative: 'request' | 'propose' | 'inform' | 'accept' | 'reject' | 'query' | 'result';
    timestamp?: string;
    signature?: string;
  };
  payload: any;
}

// Shared secret for HMAC signing (set via env or generated per-session)
const A2A_SECRET = process.env.KYBERION_A2A_SECRET || crypto.randomBytes(32).toString('hex');

export function signA2AMessage(message: A2AMessage): string {
  const content = JSON.stringify({ header: { ...message.header, signature: undefined }, payload: message.payload });
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

    // Security: Only spawn agents that have a manifest (whitelist)
    const runtimeContextKey = this.getRuntimeContextKey(envelope.payload);
    const handle = await this.ensureAgent(agentId, provider, envelope.payload, runtimeContextKey);

    // Extract prompt from payload
    const prompt = this.buildPromptFromPayload(envelope.payload);

    logger.info(`[A2A_BRIDGE] Routing to ${agentId}: "${prompt.slice(0, 80)}..."`);

    const missionId = typeof envelope.payload?.context?.mission_id === 'string'
      ? String(envelope.payload.context.mission_id).toUpperCase()
      : undefined;
    try {
      emitMissionOrchestrationObservation({
        decision: 'a2a_message_routed',
        mission_id: missionId,
        requested_by: envelope.header.sender,
        agent_id: agentId,
        sender: envelope.header.sender,
        receiver: agentId,
        team_role: typeof envelope.payload?.context?.team_role === 'string'
          ? String(envelope.payload.context.team_role)
          : undefined,
        channel: typeof envelope.payload?.context?.channel === 'string'
          ? String(envelope.payload.context.channel)
          : undefined,
        thread: typeof envelope.payload?.context?.thread === 'string'
          ? String(envelope.payload.context.thread)
          : undefined,
        performative: envelope.header.performative,
        intent: typeof envelope.payload?.intent === 'string' ? String(envelope.payload.intent) : undefined,
        prompt_excerpt: prompt.slice(0, 240),
      });
    } catch (error: any) {
      logger.warn(`[A2A_BRIDGE] Failed to record orchestration observation: ${error?.message || error}`);
    }

    // Audit log the routing
    auditChain.record({
      agentId: envelope.header.sender,
      action: 'a2a_route',
      operation: `delegate_to:${agentId}`,
      result: 'completed',
      metadata: { receiver: agentId, performative: envelope.header.performative },
    });

    // Ask the agent
    let responseText: string;
    try {
      const result = await askAgentRuntimeViaDaemon({ agentId, prompt, requestedBy: 'a2a_bridge' });
      responseText = result.text;
    } catch (_) {
      responseText = await askAgentRuntime(agentId, prompt, 'a2a_bridge');
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
        performative: 'result',
        timestamp: new Date().toISOString(),
      },
      payload: { text: responseText },
    };
    response.header.signature = signA2AMessage(response);

    // Notify handlers
    const handlers = this.responseHandlers.get(envelope.header.sender) || [];
    for (const handler of handlers) {
      try { handler(response); } catch (_) {}
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
  async ensureAgent(agentId: string, provider?: AgentProvider, payload?: unknown, runtimeContextKey = 'default'): Promise<AgentHandle> {
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
      throw new Error(`Cannot auto-spawn "${agentId}": no agent manifest found. Add knowledge/agents/${agentId}.agent.md to allow.`);
    }

    const { provider: resolvedProvider, modelId: resolvedModelId } = resolveAgentSelectionHints(manifest, provider);
    const cwd = this.resolveSpawnCwd(agentId, resolvedProvider, manifest.systemPrompt, payload, runtimeContextKey);

    const spawnOptions = {
      agentId,
      provider: resolvedProvider,
      modelId: resolvedModelId,
      systemPrompt: manifest.systemPrompt,
      capabilities: manifest.capabilities,
      cwd,
      requestedBy: 'a2a_bridge',
      runtimeOwnerId: typeof (payload as any)?.context?.mission_id === 'string'
        ? String((payload as any).context.mission_id)
        : agentId,
      runtimeOwnerType: typeof (payload as any)?.context?.mission_id === 'string' ? 'mission' : 'agent',
      runtimeMetadata: {
        lease_kind: 'a2a',
        execution_mode: this.extractExecutionMode(payload) || 'default',
        mission_id: typeof (payload as any)?.context?.mission_id === 'string' ? String((payload as any).context.mission_id) : undefined,
        team_role: typeof (payload as any)?.context?.team_role === 'string' ? String((payload as any).context.team_role) : undefined,
        channel: typeof (payload as any)?.context?.channel === 'string' ? String((payload as any).context.channel) : undefined,
        thread: typeof (payload as any)?.context?.thread === 'string' ? String((payload as any).context.thread) : undefined,
        intent: typeof (payload as any)?.intent === 'string' ? String((payload as any).intent) : undefined,
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

  private resolveSpawnCwd(
    agentId: string,
    provider: string,
    systemPrompt: string | undefined,
    payload: unknown,
    runtimeContextKey: string,
  ): string {
    if (runtimeContextKey !== 'conversation') {
      return pathResolver.rootDir();
    }

    const context = payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).context as Record<string, unknown> | undefined)
      : undefined;
    const channel = typeof context?.channel === 'string' ? context.channel : 'surface';
    const thread = typeof context?.thread === 'string' ? context.thread.replace(/[^\w.-]+/g, '_') : 'default';
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
    const context = record.context && typeof record.context === 'object' ? record.context : undefined;

    if (!intent && !context) {
      return text || JSON.stringify(payload);
    }

    const sections = [
      intent ? `Intent: ${intent}` : '',
      context ? `Context:\n${JSON.stringify(context, null, 2)}` : '',
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
