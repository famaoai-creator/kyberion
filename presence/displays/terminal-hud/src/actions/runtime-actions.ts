import {
  restartAgentRuntimeViaDaemon,
  shutdownAgentRuntimeViaDaemon,
  getAgentRuntimeSupervisorHealth,
  type AgentRuntimeSupervisorSnapshot,
} from '@agent/core';
import { auditAction, toActionResult, HUD_PEER_ID, type ActionResult } from './dispatch.js';

export async function restartRuntime(
  snapshot: AgentRuntimeSupervisorSnapshot
): Promise<ActionResult> {
  try {
    const restarted = await restartAgentRuntimeViaDaemon({
      agentId: snapshot.agent_id,
      provider: snapshot.provider ?? 'claude',
      modelId: snapshot.model_id,
      requestedBy: HUD_PEER_ID,
    });
    return auditAction(
      'runtime.restart',
      { ok: true, message: `${restarted.agent_id} ${restarted.status ?? 'restarted'}` },
      { agentId: snapshot.agent_id }
    );
  } catch (err) {
    return auditAction('runtime.restart', toActionResult(err), { agentId: snapshot.agent_id });
  }
}

export async function stopRuntime(agentId: string): Promise<ActionResult> {
  try {
    const { stopped } = await shutdownAgentRuntimeViaDaemon(agentId, HUD_PEER_ID);
    return auditAction(
      'runtime.stop',
      { ok: stopped, message: stopped ? 'stopped' : 'not stopped' },
      { agentId }
    );
  } catch (err) {
    return auditAction('runtime.stop', toActionResult(err), { agentId });
  }
}

/** Explicit operator action: spawn the supervisor daemon if it is not running. */
export async function ensureSupervisorDaemon(): Promise<ActionResult> {
  try {
    const health = await getAgentRuntimeSupervisorHealth();
    return auditAction('runtime.ensure_daemon', {
      ok: true,
      message: `daemon ${String((health as { status?: string }).status ?? 'ok')}`,
    });
  } catch (err) {
    return auditAction('runtime.ensure_daemon', toActionResult(err));
  }
}
