import { logger } from './core.js';

/**
 * Agent SLO / Error Budget System v1.0
 *
 * Tracks service level indicators specific to AI agents:
 * task success rate, cost per task, policy compliance, latency.
 */

export interface SLOConfig {
  taskSuccessRate: { target: number; window: string };
  policyCompliance: { target: number; window: string };
  avgLatencyMs: { target: number; window: string };
}

export type BurnRateStatus = 'healthy' | 'warning' | 'critical' | 'exhausted';

export interface SLORecord {
  agentId: string;
  config: SLOConfig;
  events: { ts: number; good: boolean; latencyMs: number; policyViolation: boolean }[];
  errorBudget: {
    total: number;
    consumed: number;
    remaining: number;
    burnRate: number;
    status: BurnRateStatus;
  };
}

const DEFAULT_SLO: SLOConfig = {
  taskSuccessRate: { target: 0.95, window: '24h' },
  policyCompliance: { target: 1.0, window: '7d' },
  avgLatencyMs: { target: 30000, window: '24h' },
};

class AgentSLOImpl {
  private records: Map<string, SLORecord> = new Map();

  initialize(agentId: string, config?: Partial<SLOConfig>): SLORecord {
    const sloConfig = { ...DEFAULT_SLO, ...config };
    const record: SLORecord = {
      agentId,
      config: sloConfig,
      events: [],
      errorBudget: { total: 1 - sloConfig.taskSuccessRate.target, consumed: 0, remaining: 1 - sloConfig.taskSuccessRate.target, burnRate: 0, status: 'healthy' },
    };
    this.records.set(agentId, record);
    return record;
  }

  recordEvent(agentId: string, good: boolean, latencyMs: number, policyViolation = false): void {
    let record = this.records.get(agentId);
    if (!record) record = this.initialize(agentId);

    record.events.push({ ts: Date.now(), good, latencyMs, policyViolation });

    // Keep events bounded (last 1000)
    if (record.events.length > 1000) record.events = record.events.slice(-1000);

    this.recalculate(record);
  }

  evaluate(agentId: string): SLORecord | undefined {
    const record = this.records.get(agentId);
    if (record) this.recalculate(record);
    return record;
  }

  private recalculate(record: SLORecord): void {
    const now = Date.now();
    const windowMs = 24 * 3600000; // 24h window
    const recent = record.events.filter(e => (now - e.ts) < windowMs);

    if (recent.length === 0) return;

    const successRate = recent.filter(e => e.good).length / recent.length;
    const errorRate = 1 - successRate;
    const budget = record.errorBudget;

    budget.total = 1 - record.config.taskSuccessRate.target;
    budget.consumed = Math.min(budget.total, errorRate);
    budget.remaining = Math.max(0, budget.total - budget.consumed);

    // Burn rate: how fast we're consuming budget (1.0 = normal, >2.0 = alerting)
    budget.burnRate = budget.total > 0 ? budget.consumed / budget.total : 0;

    if (budget.remaining <= 0) budget.status = 'exhausted';
    else if (budget.burnRate >= 10) budget.status = 'critical';
    else if (budget.burnRate >= 2) budget.status = 'warning';
    else budget.status = 'healthy';

    if (budget.status !== 'healthy') {
      logger.warn(`[SLO] ${record.agentId}: budget ${budget.status} (burn=${budget.burnRate.toFixed(1)}x, remaining=${(budget.remaining * 100).toFixed(1)}%)`);
    }
  }

  getAll(): SLORecord[] {
    return Array.from(this.records.values());
  }
}

const GLOBAL_KEY = Symbol.for('@kyberion/agent-slo');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new AgentSLOImpl();
}
export const agentSLO: AgentSLOImpl = (globalThis as any)[GLOBAL_KEY];
