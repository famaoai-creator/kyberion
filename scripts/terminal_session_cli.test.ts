import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ACTUATOR_SERVE_RESULT_PREFIX } from '@agent/core/cli-utils';
import { resolveLocalIpcAddress } from '@agent/core';
import {
  inputForCli,
  parseServeResultLine,
  requestOn,
  shouldRemovePidFileForOwner,
  uniqueRequestId,
} from './terminal_session_cli.js';

/** Fake serve peer: parses NDJSON requests, answers with the real framing. */
function startStubServer(
  handler: (req: { id?: string; input?: unknown }) => Record<string, unknown> | null
): Promise<{ sockPath: string; server: net.Server }> {
  const sockPath = path.join(
    os.tmpdir(),
    `terminal-cli-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`
  );
  const address = resolveLocalIpcAddress(sockPath);
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const res = handler(JSON.parse(line) as { id?: string; input?: unknown });
        if (res !== null) conn.write(`${JSON.stringify(res)}\n`);
      }
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(address, () => resolve({ sockPath: address, server }));
  });
}

const servers: net.Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('terminal_session_cli serve framing', () => {
  it('keeps its result prefix in sync with the actuator serve loop', () => {
    // The bridge cannot import cli-utils (dependency-free boot); drift is
    // caught here instead.
    expect('@@kyberion-actuator-result@@').toBe(ACTUATOR_SERVE_RESULT_PREFIX);
  });

  it('extracts a framed response line and ignores actuator log noise', () => {
    const framed = `${ACTUATOR_SERVE_RESULT_PREFIX}{"id":"r1","ok":true,"result":{"sessions":[]}}`;
    expect(parseServeResultLine(framed)).toEqual({
      id: 'r1',
      ok: true,
      result: { sessions: [] },
    });
    expect(parseServeResultLine('[terminal-actuator] some boot log')).toBeNull();
    expect(parseServeResultLine(`${ACTUATOR_SERVE_RESULT_PREFIX}{"id":"r1","ok":tr`)).toBeNull();
  });

  it('generates unique request ids', () => {
    expect(uniqueRequestId()).not.toBe(uniqueRequestId());
  });
});

describe('terminal_session_cli input shaping', () => {
  it('wraps an action + params into the actuator input contract', () => {
    expect(inputForCli('spawn', { cwd: 'active/shared/tmp/x' }, undefined)).toEqual({
      action: 'spawn',
      params: { cwd: 'active/shared/tmp/x' },
    });
  });

  it('passes raw envelopes (e.g. computer_interaction) through untouched', () => {
    const envelope = {
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'poll_terminal' },
    };
    expect(inputForCli('poll', {}, envelope)).toEqual(envelope);
  });

  it('rejects a missing action when no raw input is given', () => {
    expect(() => inputForCli(undefined, {}, undefined)).toThrow('missing terminal action');
  });
});

describe('terminal_session_cli pidfile ownership', () => {
  it('preserves a daemon PID written by the winning named-pipe listener', () => {
    expect(shouldRemovePidFileForOwner(100, 200)).toBe(false);
    expect(shouldRemovePidFileForOwner(200, 200)).toBe(true);
    expect(shouldRemovePidFileForOwner(null, null)).toBe(true);
    expect(shouldRemovePidFileForOwner(100, undefined)).toBe(true);
  });
});

describe('terminal_session_cli request round-trip', () => {
  it('resolves with the framed response for a matching request', async () => {
    const { sockPath, server } = await startStubServer((req) => ({
      id: req.id,
      ok: true,
      result: { sessions: [] },
    }));
    servers.push(server);
    const res = await requestOn(sockPath, { action: 'list', params: {} }, 3000);
    expect(res.ok).toBe(true);
    expect((res.result as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('rejects on a malformed response line', async () => {
    const sockPath = path.join(
      os.tmpdir(),
      `terminal-cli-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`
    );
    const server = net.createServer((conn) => {
      conn.on('data', () => conn.write('this is not json\n'));
      conn.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(resolveLocalIpcAddress(sockPath), resolve));
    servers.push(server);
    await expect(requestOn(sockPath, { action: 'list' }, 3000)).rejects.toThrow(
      'malformed daemon response'
    );
  });

  it('rejects on request timeout when the daemon never answers', async () => {
    const { sockPath, server } = await startStubServer(() => null);
    servers.push(server);
    await expect(requestOn(sockPath, { action: 'list' }, 200)).rejects.toThrow('timed out');
  });

  it('rejects when the socket does not exist', async () => {
    const missing = path.join(os.tmpdir(), `terminal-cli-test-missing-${process.pid}.sock`);
    await expect(requestOn(missing, { action: 'list' }, 1000)).rejects.toThrow();
  });
});
