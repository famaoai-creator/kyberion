import { logger } from '@agent/core/core';
import type { DaemonHeartbeatStatus } from '@agent/core/daemon-heartbeat';
import { safeCreateExclusiveFileSync, safeUnlinkSync } from '@agent/core/secure-io';
import { readDaemonLockTextFile } from './agent_runtime_supervisor_daemon.capacity.js';

export class DaemonExit extends Error {
  constructor(public readonly code: number) {
    super(`agent runtime supervisor exiting with code ${code}`);
    this.name = 'DaemonExit';
  }
}

/**
 * The daemon lock file already exists — inspect the holder pid and decide.
 * Live holder → DaemonExit(0)/error; stale or uninspectable-without-vouch →
 * take the lock over; unreadable → treat as broken and overwrite.
 */
export async function acquireDaemonLockOrThrow(options: {
  lockPath: string;
  priorHeartbeat: DaemonHeartbeatStatus;
  exitOnExistingHealthyDaemon: boolean;
}): Promise<void> {
  const { lockPath, priorHeartbeat, exitOnExistingHealthyDaemon } = options;
  // If lock already exists, try to read the PID
  let pid: number | undefined;
  try {
    const content = readDaemonLockTextFile(lockPath).trim();
    if (content) {
      pid = parseInt(content);
    } else {
      // Lock exists but empty? Wait and retry.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const retryContent = readDaemonLockTextFile(lockPath).trim();
      if (retryContent) pid = parseInt(retryContent);
    }
  } catch (error) {
    logger.warn(
      `[agent-runtime-supervisor-daemon] failed to inspect daemon lock: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (pid && pid !== process.pid) {
    try {
      process.kill(pid, 0); // Check if process exists
      logger.info(
        `[agent-runtime-supervisor-daemon] another instance (pid ${pid}) is already running. exiting.`
      );
      throw new DaemonExit(0);
    } catch (killErr) {
      // EPERM means the process exists but this launcher cannot inspect it
      // (common under a sandbox or across users). Treating that as ESRCH
      // would delete a live daemon's lock and socket, creating a split-brain
      // supervisor whose heartbeat PID changes underneath clients.
      if ((killErr as NodeJS.ErrnoException | undefined)?.code === 'EPERM') {
        // EPERM means the process may exist but this launcher cannot
        // inspect it. Treating that as dead risks a split-brain supervisor —
        // but treating it as alive forever blocks every restart when the
        // pid is long dead (rebooted container, PID reuse across boots).
        // The daemon's own heartbeat is the arbiter: only a heartbeat that
        // is fresh AND vouches for exactly this pid proves a live holder.
        const holderAlive =
          priorHeartbeat.status === 'healthy' &&
          priorHeartbeat.heartbeat?.pid === pid &&
          (priorHeartbeat.heartbeat.status === 'running' ||
            priorHeartbeat.heartbeat.status === 'starting');
        if (holderAlive) {
          const message = `daemon lock is held by an existing process (pid ${pid}) but its liveness cannot be inspected`;
          logger.warn(`[agent-runtime-supervisor-daemon] ${message}`);
          if (exitOnExistingHealthyDaemon) throw new DaemonExit(0);
          throw new Error(message);
        }
        logger.warn(
          `[agent-runtime-supervisor-daemon] daemon lock held by uninspectable pid ${pid} is stale — heartbeat status '${priorHeartbeat.status}' does not vouch for it | next: taking the lock over | evidence: ${lockPath}`
        );
        try {
          safeUnlinkSync(lockPath);
          safeCreateExclusiveFileSync(lockPath, process.pid.toString());
        } catch (error) {
          logger.warn(
            `[agent-runtime-supervisor-daemon] failed to take over stale lock: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        // Process does not exist, stale lock
        try {
          safeUnlinkSync(lockPath);
        } catch (error) {
          logger.warn(
            `[agent-runtime-supervisor-daemon] failed to remove stale lock: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        try {
          safeCreateExclusiveFileSync(lockPath, process.pid.toString());
        } catch (error) {
          logger.warn(
            `[agent-runtime-supervisor-daemon] failed to recreate daemon lock: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  } else {
    // No valid PID found, assume stale/broken and try to overwrite
    try {
      safeUnlinkSync(lockPath);
    } catch (error) {
      logger.warn(
        `[agent-runtime-supervisor-daemon] failed to remove broken lock: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      safeCreateExclusiveFileSync(lockPath, process.pid.toString());
    } catch (error) {
      logger.warn(
        `[agent-runtime-supervisor-daemon] failed to recreate daemon lock: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
