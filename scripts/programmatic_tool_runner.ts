/* HA-04: isolated child for Programmatic Tool Calling. */
import * as net from 'node:net';
import * as vm from 'node:vm';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

interface RunnerEnvelope {
  socket_path: string;
  token: string;
  code: string;
  effective_ops: string[];
  max_calls: number;
  timeout_ms: number;
  max_stdout_chars: number;
}

interface RpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[PTC_RUNNER] ${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`[PTC_RUNNER] ${label} must be a positive integer.`);
  }
  return value;
}

function normalizeRunnerEnvelope(value: unknown): RunnerEnvelope {
  if (!isJsonRecord(value)) throw new Error('[PTC_RUNNER] envelope must be a JSON object.');
  const socketPath = requiredString(value.socket_path, 'envelope.socket_path');
  const token = requiredString(value.token, 'envelope.token');
  const code = requiredString(value.code, 'envelope.code');
  const rawOps = value.effective_ops;
  if (!Array.isArray(rawOps)) {
    throw new Error('[PTC_RUNNER] envelope.effective_ops must be a string array.');
  }
  const effectiveOps = rawOps.filter(
    (op): op is string => typeof op === 'string' && op.trim().length > 0
  );
  if (effectiveOps.length !== rawOps.length) {
    throw new Error('[PTC_RUNNER] envelope.effective_ops must be a string array.');
  }
  return {
    socket_path: socketPath,
    token,
    code,
    effective_ops: effectiveOps,
    max_calls: positiveInteger(value.max_calls, 'envelope.max_calls'),
    timeout_ms: positiveInteger(value.timeout_ms, 'envelope.timeout_ms'),
    max_stdout_chars: positiveInteger(value.max_stdout_chars, 'envelope.max_stdout_chars'),
  };
}

function normalizeRpcResponse(value: unknown): RpcResponse {
  if (!isJsonRecord(value)) throw new Error('[PTC_RPC] response must be a JSON object.');
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error('[PTC_RPC] response id must be a non-empty string.');
  }
  if (typeof value.ok !== 'boolean') throw new Error('[PTC_RPC] response ok must be boolean.');
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new Error('[PTC_RPC] response error must be a string.');
  }
  return {
    id: value.id,
    ok: value.ok,
    result: value.result,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

let activeSocket: net.Socket | undefined;

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readEnvelope(): Promise<RunnerEnvelope> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += String(chunk);
    });
    process.stdin.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(data);
        resolve(normalizeRunnerEnvelope(parsed));
      } catch {
        reject(new Error('[PTC_RUNNER] invalid envelope.'));
      }
    });
    process.stdin.on('error', reject);
  });
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function rpc(
  socket: net.Socket,
  envelope: RunnerEnvelope,
  op: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      const parsed: unknown = JSON.parse(line);
      const response = normalizeRpcResponse(parsed);
      if (response.id !== id) return;
      socket.off('data', onData);
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error || '[PTC_RPC] op failed.'));
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(
      `${JSON.stringify({ token: envelope.token, id, method: 'call_op', op, params })}\n`
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('[PTC_LIMIT] script timeout.')), timeoutMs);
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

async function main(): Promise<void> {
  const envelope = await readEnvelope();
  const socket = await connect(envelope.socket_path);
  activeSocket = socket;
  const output: string[] = [];
  let outputChars = 0;
  const append = (...values: unknown[]) => {
    const line = values.map(serialize).join(' ');
    outputChars += line.length + 1;
    if (outputChars > envelope.max_stdout_chars) {
      throw new Error('[PTC_LIMIT] stdout size exceeded.');
    }
    output.push(line);
  };
  const callOp = async (op: string, params: Record<string, unknown> = {}) => {
    return rpc(socket, envelope, op, params);
  };
  const tools = Object.fromEntries(
    envelope.effective_ops.map((op) => [
      op,
      (params: Record<string, unknown> = {}) => callOp(op, params),
    ])
  );
  const context = vm.createContext(
    {
      callOp,
      tools,
      console: { log: append, info: append, warn: append, error: append },
      JSON,
      Math,
      Date,
      String,
      Number,
      Boolean,
      Array,
      Object,
    },
    { codeGeneration: { strings: false, wasm: false } }
  );
  await withTimeout(
    Promise.resolve(
      new vm.Script(`(async () => {\n${envelope.code}\n})()`).runInContext(context, {
        timeout: envelope.timeout_ms,
      })
    ),
    envelope.timeout_ms
  );
  socket.end();
  process.stdout.write(`${JSON.stringify({ ok: true, stdout: output.join('\n'), calls: 0 })}\n`);
}

async function executeProgrammaticToolRunner(): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    throw new ScriptExitError(1, '', true);
  } finally {
    activeSocket?.destroy();
  }
}

export const runProgrammaticToolRunner = defineScript({
  name: 'programmatic-tool-runner',
  flags: [],
  run: () => executeProgrammaticToolRunner(),
});

if (
  isDirectScript(import.meta.url, 'programmatic_tool_runner.ts') ||
  isDirectScript(import.meta.url, 'programmatic_tool_runner.js')
)
  void runProgrammaticToolRunner();
