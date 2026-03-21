import { logger } from './core.js';
import { safeReadFile, safeWriteFile, safeExistsSync } from './secure-io.js';
import * as path from 'node:path';

/**
 * Trust Engine v1.0
 *
 * 5-dimensional trust scoring with decay, propagation, and regime shift detection.
 * Inspired by Microsoft Agent Governance Toolkit (AgentMesh).
 */

export interface TrustDimensions {
  policyCompliance: number;     // 0-200, weight 25%
  securityPosture: number;      // 0-200, weight 25%
  outputQuality: number;        // 0-200, weight 20%
  resourceEfficiency: number;   // 0-200, weight 15%
  collaborationHealth: number;  // 0-200, weight 15%
}

export type TrustTier = 'untrusted' | 'probationary' | 'standard' | 'trusted' | 'verified';

export interface TrustRecord {
  agentId: string;
  score: number;                // 0-1000 composite
  tier: TrustTier;
  dimensions: TrustDimensions;
  lastUpdated: number;
  history: { ts: number; score: number; event: string }[];
}

const WEIGHTS = {
  policyCompliance: 0.25,
  securityPosture: 0.25,
  outputQuality: 0.20,
  resourceEfficiency: 0.15,
  collaborationHealth: 0.15,
};

const TIER_THRESHOLDS: [number, TrustTier][] = [
  [900, 'verified'],
  [700, 'trusted'],
  [500, 'standard'],
  [300, 'probationary'],
  [0, 'untrusted'],
];

const DECAY_RATE_PER_HOUR = 2;
const DECAY_FLOOR = 100;
const PROPAGATION_FACTOR = 0.3;
const PROPAGATION_DEPTH = 2;
const REGIME_SHIFT_THRESHOLD = 0.5;

class TrustEngineImpl {
  private records: Map<string, TrustRecord> = new Map();
  private decayTimer: ReturnType<typeof setInterval> | null = null;

  initialize(agentId: string, initialScore = 500): TrustRecord {
    const dimScore = initialScore / 5;
    const record: TrustRecord = {
      agentId,
      score: initialScore,
      tier: this.computeTier(initialScore),
      dimensions: {
        policyCompliance: dimScore,
        securityPosture: dimScore,
        outputQuality: dimScore,
        resourceEfficiency: dimScore,
        collaborationHealth: dimScore,
      },
      lastUpdated: Date.now(),
      history: [{ ts: Date.now(), score: initialScore, event: 'initialized' }],
    };
    this.records.set(agentId, record);
    return record;
  }

  getScore(agentId: string): TrustRecord | undefined {
    return this.records.get(agentId);
  }

  /**
   * Record a trust event: positive or negative signal for a specific dimension.
   */
  recordEvent(
    agentId: string,
    dimension: keyof TrustDimensions,
    delta: number,
    event: string
  ): TrustRecord {
    let record = this.records.get(agentId);
    if (!record) record = this.initialize(agentId);

    record.dimensions[dimension] = Math.max(0, Math.min(200, record.dimensions[dimension] + delta));
    record.score = this.computeComposite(record.dimensions);
    record.tier = this.computeTier(record.score);
    record.lastUpdated = Date.now();
    record.history.push({ ts: Date.now(), score: record.score, event });

    // Keep history bounded
    if (record.history.length > 100) record.history = record.history.slice(-100);

    logger.info(`[TRUST] ${agentId}: ${event} → ${dimension} ${delta > 0 ? '+' : ''}${delta} → score=${record.score} (${record.tier})`);
    return record;
  }

  /**
   * Apply time-based trust decay to all agents.
   */
  applyDecay(): void {
    for (const record of this.records.values()) {
      if (record.score <= DECAY_FLOOR) continue;

      const hoursSinceUpdate = (Date.now() - record.lastUpdated) / 3600000;
      if (hoursSinceUpdate < 1) continue;

      const decay = Math.floor(hoursSinceUpdate * DECAY_RATE_PER_HOUR);
      if (decay > 0) {
        const newScore = Math.max(DECAY_FLOOR, record.score - decay);
        if (newScore !== record.score) {
          record.score = newScore;
          record.tier = this.computeTier(newScore);
          record.history.push({ ts: Date.now(), score: newScore, event: `decay (-${decay})` });
        }
      }
    }
  }

  /**
   * Propagate trust penalty to neighboring agents (agents in the same mission).
   */
  propagatePenalty(agentId: string, penalty: number, neighborIds: string[], depth = 0): void {
    if (depth >= PROPAGATION_DEPTH) return;

    const factor = Math.pow(PROPAGATION_FACTOR, depth + 1);
    const propagatedPenalty = Math.round(penalty * factor);

    for (const neighborId of neighborIds) {
      if (neighborId === agentId) continue;
      const record = this.records.get(neighborId);
      if (record) {
        record.score = Math.max(DECAY_FLOOR, record.score - propagatedPenalty);
        record.tier = this.computeTier(record.score);
        record.history.push({ ts: Date.now(), score: record.score, event: `propagated penalty from ${agentId} (-${propagatedPenalty})` });
        logger.info(`[TRUST_PROPAGATION] ${neighborId}: -${propagatedPenalty} from ${agentId} (depth ${depth + 1})`);
      }
    }
  }

  /**
   * Detect regime shift: significant behavioral change using simplified KL divergence.
   */
  detectRegimeShift(agentId: string): { shifted: boolean; divergence: number } {
    const record = this.records.get(agentId);
    if (!record || record.history.length < 10) return { shifted: false, divergence: 0 };

    const recent = record.history.slice(-5).map(h => h.score);
    const baseline = record.history.slice(-20, -5).map(h => h.score);

    if (baseline.length < 5) return { shifted: false, divergence: 0 };

    const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const baselineMean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const baselineStd = Math.sqrt(baseline.reduce((s, v) => s + Math.pow(v - baselineMean, 2), 0) / baseline.length) || 1;

    const divergence = Math.abs(recentMean - baselineMean) / baselineStd;

    if (divergence > REGIME_SHIFT_THRESHOLD) {
      logger.warn(`[TRUST_REGIME_SHIFT] ${agentId}: divergence=${divergence.toFixed(2)} (threshold=${REGIME_SHIFT_THRESHOLD})`);
    }

    return { shifted: divergence > REGIME_SHIFT_THRESHOLD, divergence };
  }

  /**
   * Get the execution ring for an agent based on trust score.
   */
  getRing(agentId: string): 0 | 1 | 2 | 3 {
    const record = this.records.get(agentId);
    const score = record?.score ?? 500;
    if (score >= 950) return 0;
    if (score >= 700) return 1;
    if (score >= 500) return 2;
    return 3;
  }

  startDecayTimer(intervalMs = 3600000): void {
    if (this.decayTimer) return;
    this.decayTimer = setInterval(() => this.applyDecay(), intervalMs);
    this.decayTimer.unref?.();
  }

  stopDecayTimer(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
  }

  /** Persist trust records to disk */
  persist(rootDir?: string): void {
    const root = rootDir || findProjectRoot();
    const filePath = path.join(root, 'knowledge', 'personal', 'governance', 'agent-trust-scores.json');
    const data: Record<string, any> = {};
    for (const [id, record] of this.records) {
      data[id] = {
        current_score: record.score,
        tier: record.tier,
        dimensions: record.dimensions,
        last_updated: new Date(record.lastUpdated).toISOString(),
      };
    }
    try {
      safeWriteFile(filePath, JSON.stringify(data, null, 2));
    } catch (_) {}
  }

  /** Load persisted trust records */
  loadPersisted(rootDir?: string): void {
    const root = rootDir || findProjectRoot();
    const filePath = path.join(root, 'knowledge', 'personal', 'governance', 'agent-trust-scores.json');
    if (!safeExistsSync(filePath)) return;
    try {
      const data = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
      for (const [agentId, entry] of Object.entries(data as Record<string, any>)) {
        this.records.set(agentId, {
          agentId,
          score: entry.current_score ?? 500,
          tier: this.computeTier(entry.current_score ?? 500),
          dimensions: entry.dimensions ?? { policyCompliance: 100, securityPosture: 100, outputQuality: 100, resourceEfficiency: 100, collaborationHealth: 100 },
          lastUpdated: entry.last_updated ? new Date(entry.last_updated).getTime() : Date.now(),
          history: [],
        });
      }
      logger.info(`[TRUST] Loaded ${this.records.size} persisted trust records`);
    } catch (_) {}
  }

  getAll(): TrustRecord[] {
    return Array.from(this.records.values());
  }

  private computeComposite(dim: TrustDimensions): number {
    return Math.round(
      dim.policyCompliance * WEIGHTS.policyCompliance +
      dim.securityPosture * WEIGHTS.securityPosture +
      dim.outputQuality * WEIGHTS.outputQuality +
      dim.resourceEfficiency * WEIGHTS.resourceEfficiency +
      dim.collaborationHealth * WEIGHTS.collaborationHealth
    ) * 5; // Scale to 0-1000
  }

  private computeTier(score: number): TrustTier {
    for (const [threshold, tier] of TIER_THRESHOLDS) {
      if (score >= threshold) return tier;
    }
    return 'untrusted';
  }
}

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (safeExistsSync(path.join(dir, 'AGENTS.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const GLOBAL_KEY = Symbol.for('@kyberion/trust-engine');
if (!(globalThis as any)[GLOBAL_KEY]) {
  const engine = new TrustEngineImpl();
  engine.loadPersisted();
  engine.startDecayTimer();
  (globalThis as any)[GLOBAL_KEY] = engine;
}
export const trustEngine: TrustEngineImpl = (globalThis as any)[GLOBAL_KEY];
