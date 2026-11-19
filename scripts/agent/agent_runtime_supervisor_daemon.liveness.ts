/**
 * Daemon liveness helpers for the agent-runtime supervisor: probe an existing
 * daemon's `health` endpoint and mark heartbeats of verifiably dead pids.
 */
import * as net from 'node:net';
import { logger } from '@agent/core/core';
import { listDaemonHeartbeatStatuses, recordDaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import {
  normalizeSupervisorResponse,
  normalizeSupervisorResult,
} from '@agent/core/agent/agent-runtime-supervisor-client';
import { getRegisteredEnvText, parseSafeJsonInput } from '@agent/core/foundation';

type TcpListenTarget = { host: string; port: number };
export type ListenTarget = string | TcpListenTarget;

export async function probeDaemonHealth(target: ListenTarget, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket =
      typeof target === 'string'
        ? net.createConnection(target)
        : net.createConnection({ host: target.host, port: target.port });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          id: 'health-probe',
          method: 'health',
          ...(getRegisteredEnvText('KYBERION_AGENT_RUNTIME_SUPERVISOR_TOKEN')
            ? { auth_token: getRegisteredEnvText('KYBERION_AGENT_RUNTIME_SUPERVISOR_TOKEN') }
            : {}),
        })}\n`
      );
    });
    socket.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (!line) return done(false);
      try {
        const response = normalizeSupervisorResponse<unknown>(
          parseSafeJsonInput(line, 'agent runtime supervisor response')
        );
        if (!response.ok) return done(false);
        normalizeSupervisorResult('health', response.result);
        done(true);
      } catch {
        done(false);
      }
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Rewrite heartbeat files that still claim `running`/`starting` for a
 * verifiably dead pid. A daemon that exits without its shutdown path leaves a
 * 'running' heartbeat behind, and stale state like that is how the supervisor
 * looked alive for days after `process_exit`. Only ESRCH counts as dead —
 * EPERM is uninspectable and the record is left alone (fail closed).
 */
export function markDeadPidHeartbeats(): void {
  try {
    for (const status of listDaemonHeartbeatStatuses()) {
      const heartbeat = status.heartbeat;
      if (!heartbeat || (heartbeat.status !== 'running' && heartbeat.status !== 'starting'))
        continue;
      if (heartbeat.pid === process.pid) continue;
      try {
        process.kill(heartbeat.pid, 0);
        continue; // alive
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') continue; // EPERM → cannot prove death
      }
      recordDaemonHeartbeat(heartbeat.daemon_id, {
        pid: heartbeat.pid,
        status: 'stopping',
        details: {
          ...(heartbeat.details ?? {}),
          stopped_reason: 'process_exit_detected',
          observed_by: 'agent-runtime-supervisor-daemon',
        },
      });
      logger.info(
        `[agent-runtime-supervisor-daemon] heartbeat for ${heartbeat.daemon_id} marked stopping — pid ${heartbeat.pid} is gone | next: watchdog or launcher may restart it | evidence: runtime/heartbeats/${heartbeat.daemon_id}.json`
      );
    }
  } catch (error) {
    logger.warn(
      `[agent-runtime-supervisor-daemon] dead-pid heartbeat sweep failed — ${error instanceof Error ? error.message : error} | next: heartbeats keep their own values; watchdog staleness still applies`
    );
  }
}
