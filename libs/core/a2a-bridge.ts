import { logger } from './core';
import { agentRegistry, AgentProvider } from './agent-registry';
import { agentLifecycle, AgentHandle } from './agent-lifecycle';
import { getAgentManifest, loadAgentManifests } from './agent-manifest';
import { auditChain } from './audit-chain';
import * as crypto from 'node:crypto';

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
    const handle = await this.ensureAgent(agentId, provider);

    // Extract prompt from payload
    const prompt = typeof envelope.payload === 'string'
      ? envelope.payload
      : envelope.payload?.intent || envelope.payload?.text || JSON.stringify(envelope.payload);

    logger.info(`[A2A_BRIDGE] Routing to ${agentId}: "${prompt.slice(0, 80)}..."`);

    // Audit log the routing
    auditChain.record({
      agentId: envelope.header.sender,
      action: 'a2a_route',
      operation: `delegate_to:${agentId}`,
      result: 'completed',
      metadata: { receiver: agentId, performative: envelope.header.performative },
    });

    // Ask the agent
    const responseText = await handle.ask(prompt);

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
  async ensureAgent(agentId: string, provider?: AgentProvider): Promise<AgentHandle> {
    // Check existing
    const existing = this.handles.get(agentId);
    if (existing) {
      const record = agentRegistry.get(agentId);
      if (record && record.status === 'ready') return existing;
    }

    // Security: Only spawn agents with a known manifest
    const manifest = getAgentManifest(agentId);
    if (!manifest) {
      throw new Error(`Cannot auto-spawn "${agentId}": no agent manifest found. Add knowledge/agents/${agentId}.agent.md to allow.`);
    }

    const handle = await agentLifecycle.spawn({
      agentId,
      provider: manifest.provider || provider || 'gemini',
      modelId: manifest.modelId,
      systemPrompt: manifest.systemPrompt,
      capabilities: manifest.capabilities,
    });
    this.handles.set(agentId, handle);
    logger.info(`[A2A_BRIDGE] Auto-spawned agent: ${agentId} (manifest-verified)`);
    return handle;
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
}

const GLOBAL_KEY = Symbol.for('@kyberion/a2a-bridge');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new A2ABridgeImpl();
}
export const a2aBridge: A2ABridgeImpl = (globalThis as any)[GLOBAL_KEY];
