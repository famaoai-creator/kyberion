/* HA-04: isolated child for Programmatic Tool Calling. */
import * as net from 'node:net';
import * as vm from 'node:vm';

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
        resolve(JSON.parse(data) as RunnerEnvelope);
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
      const response = JSON.parse(line) as RpcResponse;
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

main()
  .catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  })
  .finally(() => {
    activeSocket?.destroy();
  });
