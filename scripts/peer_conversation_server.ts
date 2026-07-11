import { createStandardYargs, logger } from '@agent/core';
import {
  advertiseMeshCapabilities,
  createMeshHubPeerMessagingAdapter,
  createPeerConversationResponder,
  createPeerMessagingServer,
  recordMeshHeartbeat,
  registerMeshPeer,
  type MeshRequest,
} from '@agent/core';

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('peer-id', {
      type: 'string',
      demandOption: true,
      description: 'Logical peer identifier for this Kyberion instance',
    })
    .option('port', {
      type: 'number',
      default: Number(process.env.KYBERION_PEER_PORT || 4100),
      description: 'HTTP port to bind',
    })
    .option('host', {
      type: 'string',
      default: process.env.KYBERION_PEER_HOST || '127.0.0.1',
      description: 'HTTP bind host (use 0.0.0.0 for LAN reachability)',
    })
    .option('shared-secret', {
      type: 'string',
      default: process.env.KYBERION_PEER_SHARED_SECRET || '',
      description: 'HMAC shared secret used to verify inbound messages',
    })
    .option('tenant-id', {
      type: 'string',
      default: process.env.KYBERION_TENANT_ID || '',
      description: 'Enable Mesh presence for this same-tenant peer',
    })
    .option('key-ref', {
      type: 'string',
      default: process.env.KYBERION_PEER_KEY_REF || 'env:KYBERION_PEER_SHARED_SECRET',
      description: 'Secret reference recorded in Mesh enrollment (never the secret value)',
    })
    .option('mesh-namespace', {
      type: 'string',
      default: process.env.KYBERION_MESH_NAMESPACE || '',
      description: 'Optional isolated Mesh Hub namespace',
    })
    .option('heartbeat-ms', {
      type: 'number',
      default: 10_000,
      description: 'Mesh presence heartbeat interval',
    })
    .option('presence-ttl-ms', {
      type: 'number',
      default: 30_000,
      description: 'Mesh presence freshness window',
    })
    .parseSync();

  const peerId = String(argv['peer-id']);
  const sharedSecret = String(argv['shared-secret'] || '');
  if (!sharedSecret) {
    throw new Error(
      'Missing peer shared secret. Set KYBERION_PEER_SHARED_SECRET or pass --shared-secret.'
    );
  }

  const host = String(argv.host);
  const port = Number(argv.port);
  const tenantId = String(argv['tenant-id'] || '').trim();
  const meshNamespace = String(argv['mesh-namespace'] || '').trim() || undefined;
  const meshAdapter = createMeshHubPeerMessagingAdapter({
    peerId,
    sharedSecret,
    namespace: meshNamespace,
  });

  const server = createPeerMessagingServer({
    peerId,
    sharedSecret,
    responder: createPeerConversationResponder({
      peerId,
      onMessage: ({ message, envelope }) => {
        const candidate = message.metadata?.collaboration_request as MeshRequest | undefined;
        if (!candidate || message.kind !== 'handoff') return;
        if (!tenantId) throw new Error('mesh_collaboration_requires_tenant_id');
        if (candidate.sender_peer_id !== envelope.sender_peer_id) {
          throw new Error(`mesh_collaboration_sender_mismatch:${candidate.request_id}`);
        }
        if (candidate.tenant_scope?.tenant_id !== tenantId) {
          throw new Error(`mesh_collaboration_tenant_mismatch:${candidate.request_id}`);
        }
        const proposal = meshAdapter.proposeLocalRequest(candidate, envelope.message_id);
        return {
          reply: {
            message_id: `PCR-${proposal.proposal_id}`,
            kind: 'reply',
            direction: 'outbound',
            sender_peer_id: peerId,
            recipient_peer_id: envelope.sender_peer_id,
            text: `Transport accepted; proposal ${proposal.proposal_id} is pending local acceptance.`,
            created_at: new Date().toISOString(),
            related_work_item_ids: message.related_work_item_ids,
            payload: {
              proposal_id: proposal.proposal_id,
              proposal_status: 'pending',
              request_id: proposal.request_id,
              mission_controller_mutation: 'deny',
            },
          },
        };
      },
    }),
  });

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeat = (health: 'healthy' | 'maintenance' = 'healthy') => {
    if (!tenantId) return;
    const now = Date.now();
    recordMeshHeartbeat({
      peer_id: peerId,
      tenant_id: tenantId,
      heartbeat_at: new Date(now),
      expires_at: new Date(health === 'maintenance' ? now : now + Number(argv['presence-ttl-ms'])),
      health,
      capacity: { accepting_new_work: health === 'healthy' },
      receive_modes: ['request', 'capability_query', 'workitem'],
    });
  };

  if (tenantId) {
    const endpointHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const allowedRequestKinds = [
      'review.request',
      'workitem.claim',
      'workitem.handoff',
      'workitem.status_update',
      'capability.query',
      'notification.publish',
    ] as const;
    registerMeshPeer({
      peer_id: peerId,
      tenant_id: tenantId,
      endpoint_ref: `http://${endpointHost}:${port}`,
      key_ref: String(argv['key-ref']),
      allowed_request_kinds: [...allowedRequestKinds],
      authority_role: 'infrastructure_sentinel',
    });
    advertiseMeshCapabilities({
      peer_id: peerId,
      tenant_id: tenantId,
      capability_id: 'peer.collaboration',
      version: '1.0.0',
      roles: ['collaboration-peer'],
      request_kinds: [...allowedRequestKinds],
    });
    heartbeat();
    heartbeatTimer = setInterval(() => heartbeat(), Number(argv['heartbeat-ms']));
  }

  await server.listen(port, host);
  logger.success(`[peer-conversation-server] peer ${peerId} listening on http://${host}:${port}`);

  const shutdown = async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeat('maintenance');
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: any) => {
  logger.error(error?.message || String(error));
  process.exit(1);
});
