import { logger } from './core.js';
import { trustEngine } from './trust-engine.js';
import type { EventScope } from './event-scope.js';

/**
 * Agent Registry v1.1
 * Central in-memory store of all known agents in the Kyberion ecosystem.
 *
 * NI-01: this registry is the **runtime-instance cache** of the durable
 * AgentIdentity registry (`agent-identity.ts`). An AgentRecord describes a
 * live (or recently live) runtime; the durable, journal-backed identity —
 * who owns it, its lifecycle status, when it was retired — lives in the
 * agent-identity ledger, referenced from here via `metadata.nhi_id`
 * (stamped at spawn by agent-lifecycle.ts).
 */

export type AgentStatus = 'registered' | 'booting' | 'ready' | 'busy' | 'error' | 'shutdown';
export type AgentProvider = 'gemini' | 'codex' | 'claude' | string;

export interface AgentRecord {
  agentId: string;
  provider: AgentProvider;
  modelId: string;
  status: AgentStatus;
  capabilities: string[];
  trustScore: number;
  sessionId: string | null;
  threadId: string;
  spawnedAt: number;
  lastActivity: number;
  parentAgentId?: string;
  missionId?: string;
  scope?: EventScope;
  metadata?: Record<string, unknown>;
}

class AgentRegistryImpl {
  private agents: Map<string, AgentRecord> = new Map();

  register(input: Omit<AgentRecord, 'spawnedAt' | 'lastActivity' | 'status'>): AgentRecord {
    const now = Date.now();
    const record: AgentRecord = {
      ...input,
      status: 'registered',
      spawnedAt: now,
      lastActivity: now,
      trustScore: input.trustScore ?? this.loadTrustScore(input.agentId),
    };
    this.agents.set(record.agentId, record);
    logger.info(
      `[AGENT_REGISTRY] Registered: ${record.agentId} (${record.provider}/${record.modelId})`
    );
    return record;
  }

  unregister(agentId: string): boolean {
    const deleted = this.agents.delete(agentId);
    if (deleted) logger.info(`[AGENT_REGISTRY] Unregistered: ${agentId}`);
    return deleted;
  }

  get(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  updateStatus(agentId: string, status: AgentStatus): void {
    const record = this.agents.get(agentId);
    if (record) {
      record.status = status;
      record.lastActivity = Date.now();
    }
  }

  updateSessionId(agentId: string, sessionId: string): void {
    const record = this.agents.get(agentId);
    if (record) record.sessionId = sessionId;
  }

  touch(agentId: string): void {
    const record = this.agents.get(agentId);
    if (record) record.lastActivity = Date.now();
  }

  list(filter?: Partial<Pick<AgentRecord, 'status' | 'provider'>>): AgentRecord[] {
    let results = Array.from(this.agents.values());
    if (filter?.status) results = results.filter((r) => r.status === filter.status);
    if (filter?.provider) results = results.filter((r) => r.provider === filter.provider);
    return results;
  }

  findByThread(threadId: string): AgentRecord | undefined {
    return Array.from(this.agents.values()).find((r) => r.threadId === threadId);
  }

  findByCapability(capability: string): AgentRecord[] {
    return Array.from(this.agents.values()).filter((r) => r.capabilities.includes(capability));
  }

  /** NI-01: stamp the durable identity's nhi_id on the runtime record's metadata. */
  attachRuntimeIdentity(agentId: string, nhiId: string): void {
    const record = this.agents.get(agentId);
    if (record) record.metadata = { ...record.metadata, nhi_id: nhiId };
  }

  /** NI-01: the durable identity nhi_id stamped at spawn, if any. */
  getRuntimeIdentity(agentId: string): string | undefined {
    const nhiId = this.agents.get(agentId)?.metadata?.nhi_id;
    return typeof nhiId === 'string' && nhiId ? nhiId : undefined;
  }

  /** NI-01: reverse lookup — runtime records currently bound to a durable identity. */
  findByRuntimeIdentity(nhiId: string): AgentRecord[] {
    return Array.from(this.agents.values()).filter((r) => r.metadata?.nhi_id === nhiId);
  }

  getHealthSnapshot(): { total: number; ready: number; busy: number; error: number } {
    const all = Array.from(this.agents.values());
    return {
      total: all.length,
      ready: all.filter((r) => r.status === 'ready').length,
      busy: all.filter((r) => r.status === 'busy').length,
      error: all.filter((r) => r.status === 'error').length,
    };
  }

  private loadTrustScore(agentId: string): number {
    return resolveAgentTrustScore(agentId);
  }
}

export function resolveAgentTrustScore(agentId: string, fallback = 500): number {
  const record = trustEngine.getScore(agentId);
  return record?.score ?? fallback;
}

const GLOBAL_KEY = Symbol.for('@kyberion/agent-registry');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new AgentRegistryImpl();
}
export const agentRegistry: AgentRegistryImpl = (globalThis as any)[GLOBAL_KEY];
