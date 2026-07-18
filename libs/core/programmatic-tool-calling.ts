/* eslint-disable no-restricted-imports -- PTC owns the short-lived UDS transport. */
import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeUnlinkSync, safeExistsSync } from './secure-io.js';

export const PROGRAMMATIC_TOOL_SANDBOX_ALLOWLIST = [
  'system:read_file',
  'system:read_json',
  'system:glob_files',
  'system:scan_directory',
  'system:json_query',
  'system:regex_extract',
  'system:list_capabilities',
  'system:list_knowledge',
] as const;

const OP_PATTERN = /^[a-z][a-z0-9_-]{0,48}:[a-z][a-z0-9_-]{0,80}$/u;
const FORBIDDEN_SCRIPT_PATTERN =
  /\b(?:process|require|import|eval|Function|globalThis|constructor|__proto__|prototype|child_process|node:|Deno|Bun)\b/u;
const DEFAULT_MAX_CALLS = 20;
const MAX_MAX_CALLS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDOUT_CHARS = 32_000;
const MAX_STDOUT_CHARS = 200_000;
const MAX_CODE_CHARS = 80_000;

export interface ProgrammaticToolCallRequest {
  code: string;
  allowed_ops: string[];
  granted_ops: string[];
  max_calls?: number;
  timeout_ms?: number;
  max_stdout_chars?: number;
}

export interface ProgrammaticToolCallResult {
  stdout: string;
  calls: number;
  granted_ops: string[];
  effective_ops: string[];
}

export interface ProgrammaticToolCallInvocation {
  op: string;
  params: Record<string, unknown>;
  call_index: number;
}

export interface ProgrammaticToolCallOptions {
  request: ProgrammaticToolCallRequest;
  invoke: (invocation: ProgrammaticToolCallInvocation) => Promise<unknown>;
  on_call?: (event: {
    op: string;
    call_index: number;
    status: 'allowed' | 'denied' | 'succeeded' | 'failed';
    error?: string;
  }) => void;
  /** Test-only runner override; production uses the built runner. */
  runner?: { command: string; args: string[]; cwd?: string };
}

interface RpcRequest {
  token: string;
  id: string;
  method: 'call_op';
  op: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface RunnerEnvelope {
  socket_path: string;
  token: string;
  code: string;
  effective_ops: string[];
  max_calls: number;
  timeout_ms: number;
  max_stdout_chars: number;
}

interface RunnerOutput {
  ok: boolean;
  stdout?: string;
  calls?: number;
  error?: string;
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === 'number' ? Math.floor(value) : Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, max);
}

function normalizeOps(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map(String)
        .map((value) => value.trim())
        .filter((value) => OP_PATTERN.test(value))
    ),
  ];
}

/** Resolve the only grant set a PTC child may use: sandbox allowlist ∩ session grant. */
export function resolveProgrammaticToolGrant(allowedOps: unknown, grantedOps: unknown): string[] {
  const requested = normalizeOps(allowedOps);
  const granted = new Set(normalizeOps(grantedOps));
  const sandbox = new Set<string>(PROGRAMMATIC_TOOL_SANDBOX_ALLOWLIST);
  return requested.filter((op) => sandbox.has(op) && granted.has(op));
}

function validateRequest(request: ProgrammaticToolCallRequest): {
  code: string;
  effectiveOps: string[];
  maxCalls: number;
  timeoutMs: number;
  maxStdoutChars: number;
} {
  const code = String(request.code || '');
  if (!code.trim()) throw new Error('[PTC_POLICY] code is required.');
  if (code.length > MAX_CODE_CHARS) throw new Error('[PTC_POLICY] code exceeds the size limit.');
  if (FORBIDDEN_SCRIPT_PATTERN.test(code)) {
    throw new Error('[PTC_POLICY] script contains a forbidden runtime escape or import.');
  }
  const effectiveOps = resolveProgrammaticToolGrant(request.allowed_ops, request.granted_ops);
  if (effectiveOps.length === 0) {
    throw new Error('[PTC_POLICY] allowed_ops ∩ granted_ops is empty.');
  }
  return {
    code,
    effectiveOps,
    maxCalls: boundedInteger(request.max_calls, DEFAULT_MAX_CALLS, MAX_MAX_CALLS),
    timeoutMs: boundedInteger(request.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxStdoutChars: boundedInteger(
      request.max_stdout_chars,
      DEFAULT_MAX_STDOUT_CHARS,
      MAX_STDOUT_CHARS
    ),
  };
}

function writeLine(socket: net.Socket, payload: unknown): void {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[PTC_LIMIT] ${label} exceeded.`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function defaultRunner(): { command: string; args: string[]; cwd: string } {
  const runnerPath = pathResolver.rootResolve('dist/scripts/programmatic_tool_runner.js');
  if (!safeExistsSync(runnerPath)) {
    throw new Error('[PTC_POLICY] Built PTC runner is missing; run the repository build first.');
  }
  return { command: process.execPath, args: [runnerPath], cwd: pathResolver.rootDir() };
}

function parseRunnerOutput(raw: string): RunnerOutput {
  const line = raw.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) throw new Error('[PTC_RUNNER] runner returned no output.');
  try {
    return JSON.parse(line) as RunnerOutput;
  } catch {
    throw new Error('[PTC_RUNNER] runner returned invalid output.');
  }
}

/**
 * Run model-written glue in a short-lived child. The parent owns every typed
 * op call over an authenticated UDS; only the child’s captured stdout returns.
 */
export async function executeProgrammaticToolCall(
  options: ProgrammaticToolCallOptions
): Promise<ProgrammaticToolCallResult> {
  const normalized = validateRequest(options.request);
  // macOS caps AF_UNIX paths at a little over 100 bytes; keep the socket
  // path short even when the repository is checked out under a deep path.
  const token = randomUUID().replaceAll('-', '').slice(0, 16);
  const socketDir = pathResolver.sharedTmp('ptc');
  safeMkdir(socketDir, { recursive: true });
  const socketPath = path.join(socketDir, `${token}.sock`);
  const server = net.createServer();
  let connection: net.Socket | undefined;
  let callCount = 0;
  let connectionReady: (() => void) | undefined;
  let connectionFailed: ((error: Error) => void) | undefined;
  const connected = new Promise<void>((resolve, reject) => {
    connectionReady = resolve;
    connectionFailed = reject;
  });

  server.on('connection', (socket) => {
    if (connection) {
      socket.destroy();
      return;
    }
    connection = socket;
    connectionReady?.();
    let buffer = '';
    let queue = Promise.resolve();
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line) continue;
        queue = queue.then(async () => {
          let request: RpcRequest;
          try {
            request = JSON.parse(line) as RpcRequest;
          } catch {
            writeLine(socket, { id: 'invalid', ok: false, error: '[PTC_RPC] invalid JSON.' });
            return;
          }
          if (request.token !== token) {
            writeLine(socket, { id: request.id, ok: false, error: '[PTC_RPC] invalid token.' });
            socket.destroy();
            return;
          }
          if (request.method !== 'call_op' || !OP_PATTERN.test(request.op)) {
            writeLine(socket, {
              id: request.id,
              ok: false,
              error: '[PTC_RPC] invalid op request.',
            });
            return;
          }
          callCount += 1;
          if (callCount > normalized.maxCalls) {
            options.on_call?.({
              op: request.op,
              call_index: callCount,
              status: 'denied',
              error: '[PTC_LIMIT] call limit exceeded.',
            });
            writeLine(socket, {
              id: request.id,
              ok: false,
              error: '[PTC_LIMIT] call limit exceeded.',
            });
            socket.destroy();
            return;
          }
          if (!normalized.effectiveOps.includes(request.op)) {
            options.on_call?.({
              op: request.op,
              call_index: callCount,
              status: 'denied',
              error: '[PTC_POLICY] op is outside allowed_ops ∩ granted_ops.',
            });
            writeLine(socket, {
              id: request.id,
              ok: false,
              error: '[PTC_POLICY] op is outside allowed_ops ∩ granted_ops.',
            });
            return;
          }
          options.on_call?.({ op: request.op, call_index: callCount, status: 'allowed' });
          try {
            const result = await withTimeout(
              options.invoke({
                op: request.op,
                params: request.params || {},
                call_index: callCount,
              }),
              normalized.timeoutMs,
              'op timeout'
            );
            options.on_call?.({ op: request.op, call_index: callCount, status: 'succeeded' });
            writeLine(socket, { id: request.id, ok: true, result });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            options.on_call?.({
              op: request.op,
              call_index: callCount,
              status: 'failed',
              error: detail,
            });
            writeLine(socket, { id: request.id, ok: false, error: detail.slice(0, 2_000) });
          }
        });
      }
    });
    socket.on('error', (error) => connectionFailed?.(error));
  });

  const listenPromise = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  let child: ChildProcess | undefined;
  let stdout = '';
  let stderr = '';
  try {
    await listenPromise;
    const runner = options.runner || defaultRunner();
    const childEnv: NodeJS.ProcessEnv = {
      KYBERION_PTC_CHILD: '1',
      PATH: process.env.PATH,
      NODE_ENV: process.env.NODE_ENV,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
    };
    child = spawn(runner.command, runner.args, {
      cwd: runner.cwd || pathResolver.rootDir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > normalized.maxStdoutChars * 2 + 4_096) {
        child?.kill('SIGKILL');
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 2_000);
    });
    const envelope: RunnerEnvelope = {
      socket_path: socketPath,
      token,
      code: normalized.code,
      effective_ops: normalized.effectiveOps,
      max_calls: normalized.maxCalls,
      timeout_ms: normalized.timeoutMs,
      max_stdout_chars: normalized.maxStdoutChars,
    };
    child.stdin?.end(JSON.stringify(envelope));
    // Child startup is separate from script/op execution; do not make a
    // 25ms tool budget impossible to use on a cold Node process.
    await withTimeout(connected, Math.max(normalized.timeoutMs, 5_000), 'child connection timeout');
    const exit = await withTimeout(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child?.once('error', reject);
        child?.once('exit', (code, signal) => resolve({ code, signal }));
      }),
      normalized.timeoutMs,
      'script timeout'
    );
    const output = parseRunnerOutput(stdout);
    if (!output.ok) throw new Error(output.error || '[PTC_RUNNER] script failed.');
    if (exit.code !== 0) {
      throw new Error(
        `[PTC_RUNNER] child failed (${exit.code ?? exit.signal ?? 'unknown'}): ${stderr.slice(0, 500)}`
      );
    }
    const result = String(output.stdout || '');
    if (result.length > normalized.maxStdoutChars) {
      throw new Error('[PTC_LIMIT] stdout size exceeded.');
    }
    return {
      stdout: result,
      calls: callCount,
      granted_ops: normalizeOps(options.request.granted_ops),
      effective_ops: normalized.effectiveOps,
    };
  } finally {
    child?.kill();
    connection?.destroy();
    server.close();
    if (safeExistsSync(socketPath)) safeUnlinkSync(socketPath);
  }
}
