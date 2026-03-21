import { logger } from './core.js';
import { trustEngine } from './trust-engine.js';

/**
 * Agent Registry v1.0
 * Central in-memory store of all known agents in the Kyberion ecosystem.
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
    logger.info(`[AGENT_REGISTRY] Registered: ${record.agentId} (${record.provider}/${record.modelId})`);
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
    if (filter?.status) results = results.filter(r => r.status === filter.status);
    if (filter?.provider) results = results.filter(r => r.provider === filter.provider);
    return results;
  }

  findByThread(threadId: string): AgentRecord | undefined {
    return Array.from(this.agents.values()).find(r => r.threadId === threadId);
  }

  findByCapability(capability: string): AgentRecord[] {
    return Array.from(this.agents.values()).filter(r => r.capabilities.includes(capability));
  }

  getHealthSnapshot(): { total: number; ready: number; busy: number; error: number } {
    const all = Array.from(this.agents.values());
    return {
      total: all.length,
      ready: all.filter(r => r.status === 'ready').length,
      busy: all.filter(r => r.status === 'busy').length,
      error: all.filter(r => r.status === 'error').length,
    };
  }

  private loadTrustScore(agentId: string): number {
    const record = trustEngine.getScore(agentId);
    return record?.score ?? 500;
  }
}

const GLOBAL_KEY = Symbol.for('@kyberion/agent-registry');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new AgentRegistryImpl();
}
export const agentRegistry: AgentRegistryImpl = (globalThis as any)[GLOBAL_KEY];
