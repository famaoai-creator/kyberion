import { EventEmitter } from 'node:events';
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_PEER_HEADER,
  attestLocalPeer,
  isLocalAuthority,
  stripUntrustedPeerHeaders,
  verifiedLocalPeerAddress,
} from '../server/local-peer.ts';
import { createLocalConciergeServer, parseLocalServerOptions } from '../server/local-server.ts';
import { isLoopbackPeer } from '../src/lib/loopback-peer';
import { withLocalPeerRequest } from './local-peer-fixture';

const servers: Server[] = [];
function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode!));
    });
    req.once('error', reject);
    req.end();
  });
}
async function listen(handle: (req: IncomingMessage, res: ServerResponse) => unknown) {
  const server = createLocalConciergeServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  expect(address.address).toBe('127.0.0.1');
  return { server, port: address.port, url: 'http://127.0.0.1:' + address.port };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    )
  );
});

describe('explicit local Concierge adapter', () => {
  it('preserves repeated guards only during the request lifetime and target', () => {
    let captured: NextRequest | undefined;
    withLocalPeerRequest(new NextRequest('http://localhost:3050/api/local?x=1'), (request) => {
      captured = request;
      expect(verifiedLocalPeerAddress(request)).toBe('127.0.0.1');
      expect(isLoopbackPeer(request)).toBe(true);
      expect(isLoopbackPeer(request)).toBe(true);
      expect(
        isLoopbackPeer(
          new NextRequest('http://localhost:3050/api/other', { headers: request.headers })
        )
      ).toBe(false);
      expect(
        isLoopbackPeer(new NextRequest(request.url, { method: 'POST', headers: request.headers }))
      ).toBe(false);
    });
    expect(isLoopbackPeer(captured!)).toBe(false);
  });

  it('accepts Next-normalized query encodings while preserving duplicate-value order', () => {
    const path = 'http://localhost:3050/api/local';
    withLocalPeerRequest(
      new NextRequest(path + '?sample=a%20b%2bc&tag=first&unicode=%E6%97%A5&tag=second'),
      (request) => {
        const equivalent = new NextRequest(
          path + '?tag=first&tag=second&sample=a+b%2Bc&unicode=%E6%97%A5',
          { headers: request.headers }
        );
        expect(isLoopbackPeer(equivalent)).toBe(true);
        expect(
          isLoopbackPeer(
            new NextRequest(path + '?sample=a+b%2Bc&tag=second&tag=first&unicode=%E6%97%A5', {
              headers: request.headers,
            })
          )
        ).toBe(false);
        expect(
          isLoopbackPeer(
            new NextRequest(path + '?sample=a+b+c&tag=first&tag=second&unicode=%E6%97%A5', {
              headers: request.headers,
            })
          )
        ).toBe(false);
      }
    );
  });

  it('expires even a response that has not closed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    withLocalPeerRequest(new NextRequest('http://localhost:3050/api/local'), (request) => {
      vi.setSystemTime(Date.now() + 30_001);
      expect(isLoopbackPeer(request)).toBe(false);
    });
  });

  it('accepts an actual loopback HTTP peer without IP headers and replaces a forged proof', async () => {
    let captured: NextRequest | undefined;
    const { url } = await listen((req, res) => {
      captured = new NextRequest('http://' + req.headers.host + req.url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
      });
      expect(req.headers['x-real-ip']).toBeUndefined();
      expect(captured.headers.get(LOCAL_PEER_HEADER)).not.toBe('forged');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          local: isLoopbackPeer(captured),
          address: verifiedLocalPeerAddress(captured),
        })
      );
    });
    const response = await fetch(url + '/api/local', {
      headers: { [LOCAL_PEER_HEADER]: 'forged' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ local: true, address: '127.0.0.1' });
    expect(response.headers.has(LOCAL_PEER_HEADER)).toBe(false);
    expect(isLoopbackPeer(captured!)).toBe(false);
  });

  it('rejects DNS-rebinding hosts and proxy/tunnel provenance before the handler', async () => {
    const handler = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end('unexpected'));
    const { url, port } = await listen(handler);
    for (const host of [
      'attacker.example:' + port,
      'localhost.attacker:' + port,
      '127.0.0.1:' + (port + 1),
    ]) {
      expect(await requestStatus(url, { host })).toBe(403);
    }
    for (const name of [
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-real-ip',
      'cf-connecting-ip',
      'tailscale-user-login',
      'ngrok-agent-ips',
    ]) {
      expect((await fetch(url, { headers: { [name]: '127.0.0.1' } })).status).toBe(403);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('guards upgrades before any handler registered by Next can run', () => {
    const server = createLocalConciergeServer(() => {}, { port: 3050 });
    const upgrade = vi.fn();
    server.on('upgrade', upgrade);
    const socket = { destroy: vi.fn() };
    const req = {
      method: 'GET',
      url: '/_next/webpack-hmr',
      headers: { host: 'attacker.example:3050' },
      rawHeaders: [],
      socket: { remoteAddress: '127.0.0.1' },
    };
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(upgrade).not.toHaveBeenCalled();
    req.headers.host = 'localhost:3050';
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    expect(upgrade).toHaveBeenCalledOnce();
  });

  it('rejects non-loopback raw peers and ignores spoofable header-only authority', () => {
    const req = {
      method: 'GET',
      url: '/',
      socket: { remoteAddress: '192.0.2.5' },
      headers: {},
      rawHeaders: [],
    } as unknown as IncomingMessage;
    expect(() => attestLocalPeer(req, new EventEmitter() as ServerResponse)).toThrow(
      /loopback socket/
    );
    vi.stubEnv('KYBERION_TRUST_PROXY', 'true');
    expect(
      isLoopbackPeer(
        new NextRequest('http://localhost:3050/', {
          headers: {
            'x-real-ip': '127.0.0.1',
            'x-forwarded-for': '::1',
            [LOCAL_PEER_HEADER]: 'a'.repeat(43),
          },
        })
      )
    ).toBe(false);
  });

  it('removes original proxy fields from both header representations', () => {
    const req = {
      headers: { host: 'localhost:3050', 'x-real-ip': '127.0.0.1', [LOCAL_PEER_HEADER]: 'forged' },
      rawHeaders: ['Host', 'localhost:3050', 'X-Real-IP', '127.0.0.1', LOCAL_PEER_HEADER, 'forged'],
    } as unknown as IncomingMessage;
    expect(stripUntrustedPeerHeaders(req)).toBe(true);
    expect(req.headers).toEqual({ host: 'localhost:3050' });
    expect(req.rawHeaders).toEqual(['Host', 'localhost:3050']);
  });

  it('requires an explicit local authority and bounded startup arguments', () => {
    expect(parseLocalServerOptions([])).toEqual({ port: 3050, dev: false });
    expect(parseLocalServerOptions(['--dev', '--port', '3051'])).toEqual({ port: 3051, dev: true });
    for (const args of [
      ['--host', '0.0.0.0'],
      ['--port', '0'],
      ['--port', '65536'],
      ['--port', '12abc'],
    ]) {
      expect(() => parseLocalServerOptions(args)).toThrow();
    }
    expect(isLocalAuthority('localhost:3050', 3050)).toBe(true);
    expect(isLocalAuthority('[::1]:3050', 3050)).toBe(true);
    expect(isLocalAuthority('127.0.0.1:3050', 3050)).toBe(true);
    expect(isLocalAuthority('localhost', 3050)).toBe(false);
    expect(isLocalAuthority('localhost.:3050', 3050)).toBe(false);
  });
});
