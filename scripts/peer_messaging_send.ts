import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import {
  describePeerDeliveryFailureNextStep,
  peerDeliveryFailureOf,
  buildPeerMessageEnvelope,
  loadPeerNetworkCatalog,
  peerNetworkCatalogPath,
  resolvePeerNetworkCatalogPath,
  PEER_MESSAGE_TYPES,
  resolvePeerDispatchTarget,
  sendPeerMessage,
} from '@agent/core/mesh/peer-messaging';
import { loadTenantPeerCatalog } from '@agent/core/mesh/peer-conversation';
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
      choices: PEER_MESSAGE_TYPES,
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

  const tenantId = String(argv['tenant-id']);
  // The tenant's own catalog is confidential-tier: read it under the
  // tenant-bound catalog reader, like every other peer sender, so the command
  // works for an operator role that cannot read that tier. Only such a send is
  // re-sent by outbox redelivery; an explicit catalog or the
  // KYBERION_PEER_NETWORK_CATALOG override is read as the caller and is not.
  const throughTenantCatalog =
    !argv.catalog &&
    resolvePeerNetworkCatalogPath({ tenantId }) === peerNetworkCatalogPath(tenantId);
  const catalog = throughTenantCatalog
    ? loadTenantPeerCatalog(tenantId)
    : loadPeerNetworkCatalog({
        ...(argv.catalog ? { catalogPath: String(argv.catalog) } : {}),
        tenantId,
      });
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

  const recovery = throughTenantCatalog ? undefined : ('caller' as const);
  const senderPeerId = String(argv['from-peer-id']);
  let receipt: Awaited<ReturnType<typeof sendPeerMessage>>;
  try {
    receipt = await sendPeerMessage(envelope, {
      destinationUrl: target.destinationUrl,
      allowLocalNetwork: target.allowLocalNetwork,
      timeoutMs: Number(argv['timeout-ms']),
      ...(recovery ? { recovery } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `peer_message_not_delivered:${envelope.message_id} — ${message} | ${describePeerDeliveryFailureNextStep({ failure: peerDeliveryFailureOf(error), senderPeerId, recovery })}`,
      { cause: error }
    );
  }

  if (receipt.ok) {
    logger.success(
      `[peer-messaging-send] delivered ${envelope.message_id} -> ${target.peer.peer_id} (${target.destinationUrl})`
    );
    print(receipt);
    return;
  }
  const nextStep = describePeerDeliveryFailureNextStep({
    failure: receipt.failure,
    senderPeerId,
    recovery,
  });
  logger.warn(
    `[peer-messaging-send] not delivered ${envelope.message_id} -> ${target.peer.peer_id} — ${receipt.error || `http_${receipt.status}`} | ${nextStep} | destination=${target.destinationUrl}`
  );
  print({ ...receipt, next: nextStep });
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
