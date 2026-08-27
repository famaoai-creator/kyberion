import { createStandardYargs, logger } from '@agent/core';
import {
  assertProtocolServiceRegistered,
  createPeerMessagingServer,
  recordProtocolServiceLifecycle,
  type PeerMessageEnvelope,
} from '@agent/core';
import { getRegisteredEnvText } from '@agent/core/foundation';

async function main(): Promise<void> {
  assertProtocolServiceRegistered('peer-messaging');
  const argv = await createStandardYargs()
    .option('peer-id', {
      type: 'string',
      demandOption: true,
      description: 'Logical peer identifier for this Kyberion instance',
    })
    .option('port', {
      type: 'number',
      default: Number(getRegisteredEnvText('KYBERION_PEER_PORT') || 4100),
      description: 'HTTP port to bind',
    })
    .option('host', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_PEER_HOST') || '127.0.0.1',
      description: 'HTTP bind host (use 0.0.0.0 for LAN reachability)',
    })
    .option('shared-secret', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_PEER_SHARED_SECRET') || '',
      description: 'HMAC shared secret used to verify inbound messages',
    })
    .option('tenant-id', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_TENANT_ID') || '',
      description: 'Tenant scope for this peer listener',
    })
    .option('echo', {
      type: 'boolean',
      default: true,
      description: 'Return a small echo payload for inbound requests',
    })
    .parseSync();

  const peerId = String(argv['peer-id']);
  const sharedSecret = String(argv['shared-secret'] || '');
  const tenantId = String(argv['tenant-id'] || '').trim();
  if (!sharedSecret) {
    throw new Error(
      'Missing peer shared secret. Set KYBERION_PEER_SHARED_SECRET or pass --shared-secret.'
    );
  }
  if (!tenantId) throw new Error('Missing tenant id. Set KYBERION_TENANT_ID or pass --tenant-id.');

  const server = createPeerMessagingServer({
    peerId,
    tenantId,
    sharedSecret,
    responder: async ({ envelope }: { envelope: PeerMessageEnvelope }) => {
      if (!argv.echo) {
        return { received: true, peer_id: peerId };
      }
      return {
        received: true,
        peer_id: peerId,
        message_id: envelope.message_id,
        conversation_id: envelope.conversation_id,
        subject: envelope.subject,
        type: envelope.type,
        payload: envelope.payload,
      };
    },
  });

  await server.listen(Number(argv.port), String(argv.host));
  recordProtocolServiceLifecycle({
    serviceId: 'peer-messaging',
    action: 'start',
    status: 'started',
    scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenantId },
    principal: { kind: 'service', id: peerId },
    requestedBy: peerId,
    metadata: { host: String(argv.host), port: Number(argv.port) },
  });
  logger.success(
    `[peer-messaging-server] peer ${peerId} listening on http://${String(argv.host)}:${Number(argv.port)}`
  );

  const shutdown = async () => {
    try {
      recordProtocolServiceLifecycle({
        serviceId: 'peer-messaging',
        action: 'stop',
        status: 'stopped',
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenantId },
        principal: { kind: 'service', id: peerId },
        requestedBy: peerId,
      });
    } finally {
      await server.close();
      process.exitCode = 0;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: any) => {
  logger.error(error?.message || String(error));
  process.exitCode = 1;
});
