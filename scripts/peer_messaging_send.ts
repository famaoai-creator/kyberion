import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import {
  buildPeerMessageEnvelope,
  loadPeerNetworkCatalog,
  resolvePeerDispatchTarget,
  sendPeerMessage,
} from '@agent/core/peer-messaging';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';
import { parseSafeJsonInput } from './lib/json-input.js';

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const argv = await createStandardYargs(['node', 'peer_messaging_send', ...args])
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
      choices: [
        'request',
        'reply',
        'notification',
        'handoff',
        'capability_query',
        'capability_response',
      ],
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
    .option('tenant-id', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_TENANT_ID') || '',
      demandOption: true,
      description:
        'Tenant used to resolve knowledge/confidential/<tenant>/connections/peer-network.json',
    })
    .parseSync();

  const catalog = loadPeerNetworkCatalog({
    ...(argv.catalog ? { catalogPath: String(argv.catalog) } : {}),
    ...(argv['tenant-id'] ? { tenantId: String(argv['tenant-id']) } : {}),
  });
  const tenantId = String(argv['tenant-id']);
  const target = resolvePeerDispatchTarget(String(argv['to-peer-id']), catalog);
  const payload = parseSafeJsonInput(String(argv.payload || '{}'), 'peer message payload');
  const envelope = buildPeerMessageEnvelope({
    tenantId,
    senderPeerId: String(argv['from-peer-id']),
    recipientPeerId: target.peer.peer_id,
    subject: String(argv.subject),
    type: argv.type as any,
    payload,
    sharedSecret: target.sharedSecret,
    ...(argv['conversation-id'] ? { conversationId: String(argv['conversation-id']) } : {}),
    ...(argv['reply-to-message-id']
      ? { replyToMessageId: String(argv['reply-to-message-id']) }
      : {}),
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
  print(receipt);
}

const runPeerMessagingSend = defineScript({
  name: 'peer-messaging-send',
  flags: ['json', 'quiet'],
  run: ({ argv, print }) => main(stripSharedScriptFlags(argv), print),
});

if (
  isDirectScript(import.meta.url, 'peer_messaging_send.ts') ||
  isDirectScript(import.meta.url, 'peer_messaging_send.js')
)
  void runPeerMessagingSend();
