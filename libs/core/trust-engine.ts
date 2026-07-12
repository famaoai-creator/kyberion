import { logger } from './core.js';
import { safeReadFile, safeWriteFile, safeExistsSync } from './secure-io.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { recordConfigFallback } from './config-fallback-registry.js';

/**
 * Trust Engine v1.0
 *
 * 5-dimensional trust scoring with decay, propagation, and regime shift detection.
 * Inspired by Microsoft Agent Governance Toolkit (AgentMesh).
 */

export interface TrustDimensions {
  policyCompliance: number; // 0-200, weight 25%
  securityPosture: number; // 0-200, weight 25%
  outputQuality: number; // 0-200, weight 20%
  resourceEfficiency: number; // 0-200, weight 15%
  collaborationHealth: number; // 0-200, weight 15%
}

export type TrustTier = 'untrusted' | 'probationary' | 'standard' | 'trusted' | 'verified';

export interface TrustRecord {
  agentId: string;
  score: number; // 0-1000 composite
  tier: TrustTier;
  dimensions: TrustDimensions;
  lastUpdated: number;
  history: { ts: number; score: number; event: string }[];
}

interface TrustPolicyFile {
  scoring: {
    weights: Record<string, number>;
    dimension_max?: number;
  };
  tier_thresholds: Array<{ min_score: number; tier: TrustTier }>;
  decay: { rate_per_hour: number; floor: number };
  propagation: { factor: number; max_depth: number };
  regime_shift: { threshold: number };
  anomaly_detection?: unknown;
}

let _cachedTrustPolicy: TrustPolicyFile | null = null;

function loadTrustPolicy(): TrustPolicyFile {
  if (_cachedTrustPolicy) return _cachedTrustPolicy;
  try {
    const filePath = pathResolver.knowledge('product/governance/trust-policy.json');
    _cachedTrustPolicy = JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as TrustPolicyFile;
  } catch (err) {
    const defaults: TrustPolicyFile = {
      scoring: {
        weights: {
          policyCompliance: 0.25,
          securityPosture: 0.25,
          outputQuality: 0.2,
          resourceEfficiency: 0.15,
          collaborationHealth: 0.15,
        },
      },
      tier_thresholds: [
        { min_score: 900, tier: 'verified' },
        { min_score: 700, tier: 'trusted' },
        { min_score: 500, tier: 'standard' },
        { min_score: 300, tier: 'probationary' },
        { min_score: 0, tier: 'untrusted' },
      ],
      decay: { rate_per_hour: 2, floor: 100 },
      propagation: { factor: 0.3, max_depth: 2 },
      regime_shift: { threshold: 0.5 },
    };
    recordConfigFallback({
      knowledgePath: 'product/governance/trust-policy.json',
      error: err,
      defaults,
    });
    _cachedTrustPolicy = defaults;
  }
  return _cachedTrustPolicy;
}

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

    logger.info(
      `[TRUST] ${agentId}: ${event} → ${dimension} ${delta > 0 ? '+' : ''}${delta} → score=${record.score} (${record.tier})`
    );
    return record;
  }

  /**
   * Apply time-based trust decay to all agents.
   */
  applyDecay(): void {
    const { rate_per_hour, floor } = loadTrustPolicy().decay;
    for (const record of this.records.values()) {
      if (record.score <= floor) continue;

      const hoursSinceUpdate = (Date.now() - record.lastUpdated) / 3600000;
      if (hoursSinceUpdate < 1) continue;

      const decay = Math.floor(hoursSinceUpdate * rate_per_hour);
      if (decay > 0) {
        const newScore = Math.max(floor, record.score - decay);
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
    const { factor: propFactor, max_depth } = loadTrustPolicy().propagation;
    const { floor } = loadTrustPolicy().decay;
    if (depth >= max_depth) return;

    const factor = Math.pow(propFactor, depth + 1);
    const propagatedPenalty = Math.round(penalty * factor);

    for (const neighborId of neighborIds) {
      if (neighborId === agentId) continue;
      const record = this.records.get(neighborId);
      if (record) {
        record.score = Math.max(floor, record.score - propagatedPenalty);
        record.tier = this.computeTier(record.score);
        record.history.push({
          ts: Date.now(),
          score: record.score,
          event: `propagated penalty from ${agentId} (-${propagatedPenalty})`,
        });
        logger.info(
          `[TRUST_PROPAGATION] ${neighborId}: -${propagatedPenalty} from ${agentId} (depth ${depth + 1})`
        );
      }
    }
  }

  /**
   * Detect regime shift: significant behavioral change using simplified KL divergence.
   */
  detectRegimeShift(agentId: string): { shifted: boolean; divergence: number } {
    const record = this.records.get(agentId);
    if (!record || record.history.length < 10) return { shifted: false, divergence: 0 };

    const recent = record.history.slice(-5).map((h) => h.score);
    const baseline = record.history.slice(-20, -5).map((h) => h.score);

    if (baseline.length < 5) return { shifted: false, divergence: 0 };

    const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const baselineMean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const baselineStd =
      Math.sqrt(
        baseline.reduce((s, v) => s + Math.pow(v - baselineMean, 2), 0) / baseline.length
      ) || 1;

    const divergence = Math.abs(recentMean - baselineMean) / baselineStd;

    const { threshold } = loadTrustPolicy().regime_shift;
    if (divergence > threshold) {
      logger.warn(
        `[TRUST_REGIME_SHIFT] ${agentId}: divergence=${divergence.toFixed(2)} (threshold=${threshold})`
      );
    }

    return { shifted: divergence > threshold, divergence };
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
    const filePath = path.join(
      root,
      'knowledge',
      'personal',
      'governance',
      'agent-trust-scores.json'
    );
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
    } catch (_) {
      /* trust persistence is best-effort; in-memory state stays authoritative */
    }
  }

  /** Load persisted trust records */
  loadPersisted(rootDir?: string): void {
    const root = rootDir || findProjectRoot();
    const filePath = path.join(
      root,
      'knowledge',
      'personal',
      'governance',
      'agent-trust-scores.json'
    );
    if (!safeExistsSync(filePath)) return;
    try {
      const data = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
      for (const [agentId, entry] of Object.entries(data as Record<string, any>)) {
        this.records.set(agentId, {
          agentId,
          score: entry.current_score ?? 500,
          tier: this.computeTier(entry.current_score ?? 500),
          dimensions: entry.dimensions ?? {
            policyCompliance: 100,
            securityPosture: 100,
            outputQuality: 100,
            resourceEfficiency: 100,
            collaborationHealth: 100,
          },
          lastUpdated: entry.last_updated ? new Date(entry.last_updated).getTime() : Date.now(),
          history: [],
        });
      }
      logger.info(`[TRUST] Loaded ${this.records.size} persisted trust records`);
    } catch (_) {
      /* no persisted trust records: start from defaults */
    }
  }

  getAll(): TrustRecord[] {
    return Array.from(this.records.values());
  }

  private computeComposite(dim: TrustDimensions): number {
    const w = loadTrustPolicy().scoring.weights;
    return (
      Math.round(
        dim.policyCompliance * (w['policyCompliance'] ?? 0.25) +
          dim.securityPosture * (w['securityPosture'] ?? 0.25) +
          dim.outputQuality * (w['outputQuality'] ?? 0.2) +
          dim.resourceEfficiency * (w['resourceEfficiency'] ?? 0.15) +
          dim.collaborationHealth * (w['collaborationHealth'] ?? 0.15)
      ) * 5
    ); // Scale to 0-1000
  }

  private computeTier(score: number): TrustTier {
    for (const { min_score, tier } of loadTrustPolicy().tier_thresholds) {
      if (score >= min_score) return tier;
    }
    return 'untrusted';
  }
}

function findProjectRoot(): string {
  return pathResolver.rootDir();
}

const GLOBAL_KEY = Symbol.for('@kyberion/trust-engine');
if (!(globalThis as any)[GLOBAL_KEY]) {
  const engine = new TrustEngineImpl();
  engine.loadPersisted();
  engine.startDecayTimer();
  (globalThis as any)[GLOBAL_KEY] = engine;
}
export const trustEngine: TrustEngineImpl = (globalThis as any)[GLOBAL_KEY];
