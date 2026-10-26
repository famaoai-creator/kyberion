import * as net from 'node:net';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { resolveLocalIpcAddress } from '../local-ipc.js';
import { spawnManagedProcess, stopManagedProcess } from '../managed-process.js';

describe('headless supervisor request settlement', () => {
  it.each(['invalid-result', 'closed-refresh', 'closed-ask', 'delayed-success'] as const)(
    'settles a real child top-level await on %s',
    async (mode) => {
      const scratch = pathResolver.sharedTmp('ipc-' + randomUUID().slice(0, 8));
      safeMkdir(scratch, { recursive: true });
      const socketPath = resolveLocalIpcAddress(path.join(scratch, 's.sock'));
      const peers = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        peers.add(socket);
        socket.once('close', () => peers.delete(socket));
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += String(chunk);
          if (!buffer.includes('\n')) return;
          const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          if (request.method === 'health') {
            socket.end(
              JSON.stringify({
                id: request.id,
                ok: true,
                result: {
                  ok: true,
                  pid: process.pid,
                  socket_path: socketPath,
                  code_stamp: Number.MAX_SAFE_INTEGER,
                },
              }) + '\n'
            );
          } else if (mode.startsWith('closed-')) socket.end();
          else {
            const respond = () =>
              socket.end(
                JSON.stringify({
                  id: request.id,
                  ok: true,
                  result:
                    mode === 'invalid-result'
                      ? { mode: 'soft' }
                      : { refreshed: true, reason: 'soft' },
                }) + '\n'
              );
            if (mode === 'delayed-success') setTimeout(respond, 150);
            else respond();
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const moduleUrl = pathToFileURL(
        path.resolve('libs/core/agent/agent-runtime-supervisor-client.ts')
      ).href;
      const source = `import { refreshAgentRuntimeViaDaemon, askAgentRuntimeViaDaemon } from ${JSON.stringify(moduleUrl)};
        try { const result = await ${mode === 'closed-ask' ? "askAgentRuntimeViaDaemon({ agentId: 'synthetic-agent', prompt: 'test', requestedBy: 'test' })" : "refreshAgentRuntimeViaDaemon('synthetic-agent', 'test')"};
          process.stdout.write(JSON.stringify({ status: 'resolved', result }) + '\\n');
        } catch (error) { process.stdout.write(JSON.stringify({ status: 'rejected', error: error.message }) + '\\n'); }`;
      const handle = spawnManagedProcess({
        resourceId: 'supervisor-client-process-' + randomUUID(),
        kind: 'worker',
        ownerId: 'supervisor-client-test',
        ownerType: 'test',
        command: process.execPath,
        args: [
          '--import',
          path.resolve('scripts/ts-loader.mjs'),
          '--input-type=module',
          '-e',
          source,
        ],
        spawnOptions: {
          cwd: process.cwd(),
          env: { ...process.env, KYBERION_AGENT_RUNTIME_SUPERVISOR_SOCKET_PATH: socketPath },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      });
      try {
        let output = '';
        let errors = '';
        handle.child.stdout?.on('data', (chunk) => {
          output += String(chunk);
        });
        handle.child.stderr?.on('data', (chunk) => {
          errors += String(chunk);
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Headless supervisor client did not settle: ' + errors)),
            30_000
          );
          handle.child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          handle.child.once('close', (code) => {
            clearTimeout(timeout);
            resolve(code);
          });
        });
        expect(code, output + errors).toBe(0);
        expect(output).toContain(
          mode === 'delayed-success' ? '"status":"resolved"' : '"status":"rejected"'
        );
        if (mode === 'invalid-result') expect(output).toContain('invalid_supervisor_response');
        if (mode.startsWith('closed-')) {
          expect(output).toContain('supervisor_response_closed');
          expect(output).toContain(
            mode === 'closed-ask' ? 'method=ask' : '[SUPERVISOR_PREASK_FAILED] method=refresh'
          );
          if (mode === 'closed-ask') expect(output).not.toContain('[SUPERVISOR_PREASK_FAILED]');
        }
      } finally {
        stopManagedProcess(handle.resourceId, handle.child);
        for (const peer of peers) peer.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        safeRmSync(scratch, { recursive: true, force: true });
      }
    },
    45_000
  );
});
