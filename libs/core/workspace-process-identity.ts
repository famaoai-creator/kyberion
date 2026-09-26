/**
 * Process identity for workspace ledger records: a pid plus its start marker
 * (`ps -o lstart=`), so a recycled pid is never mistaken for the process that
 * registered a workspace.
 */

import { safeExecResult } from './secure-io.js';

export interface ProcessIdentityProbe {
  /** Whether `pid` exists (EPERM counts as alive). */
  isPidAlive?: (pid: number) => boolean;
  /** Start marker of `pid`, or undefined when it cannot be read. */
  startMarker?: (pid: number) => string | undefined;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a process group led by `pgid` still has members. */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1 || process.platform === 'win32') return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function processStartMarker(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return undefined;
  try {
    const result = safeExecResult('ps', ['-p', String(pid), '-o', 'lstart='], {
      timeoutMs: 1000,
      maxOutputMB: 1,
    });
    const parsed = Date.parse(result.stdout.trim());
    return result.status === 0 && Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process recorded as (`pid`, `startedAt`) is still running. A
 * readable start marker that differs means the pid was recycled; an
 * unreadable one falls back to plain pid liveness.
 */
export function isRecordedProcessAlive(
  pid: number,
  startedAt: string | undefined,
  probe: ProcessIdentityProbe = {}
): boolean {
  const alive = (probe.isPidAlive ?? isPidAlive)(pid);
  if (!alive || !startedAt) return alive;
  const current = (probe.startMarker ?? processStartMarker)(pid);
  return current === undefined || current === startedAt;
}
