import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPeerRuntime,
  createPeerMessagingServer,
  listPeerInboxRecords,
  buildPeerMessageEnvelope,
} from './peer-messaging.js';
import { pathResolver, safeReadFile, safeRmSync } from './index.js';
import { clearMeshHubPeerMessagingAdapterNamespace, createMeshHubPeerMessagingAdapter } from './mesh-hub-peer-messaging-adapter.js';
import type { MeshRequest } from './mesh-hub-contract.js';

const ROOT = pathResolver.rootDir();
const TEST_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub-adapter-tests';
const TEST_RUNTIME_ROOT_ABS = path.join(ROOT, TEST_RUNTIME_ROOT);

function buildRequest(
  requestId: string,
  requestKind: MeshRequest['request_kind'],
  selector: MeshRequest['target']['selector'],
): MeshRequest {
  return {
    kind: 'mesh-request',
    request_id: requestId,
    tenant_scope: {
      tenant_id: 'tenant-acme',
      scope: 'same_tenant',
    },
    sender_peer_id: 'peer-sender',
    created_at: '2026-06-24T00:03:00.000Z',
    ttl_ms: 60_000,
    idempotency_key: `idem-${requestId}`,
    correlation_id: `corr-${requestId}`,
    request_kind: requestKind,
    target: {
      selector,
    },
    payload: {
      classification: 'confidential',
      reference: {
        artifact_ref: 'artifact://tenant-acme/review-brief',
        integrity_hash: 'shared-adapter-secret',
        storage_class: 'artifact_store',
      },
    },
  };
}

describe('mesh-hub-peer-messaging-adapter', () => {
  beforeEach(() => {
    process.env.KYBERION_MESH_HUB_RUNTIME_ROOT = TEST_RUNTIME_ROOT;
    process.env.KYBERION_MESH_HUB_OBSERVABILITY_ROOT = TEST_RUNTIME_ROOT.replace('runtime', 'observability');
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
    clearMeshHubPeerMessagingAdapterNamespace();
    clearPeerRuntime('peer-recipient');
  });

  afterEach(() => {
    clearPeerRuntime('peer-recipient');
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
    clearMeshHubPeerMessagingAdapterNamespace();
    vi.unstubAllGlobals();
  });

  it('dispatches a signed mesh request through peer-messaging', async () => {
    const adapter = createMeshHubPeerMessagingAdapter({
      peerId: 'peer-recipient',
      sharedSecret: 'recipient-secret',
      namespace: 'mesh-hub-adapter-tests',
    });
    let capturedEnvelope: any = null;
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      capturedEnvelope = JSON.parse(String(init.body || '{}'));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            accepted: true,
            processing_mode: 'synchronous_on_receive',
            response: {
              accepted: true,
              proposal: {
                proposal_kind: 'a2a',
                mission_controller_mutation: 'deny',
              },
            },
          }),
      } as any;
    });

    const receipt = await adapter.dispatchToPeer({
      recipient: {
        peer_id: 'peer-recipient',
        base_url: 'http://127.0.0.1:9999',
        shared_secret: 'recipient-secret',
        allow_local_network: true,
      },
      request: buildRequest(
        'meshreq-review',
        'review.request',
        {
          kind: 'peer',
          peer_id: 'peer-recipient',
        },
      ),
    });

    expect(receipt.ok).toBe(true);
    expect(receipt.accepted).toBe(true);
    expect(capturedEnvelope).toMatchObject({
      recipient_peer_id: 'peer-recipient',
      sender_peer_id: 'peer-recipient',
      type: 'request',
      payload: {
        request_id: 'meshreq-review',
      },
      signature: expect.any(String),
    });
  });

  it('stores validated review requests as A2A proposals without mission mutation', async () => {
    const adapter = createMeshHubPeerMessagingAdapter({
      peerId: 'peer-recipient',
      sharedSecret: 'recipient-secret',
      namespace: 'mesh-hub-adapter-tests',
    });
    const server = createPeerMessagingServer({
      peerId: 'peer-recipient',
      sharedSecret: 'recipient-secret',
      responder: adapter.createResponder(),
    });
    const envelope = buildPeerMessageEnvelope({
      senderPeerId: 'peer-recipient',
      recipientPeerId: 'peer-recipient',
      subject: 'mesh.review.request',
      type: 'request',
      payload: buildRequest(
        'meshreq-review',
        'review.request',
        {
          kind: 'peer',
          peer_id: 'peer-recipient',
        },
      ),
      sharedSecret: 'recipient-secret',
      conversationId: 'corr-meshreq-review',
      correlationId: 'corr-meshreq-review',
      ttlMs: 60_000,
    });

    const result = await server.processEnvelope(envelope);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      accepted: true,
      response: {
        accepted: true,
        proposal: {
          proposal_kind: 'a2a',
          mission_controller_mutation: 'deny',
        },
      },
    });

    const inbox = listPeerInboxRecords('peer-recipient');
    expect(inbox).toHaveLength(1);

    const proposalsPath = path.join(ROOT, TEST_RUNTIME_ROOT, 'mesh-hub-adapter-tests', 'adapters', 'peer-recipient', 'proposals.jsonl');
    const proposals = String(safeReadFile(proposalsPath, { encoding: 'utf8' }) || '')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      peer_id: 'peer-recipient',
      request_kind: 'review.request',
      proposal_kind: 'a2a',
      mission_controller_mutation: 'deny',
    });
  });

  it('turns workitem requests into stored WorkItem proposals and never auto-executes missions', async () => {
    const adapter = createMeshHubPeerMessagingAdapter({
      peerId: 'peer-recipient',
      sharedSecret: 'recipient-secret',
      namespace: 'mesh-hub-adapter-tests',
    });
    const server = createPeerMessagingServer({
      peerId: 'peer-recipient',
      sharedSecret: 'recipient-secret',
      responder: adapter.createResponder(),
    });
    const envelope = buildPeerMessageEnvelope({
      senderPeerId: 'peer-recipient',
      recipientPeerId: 'peer-recipient',
      subject: 'mesh.workitem.claim',
      type: 'request',
      payload: buildRequest(
        'meshreq-workitem',
        'workitem.claim',
        {
          kind: 'peer',
          peer_id: 'peer-recipient',
        },
      ),
      sharedSecret: 'recipient-secret',
      conversationId: 'corr-meshreq-workitem',
      correlationId: 'corr-meshreq-workitem',
      ttlMs: 60_000,
    });

    const result = await server.processEnvelope(envelope);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      accepted: true,
      response: {
        accepted: true,
        proposal: {
          proposal_kind: 'workitem',
          mission_controller_mutation: 'deny',
        },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('dist/scripts/mission_controller.js');
  });
});
