/**
 * The terminal the approval TTY challenge talks to, and how long it waits.
 *
 * Production always uses the process's own stdin/stdout, the fixed timeout
 * and the real terminal evidence: none is a parameter of
 * `decideApprovalFromCli`. Tests swap them only by installing the seam
 * explicitly (`installCliTtyIoTestSeam`, called from `tty-io.test-support.ts`);
 * a `VITEST` variable alone changes nothing, so a CLI started with it set
 * still probes its real terminal and parent processes.
 */
import * as os from 'node:os';
import { isVitestProcess } from '@agent/core/foundation';
import { safeExecResult } from '@agent/core/secure-io';

export interface CliTtyIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
}

/** Who is at the terminal, as far as the OS can tell (HA-04 audit evidence). */
export interface CliTerminalEvidence {
  osUser: string;
  /** Controlling terminal of this process (`ps -o tty=`), or null without one. */
  tty: string | null;
  /** Ancestor processes, nearest first. */
  lineage: Array<{ pid: number; command: string }>;
}

/** How long the challenge waits for the typed code before refusing. */
export const CLI_TTY_CHALLENGE_TIMEOUT_MS = 120_000;

export interface CliTtyIoTestSeam {
  io?: CliTtyIo;
  timeoutMs?: number;
  evidence?: CliTerminalEvidence;
}

let installedTestSeam: CliTtyIoTestSeam | null = null;

/** Test-only. Call only from `tty-io.test-support.ts`; ignored outside a vitest worker. */
export function installCliTtyIoTestSeam(patch: CliTtyIoTestSeam): void {
  installedTestSeam = { ...(installedTestSeam ?? {}), ...patch };
}

export function clearCliTtyIoTestSeam(): void {
  installedTestSeam = null;
}

function seam(): CliTtyIoTestSeam {
  return installedTestSeam && isVitestProcess() ? installedTestSeam : {};
}

export function resolveCliTtyChallengeTerminal(): { io: CliTtyIo; timeoutMs: number } {
  const active = seam();
  return {
    io: active.io ?? { stdin: process.stdin, stdout: process.stdout },
    timeoutMs: active.timeoutMs ?? CLI_TTY_CHALLENGE_TIMEOUT_MS,
  };
}

/** Walk to pid 1; the cap only guards against a cyclic or runaway `ps` answer. */
const MAX_LINEAGE_DEPTH = 64;

function ps(args: string[]): string | null {
  try {
    const result = safeExecResult('ps', args, { timeoutMs: 2_000 });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Best effort: a platform without `ps` yields no tty and an empty lineage. */
export function resolveCliTerminalEvidence(): CliTerminalEvidence {
  const installed = seam().evidence;
  if (installed) return installed;
  let osUser = 'unknown';
  try {
    osUser = os.userInfo().username;
  } catch {
    // no passwd entry (containers): keep 'unknown'
  }
  const ttyName = ps(['-o', 'tty=', '-p', String(process.pid)]);
  const lineage: CliTerminalEvidence['lineage'] = [];
  let pid = process.ppid;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && pid > 1; depth += 1) {
    // Full command line, not `comm` (truncated to 15 characters on Linux).
    const line = ps(['-o', 'ppid=,command=', '-p', String(pid)]);
    const match = line ? /^(\d+)\s+(.+)$/u.exec(line) : null;
    if (!match) break;
    lineage.push({ pid, command: match[2]!.trim() });
    pid = Number(match[1]);
  }
  return {
    osUser,
    tty: ttyName && ttyName !== '??' && ttyName !== '?' ? ttyName : null,
    lineage,
  };
}
