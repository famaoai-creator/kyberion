#!/usr/bin/env tsx
/**
 * terminal_session_cli.ts — persistent terminal-actuator bridge.
 *
 * The terminal actuator keeps PTY sessions in an in-memory engine, so a
 * one-shot `pnpm playground` process loses every session when it exits.
 * This script fronts the actuator's `--serve` NDJSON mode with a local IPC
 * daemon:
 *
 *   pnpm terminal serve                          # resident daemon (foreground)
 *   pnpm terminal <action> --params '<json>'     # client; auto-starts daemon
 *   pnpm terminal status | stop                  # daemon management
 *
 * Socket, pidfile, and startup log live under
 * active/shared/runtime/terminal-daemon/ — durable runtime state per
 * storage-layout policy. Sessions survive only while the daemon runs.
 */
import {
  safeExistsSync as existsSync,
  safeMkdir as mkdirSync,
  safeReadFile,
  safeUnlinkSync as unlinkSync,
  safeWriteFile as writeFileSync,
  withSafeAppendFile,
} from '@agent/core/secure-io';
// eslint-disable-next-line no-restricted-imports -- Detached terminal bridge owns child lifetime; registered in governance-import-baseline.json.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getRegisteredEnv, nowIso } from '@agent/core/foundation';
import { isWindowsNamedPipeAddress, resolveLocalIpcAddress } from '../libs/core/local-ipc.js';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  setProcessExitCode,
} from './lib/harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = path.join(ROOT, 'active/shared/runtime/terminal-daemon');
const SOCK = resolveLocalIpcAddress(path.join(RUNTIME_DIR, 'terminal-daemon.sock'));
const FILESYSTEM_SOCKET = !isWindowsNamedPipeAddress(SOCK);
const PIDFILE = path.join(RUNTIME_DIR, 'daemon.pid');
const LOGFILE = path.join(RUNTIME_DIR, 'daemon.log');
const ACTUATOR = path.join(ROOT, 'dist/libs/actuators/terminal-actuator/src/index.js');
const TS_LOADER = path.join(ROOT, 'scripts/ts-loader.mjs');
const SELF = path.join(ROOT, 'scripts/terminal_session_cli.ts');

// Must equal ACTUATOR_SERVE_RESULT_PREFIX in libs/core/cli-utils.ts; the
// constant is duplicated here so the framing stays stable for the daemon's
// raw stdout reader, and scripts/terminal_session_cli.test.ts asserts the
// two stay in sync.
const SERVE_RESULT_PREFIX = '@@kyberion-actuator-result@@';

const STARTUP_TIMEOUT_MS = Number(getRegisteredEnv('KYBERION_TERMINAL_DAEMON_TIMEOUT_MS') ?? 20000);
const REQUEST_TIMEOUT_MS = Number(
  getRegisteredEnv('KYBERION_TERMINAL_REQUEST_TIMEOUT_MS') ?? 30000
);
/** Serve-loop requests get this long before the daemon fails the waiter. */
const ACTUATOR_REQUEST_TIMEOUT_MS = 120_000;

let clientSeq = 0;

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLine(message: string): void {
  const line = `[terminal-daemon] ${nowIso()} ${message}\n`;
  // The detached daemon already redirects stderr into LOGFILE. Foreground
  // serve writes to its caller's stderr, avoiding a second file logger.
  process.stderr.write(line);
}

/** Extract a framed serve-loop response from one stdout line, or null. */
export function parseServeResultLine(line: string): Record<string, unknown> | null {
  const idx = line.indexOf(SERVE_RESULT_PREFIX);
  if (idx < 0) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(idx + SERVE_RESULT_PREFIX.length));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function uniqueRequestId(): string {
  return `r${process.pid}-${Date.now().toString(36)}-${++clientSeq}`;
}

/** Shape the actuator `input` payload for a CLI invocation. */
export function inputForCli(
  action: string | undefined,
  params: Record<string, unknown>,
  raw: unknown
): unknown {
  if (raw !== undefined) return raw;
  if (!action) throw new Error('missing terminal action');
  return { action, params };
}

/* ------------------------------------------------------------------ */
/* Daemon (serve)                                                     */
/* ------------------------------------------------------------------ */

interface Waiter {
  conn: net.Socket;
  timer: NodeJS.Timeout;
}

function safeWrite(conn: net.Socket, data: string): void {
  try {
    conn.write(data);
  } catch {
    /* client may have disconnected */
  }
}

async function startDaemon(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!existsSync(ACTUATOR)) {
    const message = `actuator bundle missing: ${ACTUATOR} — run \`pnpm build:actuators\` first`;
    logLine(message);
    throw new ScriptExitError(1, message, false);
  }
  if (FILESYSTEM_SOCKET) {
    try {
      unlinkSync(SOCK);
    } catch {
      /* no stale socket */
    }
  }

  const actuator: ChildProcess = spawn(process.execPath, [ACTUATOR, '--serve'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const waiters = new Map<string, Waiter>();
  const connections = new Set<net.Socket>();
  const reply = (conn: net.Socket, value: Record<string, unknown>): void => {
    safeWrite(conn, `${JSON.stringify(value)}\n`);
  };

  let outBuf = '';
  actuator.stdout?.on('data', (chunk: Buffer) => {
    outBuf += chunk.toString('utf8');
    let nl: number;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl);
      outBuf = outBuf.slice(nl + 1);
      const res = parseServeResultLine(line);
      if (!res) continue;
      const id = typeof res.id === 'string' ? res.id : 'default';
      const waiter = waiters.get(id);
      if (!waiter) continue;
      waiters.delete(id);
      clearTimeout(waiter.timer);
      reply(waiter.conn, res);
    }
  });

  const server = net.createServer((conn) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    conn.on('error', () => {
      /* a dead client must not kill the daemon */
    });
    let buf = '';
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req: { id?: unknown; input?: unknown };
        try {
          req = JSON.parse(line) as { id?: unknown; input?: unknown };
        } catch (err) {
          reply(conn, { ok: false, error: `invalid JSON request: ${errMsg(err)}` });
          continue;
        }
        const id = typeof req.id === 'string' && req.id ? req.id : uniqueRequestId();
        const timer = setTimeout(() => {
          if (waiters.delete(id)) {
            reply(conn, { id, ok: false, error: 'actuator request timed out' });
          }
        }, ACTUATOR_REQUEST_TIMEOUT_MS);
        waiters.set(id, { conn, timer });
        try {
          actuator.stdin?.write(`${JSON.stringify({ id, input: req.input })}\n`);
        } catch (err) {
          clearTimeout(timer);
          waiters.delete(id);
          reply(conn, { id, ok: false, error: `actuator stdin write failed: ${errMsg(err)}` });
        }
      }
    });
  });

  // Drains the event loop: once the actuator child, the listening socket,
  // and every client connection are gone the process exits on its own with
  // the exit code recorded below.
  const shutdown = (code: number): void => {
    for (const [id, waiter] of waiters) {
      clearTimeout(waiter.timer);
      reply(waiter.conn, { id, ok: false, error: 'terminal daemon shutting down' });
    }
    waiters.clear();
    try {
      actuator.kill();
    } catch {
      /* already gone */
    }
    try {
      server.close();
    } catch {
      /* not listening */
    }
    for (const conn of connections) {
      try {
        conn.destroy();
      } catch {
        /* already closed */
      }
    }
    cleanupDaemonFiles(process.pid);
    setProcessExitCode(code);
  };

  actuator.on('exit', (code) => {
    logLine(`actuator exited (code ${code ?? 'null'})`);
    shutdown(code ?? 1);
  });
  actuator.on('error', (err) => {
    logLine(`actuator spawn error: ${errMsg(err)}`);
    shutdown(1);
  });

  server.on('error', (err) => {
    logLine(`socket error on ${SOCK}: ${errMsg(err)}`);
    shutdown(1);
  });
  server.listen(SOCK, () => {
    writeFileSync(PIDFILE, String(process.pid));
    logLine(`listening on ${SOCK} (pid ${process.pid})`);
  });

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  await new Promise<void>(() => {
    /* resident until signaled */
  });
}

/* ------------------------------------------------------------------ */
/* Client                                                             */
/* ------------------------------------------------------------------ */

/** Send one framed request to a socket and resolve with the first response line. */
export function requestOn(
  sockPath: string,
  input: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(resolveLocalIpcAddress(sockPath));
    let buf = '';
    const done = <T>(fn: (v: T) => void, v: T): void => {
      clearTimeout(timer);
      conn.destroy();
      fn(v);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`terminal daemon request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        done(resolve, JSON.parse(line) as Record<string, unknown>);
      } catch {
        done(reject, new Error(`malformed daemon response: ${line.slice(0, 200)}`));
      }
    });
    conn.on('error', (err) => done(reject, err));
    conn.on('connect', () => conn.write(`${JSON.stringify({ id: uniqueRequestId(), input })}\n`));
  });
}

const request = (input: unknown, timeoutMs?: number): Promise<Record<string, unknown>> =>
  requestOn(SOCK, input, timeoutMs);

/** `list` is side-effect-free; any well-formed answer proves the round-trip. */
async function pingDaemon(timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await request({ action: 'list', params: {} }, timeoutMs);
    return res.ok === true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const pid = Number((safeReadFile(PIDFILE, { encoding: 'utf8' }) as string).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function shouldRemovePidFileForOwner(
  currentPid: number | null,
  expectedPid: number | null | undefined
): boolean {
  return expectedPid === undefined || currentPid === expectedPid;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonAlive(): boolean {
  const pid = readPid();
  return pid !== null && pidAlive(pid);
}

function cleanupDaemonFiles(expectedPid?: number | null): void {
  if (FILESYSTEM_SOCKET) {
    try {
      unlinkSync(SOCK);
    } catch {
      /* absent */
    }
  }
  if (shouldRemovePidFileForOwner(readPid(), expectedPid)) {
    try {
      unlinkSync(PIDFILE);
    } catch {
      /* absent */
    }
  }
}

function readLogTail(lines = 20): string {
  try {
    const content = (safeReadFile(LOGFILE, { encoding: 'utf8' }) as string).trimEnd();
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function startupFailure(reason: string): Error {
  const tail = readLogTail();
  return new Error(
    `${reason}\nDaemon log (${LOGFILE}):\n${tail || '(empty — daemon produced no output)'}`
  );
}

async function ensureDaemon(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if ((FILESYSTEM_SOCKET ? existsSync(SOCK) : true) && (await pingDaemon())) return;

  const existingPid = readPid();
  if (existingPid !== null && pidAlive(existingPid)) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline && pidAlive(existingPid)) {
      if (await pingDaemon()) return;
      await sleep(150);
    }
    if (pidAlive(existingPid)) {
      throw startupFailure(
        `terminal daemon pid ${existingPid} is alive but its local IPC endpoint is not responding`
      );
    }
  }

  if (!existsSync(ACTUATOR)) {
    throw new Error(
      `terminal actuator bundle missing: ${ACTUATOR}\nRun \`pnpm build:actuators\` first.`
    );
  }
  cleanupDaemonFiles(existingPid);

  const child = withSafeAppendFile(LOGFILE, (logFd) =>
    spawn(process.execPath, ['--import', pathToFileURL(TS_LOADER).href, SELF, 'serve'], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
  );
  let childExit: number | null = null;
  let childError: string | null = null;
  child.on('exit', (code) => {
    childExit = code ?? 1;
  });
  child.on('error', (err) => {
    childError = errMsg(err);
  });
  child.unref();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((FILESYSTEM_SOCKET ? existsSync(SOCK) : true) && (await pingDaemon())) return;
    if (childError !== null) {
      throw startupFailure(`terminal daemon failed to spawn: ${childError}`);
    }
    if (childExit !== null) {
      // A racing client may have won the bind — accept it if it answers.
      if ((FILESYSTEM_SOCKET ? existsSync(SOCK) : true) && (await pingDaemon())) return;
      throw startupFailure(`terminal daemon exited during startup (code ${childExit})`);
    }
    await sleep(150);
  }
  throw startupFailure(`terminal daemon did not become ready within ${STARTUP_TIMEOUT_MS}ms`);
}

async function daemonStatus(): Promise<Record<string, unknown>> {
  const pid = readPid();
  const socket = FILESYSTEM_SOCKET ? existsSync(SOCK) : await pingDaemon();
  let ping: unknown = null;
  if (socket) {
    try {
      ping = await request({ action: 'list', params: {} }, 5000);
    } catch (err) {
      ping = { ok: false, error: errMsg(err) };
    }
  }
  return {
    daemon: daemonAlive(),
    pid,
    socket,
    ping,
    logfile: existsSync(LOGFILE) ? LOGFILE : null,
  };
}

async function stopDaemon(): Promise<Record<string, unknown>> {
  const pid = readPid();
  if (pid !== null && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* raced with exit */
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pidAlive(pid)) await sleep(100);
  }
  const stillRunning = pid !== null && pidAlive(pid);
  if (!stillRunning) cleanupDaemonFiles(pid);
  return { stopped: !stillRunning, pid };
}

/* ------------------------------------------------------------------ */

async function run(argv: string[]): Promise<void> {
  const cmd = argv[0];

  if (cmd === 'serve') {
    await startDaemon();
    return;
  }
  if (cmd === 'status') {
    emit(await daemonStatus());
    return;
  }
  if (cmd === 'stop') {
    emit(await stopDaemon());
    return;
  }

  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const timeout = flagValue('--timeout-ms');
  const paramsRaw = flagValue('--params');
  const raw = flagValue('--raw');

  if (!cmd) {
    emit({
      usage:
        'pnpm terminal serve|status|stop|<action> [--params <json>] [--raw <json>] [--timeout-ms <n>]',
      actions: ['spawn', 'poll', 'write', 'resize', 'kill', 'list', 'shell_command', 'llm_decide'],
    });
    return;
  }

  const input = inputForCli(
    cmd,
    paramsRaw ? (JSON.parse(paramsRaw) as Record<string, unknown>) : {},
    raw !== undefined ? JSON.parse(raw) : undefined
  );

  await ensureDaemon();
  emit(await request(input, timeout !== undefined ? Number(timeout) : undefined));
}

export const runTerminal = defineScript({
  name: 'terminal',
  flags: [],
  async run(context) {
    try {
      await run(context.argv);
    } catch (error) {
      if (error instanceof ScriptExitError) throw error;
      emit({ ok: false, error: errMsg(error) });
      throw new ScriptExitError(1, '', true);
    }
  },
});

if (
  isDirectScript(import.meta.url, 'terminal_session_cli.ts') ||
  isDirectScript(import.meta.url, 'terminal_session_cli.js')
) {
  void runTerminal();
}
