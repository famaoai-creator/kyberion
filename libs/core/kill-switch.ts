import { logger } from './core';
import { agentRegistry } from './agent-registry';
import { stopAgentRuntime } from './agent-runtime-supervisor';
import { trustEngine } from './trust-engine';
import { auditChain } from './audit-chain';

/**
 * Kill Switch & Anomaly Detection v1.0
 *
 * Detects rogue agents and provides graduated response:
 * warn → isolate (Ring 3) → terminate.
 */

export interface AnomalyIndicator {
  type: 'rapid-fire' | 'frequency-spike' | 'trust-degradation' | 'action-drift' | 'policy-violations';
  threshold: string;
}

const ANOMALY_CONFIG: AnomalyIndicator[] = [
  { type: 'rapid-fire', threshold: '>10 actions / 5s' },
  { type: 'trust-degradation', threshold: '>=15% drop in 1h' },
  { type: 'policy-violations', threshold: '>=3 violations in 10min' },
];

interface ActionLog {
  ts: number;
  action: string;
  policyViolation: boolean;
}

class KillSwitchImpl {
  private actionLogs: Map<string, ActionLog[]> = new Map();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Log an agent action for anomaly tracking.
   */
  logAction(agentId: string, action: string, policyViolation = false): void {
    const logs = this.actionLogs.get(agentId) || [];
    logs.push({ ts: Date.now(), action, policyViolation });
    // Keep last 200 entries
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    this.actionLogs.set(agentId, logs);
  }

  /**
   * Check all agents for anomalies. Returns list of agents with anomalies.
   */
  detectAnomalies(): { agentId: string; anomalies: string[] }[] {
    const results: { agentId: string; anomalies: string[] }[] = [];

    for (const [agentId, logs] of this.actionLogs) {
      const anomalies: string[] = [];
      const now = Date.now();

      // Rapid-fire: >10 actions in 5 seconds
      const recentActions = logs.filter(l => (now - l.ts) < 5000);
      if (recentActions.length > 10) {
        anomalies.push(`rapid-fire: ${recentActions.length} actions in 5s`);
      }

      // Policy violations: >=3 in 10 minutes
      const recentViolations = logs.filter(l => l.policyViolation && (now - l.ts) < 600000);
      if (recentViolations.length >= 3) {
        anomalies.push(`policy-violations: ${recentViolations.length} in 10min`);
      }

      // Trust degradation: >=15% drop
      const trustRecord = trustEngine.getScore(agentId);
      if (trustRecord && trustRecord.history.length >= 2) {
        const hourAgo = trustRecord.history.filter(h => (now - h.ts) < 3600000);
        if (hourAgo.length >= 2) {
          const oldest = hourAgo[0].score;
          const newest = hourAgo[hourAgo.length - 1].score;
          const dropPercent = oldest > 0 ? ((oldest - newest) / oldest) * 100 : 0;
          if (dropPercent >= 15) {
            anomalies.push(`trust-degradation: ${dropPercent.toFixed(1)}% drop in 1h`);
          }
        }
      }

      // Regime shift detection
      const { shifted, divergence } = trustEngine.detectRegimeShift(agentId);
      if (shifted) {
        anomalies.push(`regime-shift: divergence=${divergence.toFixed(2)}`);
      }

      if (anomalies.length > 0) {
        results.push({ agentId, anomalies });
      }
    }

    return results;
  }

  /**
   * Execute graduated response: warn → isolate → kill.
   */
  async respond(agentId: string, anomalies: string[]): Promise<'warned' | 'isolated' | 'killed'> {
    const record = agentRegistry.get(agentId);
    if (!record) return 'warned';

    const severity = anomalies.length;

    // Log to audit chain
    auditChain.record({
      agentId,
      action: 'anomaly_detected',
      operation: 'kill_switch_evaluation',
      result: 'failed',
      reason: anomalies.join('; '),
      metadata: { anomalyCount: severity },
    });

    if (severity >= 3) {
      // Kill
      logger.error(`[KILL_SWITCH] Terminating ${agentId}: ${anomalies.join(', ')}`);
      await stopAgentRuntime(agentId, 'kill_switch');
      auditChain.recordLifecycle(agentId, 'shutdown');
      return 'killed';
    }

    if (severity >= 2) {
      // Isolate: set trust to Ring 3 level
      logger.warn(`[KILL_SWITCH] Isolating ${agentId} to Ring 3: ${anomalies.join(', ')}`);
      trustEngine.recordEvent(agentId, 'securityPosture', -50, `isolated: ${anomalies[0]}`);
      return 'isolated';
    }

    // Warn
    logger.warn(`[KILL_SWITCH] Warning for ${agentId}: ${anomalies.join(', ')}`);
    trustEngine.recordEvent(agentId, 'securityPosture', -10, `warning: ${anomalies[0]}`);
    return 'warned';
  }

  /**
   * Start background anomaly monitoring.
   */
  startMonitor(intervalMs = 10000): void {
    if (this.monitorInterval) return;
    this.monitorInterval = setInterval(async () => {
      const anomalies = this.detectAnomalies();
      for (const { agentId, anomalies: issues } of anomalies) {
        await this.respond(agentId, issues);
      }
    }, intervalMs);
    this.monitorInterval.unref?.();
    logger.info(`[KILL_SWITCH] Monitor started (${intervalMs}ms interval)`);
  }

  stopMonitor(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }
}

const GLOBAL_KEY = Symbol.for('@kyberion/kill-switch');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new KillSwitchImpl();
}
export const killSwitch: KillSwitchImpl = (globalThis as any)[GLOBAL_KEY];
