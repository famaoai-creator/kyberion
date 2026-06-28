import { createStandardYargs, logger } from '@agent/core';
import { createPeerMessagingServer, createPeerConversationResponder } from '@agent/core';

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
    .parseSync();

  const peerId = String(argv['peer-id']);
  const sharedSecret = String(argv['shared-secret'] || '');
  if (!sharedSecret) {
    throw new Error('Missing peer shared secret. Set KYBERION_PEER_SHARED_SECRET or pass --shared-secret.');
  }

  const server = createPeerMessagingServer({
    peerId,
    sharedSecret,
    responder: createPeerConversationResponder({ peerId }),
  });

  await server.listen(Number(argv.port), String(argv.host));
  logger.success(`[peer-conversation-server] peer ${peerId} listening on http://${String(argv.host)}:${Number(argv.port)}`);

  const shutdown = async () => {
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
