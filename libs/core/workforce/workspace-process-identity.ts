/**
 * Process identity for workspace ledger records: a pid plus its start marker
 * (`ps -o lstart=`), so a recycled pid is never mistaken for the process that
 * registered a workspace (or the delegated child using it).
 *
 * The marker is the raw `ps` output under `LC_ALL=C` / `TZ=UTC` (POSIX) or the
 * `Get-Process` StartTime in ISO-UTC (win32), compared as an opaque string:
 * parsing it would depend on the locale and time zone of whichever process
 * reads it. Where no marker can be read (a busybox `ps` without `lstart`, no
 * PowerShell), liveness falls back to plain pid existence.
 *
 * Known limitation: both markers carry ~1s granularity, so a pid recycled
 * within the same second escapes detection — the guard shrinks the reuse
 * window, it does not eliminate it.
 */

import { safeExecResult } from '../secure-io.js';
import { platformFacts } from '../platform-facts.js';

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
  if (!Number.isInteger(pgid) || pgid <= 1 || !platformFacts.processModel.hasProcessGroups)
    return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function processStartMarker(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (platformFacts.platform === 'win32') {
      const result = safeExecResult(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { timeoutMs: 3000, maxOutputMB: 1 }
      );
      const marker = result.stdout.trim();
      return result.status === 0 && marker.length > 0 ? marker : undefined;
    }
    if (!platformFacts.processModel.hasPosixSignals) return undefined;
    const result = safeExecResult('ps', ['-p', String(pid), '-o', 'lstart='], {
      timeoutMs: 1000,
      maxOutputMB: 1,
      env: { LC_ALL: 'C', TZ: 'UTC' },
    });
    const marker = result.stdout.trim();
    return result.status === 0 && marker.length > 0 ? marker : undefined;
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

export interface RecordedChild {
  childPid?: number;
  childStartedAt?: string;
}

/**
 * Whether the delegated child recorded on a git-index workspace still runs:
 * the recorded process itself (pid-reuse guarded), or any member of the
 * process group it leads (a detached child's descendants keep the group, and
 * a live group id is never handed out as a new pid). Injected probes replace
 * the group check so tests stay hermetic.
 */
export function isRecordedChildAlive(
  record: RecordedChild,
  probe: ProcessIdentityProbe = {}
): boolean {
  const pid = record.childPid;
  if (pid === undefined) return false;
  if (isRecordedProcessAlive(pid, record.childStartedAt, probe)) return true;
  return !probe.isPidAlive && isProcessGroupAlive(pid);
}
