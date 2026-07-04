import { logger } from './core.js';
import { agentRegistry } from './agent-registry.js';
import { stopAgentRuntime } from './agent-runtime-supervisor.js';
import { shutdownAgentRuntimeViaDaemon } from './agent-runtime-supervisor-client.js';
import { trustEngine } from './trust-engine.js';
import { auditChain } from './audit-chain.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { recordConfigFallback } from './config-fallback-registry.js';

export interface AnomalyIndicator {
  type:
    | 'rapid-fire'
    | 'frequency-spike'
    | 'trust-degradation'
    | 'action-drift'
    | 'policy-violations';
  threshold: string;
}

interface TrustPolicyAnomalyDetection {
  rapid_fire: { max_actions: number; window_ms: number };
  policy_violations: { max_violations: number; window_ms: number };
  trust_degradation: { min_drop_percent: number; window_ms: number };
}

let _cachedAnomalyConfig: TrustPolicyAnomalyDetection | null = null;

function loadAnomalyConfig(): TrustPolicyAnomalyDetection {
  if (_cachedAnomalyConfig) return _cachedAnomalyConfig;
  try {
    const filePath = pathResolver.knowledge('product/governance/trust-policy.json');
    const data = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
      anomaly_detection?: TrustPolicyAnomalyDetection;
    };
    _cachedAnomalyConfig = data.anomaly_detection ?? null;
  } catch (err) {
    const defaults: TrustPolicyAnomalyDetection = {
      rapid_fire: { max_actions: 10, window_ms: 5000 },
      policy_violations: { max_violations: 3, window_ms: 600000 },
      trust_degradation: { min_drop_percent: 15, window_ms: 3600000 },
    };
    recordConfigFallback({
      knowledgePath: 'product/governance/trust-policy.json',
      error: err,
      defaults: { anomaly_detection: defaults },
    });
    _cachedAnomalyConfig = defaults;
  }
  if (!_cachedAnomalyConfig) {
    _cachedAnomalyConfig = {
      rapid_fire: { max_actions: 10, window_ms: 5000 },
      policy_violations: { max_violations: 3, window_ms: 600000 },
      trust_degradation: { min_drop_percent: 15, window_ms: 3600000 },
    };
  }
  return _cachedAnomalyConfig;
}

export function getAnomalyConfig(): AnomalyIndicator[] {
  const cfg = loadAnomalyConfig();
  return [
    {
      type: 'rapid-fire',
      threshold: `>${cfg.rapid_fire.max_actions} actions / ${cfg.rapid_fire.window_ms / 1000}s`,
    },
    {
      type: 'trust-degradation',
      threshold: `>=${cfg.trust_degradation.min_drop_percent}% drop in ${cfg.trust_degradation.window_ms / 3600000}h`,
    },
    {
      type: 'policy-violations',
      threshold: `>=${cfg.policy_violations.max_violations} violations in ${cfg.policy_violations.window_ms / 60000}min`,
    },
  ];
}

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

      const anomalyCfg = loadAnomalyConfig();

      // Rapid-fire
      const recentActions = logs.filter((l) => now - l.ts < anomalyCfg.rapid_fire.window_ms);
      if (recentActions.length > anomalyCfg.rapid_fire.max_actions) {
        anomalies.push(
          `rapid-fire: ${recentActions.length} actions in ${anomalyCfg.rapid_fire.window_ms / 1000}s`
        );
      }

      // Policy violations
      const recentViolations = logs.filter(
        (l) => l.policyViolation && now - l.ts < anomalyCfg.policy_violations.window_ms
      );
      if (recentViolations.length >= anomalyCfg.policy_violations.max_violations) {
        anomalies.push(
          `policy-violations: ${recentViolations.length} in ${anomalyCfg.policy_violations.window_ms / 60000}min`
        );
      }

      // Trust degradation
      const trustRecord = trustEngine.getScore(agentId);
      if (trustRecord && trustRecord.history.length >= 2) {
        const hourAgo = trustRecord.history.filter(
          (h) => now - h.ts < anomalyCfg.trust_degradation.window_ms
        );
        if (hourAgo.length >= 2) {
          const oldest = hourAgo[0].score;
          const newest = hourAgo[hourAgo.length - 1].score;
          const dropPercent = oldest > 0 ? ((oldest - newest) / oldest) * 100 : 0;
          if (dropPercent >= anomalyCfg.trust_degradation.min_drop_percent) {
            anomalies.push(
              `trust-degradation: ${dropPercent.toFixed(1)}% drop in ${anomalyCfg.trust_degradation.window_ms / 3600000}h`
            );
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
      // 承認/オペレータ確認必須、自動 kill は既定オフ
      logger.error(`[KILL_SWITCH] Anomaly critical for ${agentId}. Requesting kill approval.`);
      const { enforceApprovalGate } = await import('./approval-gate.js');
      const approval = enforceApprovalGate({
        operationId: 'agent:kill',
        agentId: 'system',
        correlationId: `kill:${agentId}:${Date.now()}`,
        channel: 'system',
        draft: {
          title: `Kill Switch Triggered: ${agentId}`,
          summary: `Anomalies detected: ${anomalies.join(', ')}`,
          severity: 'high',
        },
      });

      if (!approval.allowed) {
        logger.warn(`[KILL_SWITCH] Kill pending approval for ${agentId}. Isolating in the meantime.`);
        trustEngine.recordEvent(agentId, 'securityPosture', -50, `isolated_pending_kill: ${anomalies[0]}`);
        return 'isolated';
      }

      // Kill
      logger.error(`[KILL_SWITCH] Terminating ${agentId}: ${anomalies.join(', ')}`);
      try {
        await shutdownAgentRuntimeViaDaemon(agentId, 'kill_switch');
      } catch (_) {
        await stopAgentRuntime(agentId, 'kill_switch');
      }
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

  isMonitoring(): boolean {
    return this.monitorInterval !== null;
  }
}

const GLOBAL_KEY = Symbol.for('@kyberion/kill-switch');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new KillSwitchImpl();
}
export const killSwitch: KillSwitchImpl = (globalThis as any)[GLOBAL_KEY];

/**
 * Common governance hook for logging actions to the kill switch.
 */
export function recordGovernanceAction(
  agentId: string,
  operation: string,
  reason: string,
  policyViolation = false
): void {
  killSwitch.logAction(agentId, `${operation}:${reason}`, policyViolation);
}
