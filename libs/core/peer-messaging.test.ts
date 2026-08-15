import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';

import {
  buildPeerMessageEnvelope,
  clearPeerRuntime,
  createPeerMessagingServer,
  loadPeerNetworkCatalog,
  listPeerInboxRecords,
  listPeerOutboxRecords,
  registerPeerNetworkPeer,
  peerNetworkCatalogPath,
  resolvePeerRecord,
  resolvePeerDispatchTarget,
  sendPeerMessage,
  signPeerHttpRequest,
  verifyPeerMessage,
} from './peer-messaging.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

const SHARED_SECRET = 'peer-message-test-secret';
const TENANT_ID = 'tenant-acme';
const REGISTRY_TENANT = 'peer-registry-test';
const REGISTRY_TEST_CATALOG = pathResolver.sharedTmp('peer-network-registration.test.json');

async function listenOnEphemeralPort(
  server: ReturnType<typeof createPeerMessagingServer>
): Promise<number> {
  const httpServer = await server.listen(0);
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('missing_test_server_address');
  return address.port;
}

afterEach(() => {
  clearPeerRuntime(TENANT_ID, 'peer-a-test');
  clearPeerRuntime(TENANT_ID, 'peer-b-test');
  const catalogPath = pathResolver.sharedTmp('peer-network-catalog.test.json');
  try {
    safeRmSync(catalogPath, { force: true });
  } catch (_) {
    /* best-effort cleanup */
  }
  try {
    safeRmSync(REGISTRY_TEST_CATALOG, { force: true });
  } catch (_) {
    /* best-effort cleanup */
  }
});

describe('peer messaging', () => {
  it.each(['public', 'confidential', 'personal', 'shared'])(
    'rejects reserved scope name %s as a peer tenant',
    (tenantId) => {
      expect(() => peerNetworkCatalogPath(tenantId)).toThrow(/invalid_peer_network_tenant_id/);
    }
  );

  it('rejects a catalog that declares a reserved tenant id', () => {
    safeWriteFile(
      REGISTRY_TEST_CATALOG,
      JSON.stringify({ version: '1', tenant_id: 'public', peers: [] })
    );
    expect(loadPeerNetworkCatalog({ catalogPath: REGISTRY_TEST_CATALOG })).toBeNull();
  });

  it('validates tenant selection even when an explicit catalog path is supplied', () => {
    expect(() =>
      loadPeerNetworkCatalog({
        catalogPath: REGISTRY_TEST_CATALOG,
        tenantId: 'public',
      })
    ).toThrow(/invalid_peer_network_tenant_id/);
  });

  it('builds and verifies signed peer envelopes', () => {
    const envelope = buildPeerMessageEnvelope({
      senderPeerId: 'peer-a-test',
      recipientPeerId: 'peer-b-test',
      tenantId: TENANT_ID,
      subject: 'handoff',
      type: 'handoff',
      payload: { summary: 'transfer this task' },
      sharedSecret: SHARED_SECRET,
    });

    expect(envelope.signature).toBeTruthy();
    expect(verifyPeerMessage(envelope, SHARED_SECRET)).toBe(true);
    expect(
      verifyPeerMessage({ ...envelope, payload: { summary: 'tampered' } }, SHARED_SECRET)
    ).toBe(false);
  });

  it('rejects a correctly signed envelope from another tenant', async () => {
    const server = createPeerMessagingServer({
      peerId: 'peer-b-test',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
    });
    const envelope = buildPeerMessageEnvelope({
      senderPeerId: 'peer-a-test',
      recipientPeerId: 'peer-b-test',
      tenantId: 'tenant-bravo',
      subject: 'cross-tenant',
      type: 'request',
      payload: { secret: 'must-not-be-processed' },
      sharedSecret: SHARED_SECRET,
    });

    const result = await server.processEnvelope(envelope);
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, error: 'tenant_mismatch' });
    expect(JSON.stringify(listPeerInboxRecords(TENANT_ID, 'peer-b-test'))).not.toContain(
      'must-not-be-processed'
    );
  });

  it('delivers a localhost peer message and persists inbox/outbox logs', async () => {
    const server = createPeerMessagingServer({
      peerId: 'peer-b-test',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      responder: async ({ envelope }) => ({
        received: true,
        peer_id: 'peer-b-test',
        reply_to: envelope.message_id,
        subject: envelope.subject,
      }),
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input: any, init?: RequestInit) => {
        const envelope = JSON.parse(String(init?.body || '{}')) as Parameters<
          typeof server.processEnvelope
        >[0];
        const result = await server.processEnvelope(envelope);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
          },
        });
      });

    const envelope = buildPeerMessageEnvelope({
      senderPeerId: 'peer-a-test',
      recipientPeerId: 'peer-b-test',
      tenantId: TENANT_ID,
      subject: 'status_request',
      type: 'request',
      payload: { ask: 'are you there?' },
      sharedSecret: SHARED_SECRET,
      conversationId: 'conv-peer-test',
    });

    const receipt = await sendPeerMessage(envelope, {
      destinationUrl: 'http://127.0.0.1:4555',
      allowLocalNetwork: true,
      timeoutMs: 5000,
    });

    expect(receipt.ok).toBe(true);
    expect(receipt.status).toBe(200);
    expect(receipt.accepted).toBe(true);
    expect(receipt.processing_mode).toBe('synchronous_on_receive');
    expect(receipt.processed_at).toBeTruthy();
    expect(receipt.response).toMatchObject({
      received: true,
      peer_id: 'peer-b-test',
      reply_to: envelope.message_id,
    });

    const inbox = listPeerInboxRecords(TENANT_ID, 'peer-b-test');
    const outbox = listPeerOutboxRecords(TENANT_ID, 'peer-a-test');
    expect(inbox).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect((inbox[0] as any).envelope.message_id).toBe(envelope.message_id);
    expect((outbox[0] as any).envelope.recipient_peer_id).toBe('peer-b-test');
    fetchSpy.mockRestore();
  });

  it('resolves peer catalog entries that point at LAN endpoints', () => {
    const catalogPath = pathResolver.sharedTmp('peer-network-catalog.test.json');
    safeWriteFile(
      catalogPath,
      JSON.stringify(
        {
          version: '1',
          peers: [
            {
              peer_id: 'peer-b-test',
              base_url: 'http://192.168.1.20:4555',
              shared_secret: SHARED_SECRET,
              allow_local_network: true,
              capabilities: ['handoff', 'request'],
            },
          ],
        },
        null,
        2
      )
    );

    const catalog = loadPeerNetworkCatalog({ catalogPath });
    expect(catalog).not.toBeNull();
    const peer = resolvePeerRecord('peer-b-test', catalog);
    expect(peer).toMatchObject({
      peer_id: 'peer-b-test',
      base_url: 'http://192.168.1.20:4555',
      allow_local_network: true,
    });

    const target = resolvePeerDispatchTarget('peer-b-test', catalog);
    expect(target.destinationUrl).toBe('http://192.168.1.20:4555');
    expect(target.allowLocalNetwork).toBe(true);
    expect(target.sharedSecret).toBe(SHARED_SECRET);
  });

  it('registers a peer in the tenant confidential catalog and records exposure', () => {
    const result = registerPeerNetworkPeer({
      tenantId: REGISTRY_TENANT,
      peerId: 'peer-b-test',
      baseUrl: 'http://127.0.0.1:4555',
      sharedSecret: SHARED_SECRET,
      exposure: 'same_host',
      catalogPath: REGISTRY_TEST_CATALOG,
      capabilities: ['handoff'],
    });

    expect(result.catalogPath).toBe(REGISTRY_TEST_CATALOG);
    expect(result.catalog.catalog_visibility).toBe('tenant_confidential');
    expect(result.peer.exposure).toBe('same_host');

    const catalog = loadPeerNetworkCatalog({
      tenantId: REGISTRY_TENANT,
      catalogPath: REGISTRY_TEST_CATALOG,
    });
    const target = resolvePeerDispatchTarget('peer-b-test', catalog);
    expect(target.allowLocalNetwork).toBe(true);
    expect(target.sharedSecret).toBe(SHARED_SECRET);
  });

  it('rejects a private endpoint when the registered exposure is public_network', () => {
    expect(() =>
      registerPeerNetworkPeer({
        tenantId: REGISTRY_TENANT,
        peerId: 'peer-b-test',
        baseUrl: 'http://192.168.1.20:4555',
        sharedSecret: SHARED_SECRET,
        exposure: 'public_network',
      })
    ).toThrow(/Blocked URL|private/i);
  });

  it('requires a valid HMAC request signature for inbox and outbox reads', async () => {
    const server = createPeerMessagingServer({
      peerId: 'peer-b-test',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
    });
    const port = await listenOnEphemeralPort(server);

    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toEqual({ ok: true });

      for (const requestPath of ['/v1/peer/messages/inbox', '/v1/peer/messages/outbox']) {
        const unauthorized = await fetch(`http://127.0.0.1:${port}${requestPath}`);
        expect(unauthorized.status).toBe(401);

        const invalid = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
          headers: {
            'x-kyberion-peer-signature': signPeerHttpRequest('GET', requestPath, 'wrong-secret'),
          },
        });
        expect(invalid.status).toBe(401);

        const authorized = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
          headers: {
            'x-kyberion-peer-signature': signPeerHttpRequest('GET', requestPath, SHARED_SECRET),
          },
        });
        expect(authorized.status).toBe(200);
        expect(await authorized.json()).toEqual({ ok: true, items: [] });
      }
    } finally {
      await server.close();
    }
  });

  it('rejects oversized request bodies from content-length and streamed bytes', async () => {
    const server = createPeerMessagingServer({
      peerId: 'peer-b-test',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
    });
    const port = await listenOnEphemeralPort(server);

    const sendRaw = (
      headers: http.OutgoingHttpHeaders,
      chunks: Buffer[]
    ): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const request = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/v1/peer/messages',
            method: 'POST',
            headers,
            agent: false,
          },
          (response) => {
            const responseChunks: Buffer[] = [];
            response.on('data', (chunk) => responseChunks.push(Buffer.from(chunk)));
            response.on('end', () =>
              resolve({
                status: response.statusCode || 0,
                body: Buffer.concat(responseChunks).toString('utf8'),
              })
            );
          }
        );
        request.on('error', reject);
        for (const chunk of chunks) request.write(chunk);
        request.end();
      });

    try {
      const declaredOversized = await sendRaw({ 'Content-Length': 1024 * 1024 + 1 }, []);
      expect(declaredOversized.status).toBe(413);
      expect(JSON.parse(declaredOversized.body)).toEqual({
        ok: false,
        error: 'request_body_too_large',
      });

      const streamedOversized = await sendRaw({ 'Transfer-Encoding': 'chunked' }, [
        Buffer.alloc(700_000, 0x61),
        Buffer.alloc(400_000, 0x62),
      ]);
      expect(streamedOversized.status).toBe(413);
      expect(JSON.parse(streamedOversized.body)).toEqual({
        ok: false,
        error: 'request_body_too_large',
      });
    } finally {
      await server.close();
    }
  });
});
