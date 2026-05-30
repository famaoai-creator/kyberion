import { createStandardYargs, logger } from '@agent/core';
import {
  buildPeerMessageEnvelope,
  loadPeerNetworkCatalog,
  resolvePeerDispatchTarget,
  sendPeerMessage,
} from '@agent/core';

function parseJsonPayload(raw: string | undefined): unknown {
  if (!raw) return {};
  return JSON.parse(raw);
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('from-peer-id', {
      type: 'string',
      demandOption: true,
      description: 'Sender peer identifier',
    })
    .option('to-peer-id', {
      type: 'string',
      demandOption: true,
      description: 'Recipient peer identifier',
    })
    .option('subject', {
      type: 'string',
      demandOption: true,
      description: 'Message subject',
    })
    .option('type', {
      type: 'string',
      default: 'request',
      choices: ['request', 'reply', 'notification', 'handoff', 'capability_query', 'capability_response'],
      description: 'Message type',
    })
    .option('payload', {
      type: 'string',
      default: '{}',
      description: 'JSON payload string',
    })
    .option('conversation-id', {
      type: 'string',
      description: 'Conversation identifier',
    })
    .option('reply-to-message-id', {
      type: 'string',
      description: 'Reply-to message identifier',
    })
    .option('correlation-id', {
      type: 'string',
      description: 'Correlation identifier',
    })
    .option('timeout-ms', {
      type: 'number',
      default: 5000,
      description: 'Dispatch timeout in milliseconds',
    })
    .option('catalog', {
      type: 'string',
      description: 'Optional peer catalog path',
    })
    .parseSync();

  const catalog = loadPeerNetworkCatalog(argv.catalog ? { catalogPath: String(argv.catalog) } : {});
  const target = resolvePeerDispatchTarget(String(argv['to-peer-id']), catalog);
  const payload = parseJsonPayload(String(argv.payload || '{}'));
  const envelope = buildPeerMessageEnvelope({
    senderPeerId: String(argv['from-peer-id']),
    recipientPeerId: target.peer.peer_id,
    subject: String(argv.subject),
    type: argv.type as any,
    payload,
    sharedSecret: target.sharedSecret,
    ...(argv['conversation-id'] ? { conversationId: String(argv['conversation-id']) } : {}),
    ...(argv['reply-to-message-id'] ? { replyToMessageId: String(argv['reply-to-message-id']) } : {}),
    ...(argv['correlation-id'] ? { correlationId: String(argv['correlation-id']) } : {}),
  });

  const receipt = await sendPeerMessage(envelope, {
    destinationUrl: target.destinationUrl,
    allowLocalNetwork: target.allowLocalNetwork,
    timeoutMs: Number(argv['timeout-ms']),
  });

  logger.success(
    `[peer-messaging-send] ${receipt.ok ? 'delivered' : 'failed'} ${envelope.message_id} -> ${target.peer.peer_id} (${target.destinationUrl})`
  );
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error: any) => {
  logger.error(error?.message || String(error));
  process.exit(1);
});
