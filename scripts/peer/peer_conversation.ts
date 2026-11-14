import { createStandardYargs } from '@agent/core/cli-utils';
import {
  appendPeerConversationTranscript,
  createPeerConversationSession,
  listPeerConversationSessions,
  loadPeerConversationSession,
  PeerConversationBookkeepingError,
  resolvesThroughTenantPeerCatalog,
  PEER_CONVERSATION_MESSAGE_KINDS,
  savePeerConversationSession,
  sendPeerConversationMessageToPeer,
} from '@agent/core/mesh/peer-conversation';
import {
  describePeerDeliveryFailureNextStep,
  peerDeliveryFailureOf,
} from '@agent/core/mesh/peer-messaging';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, stripSharedScriptFlags } from '../lib/harness.js';
import { parseSafeJsonObjectInput } from '../lib/json-input.js';

function csv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePeerConversationArguments(args: string[]): string[] {
  return stripSharedScriptFlags(args);
}

export async function main(
  args: string[] = [],
  options: { dryRun?: boolean; check?: boolean } = {}
): Promise<unknown> {
  const argv = await createStandardYargs([
    'node',
    'peer_conversation',
    ...normalizePeerConversationArguments(args),
  ])
    .command('open-session', 'Create a local peer conversation session', () => undefined)
    .command('send-message', 'Send a peer conversation message', () => undefined)
    .command('list-sessions', 'List peer conversation sessions', () => undefined)
    .command('show-session', 'Show a peer conversation session', () => undefined)
    .command('close-session', 'Close a peer conversation session', () => undefined)
    .option('peer-id', { type: 'string' })
    .option('local-peer-id', { type: 'string' })
    .option('remote-peer-id', { type: 'string' })
    .option('session-id', { type: 'string' })
    .option('topic', { type: 'string' })
    .option('title', { type: 'string' })
    .option('text', { type: 'string' })
    .option('kind', {
      type: 'string',
      choices: PEER_CONVERSATION_MESSAGE_KINDS,
      default: 'message',
    })
    .option('related-work-item-id', { type: 'array' })
    .option('metadata', { type: 'string' })
    .option('catalog', { type: 'string' })
    .option('tenant-id', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_TENANT_ID') || '',
      description: 'Tenant used to resolve the confidential peer catalog',
    })
    .option('timeout-ms', { type: 'number', default: 5000 })
    .demandCommand(1)
    .parseSync();

  const command = String(argv._[0]);
  const tenantId = String(argv['tenant-id'] || '').trim();
  if (!tenantId) throw new Error('Missing tenant id. Set KYBERION_TENANT_ID or pass --tenant-id.');
  const relatedWorkItemIds = csv(argv['related-work-item-id']);
  const previewOnly = options.dryRun === true || options.check === true;

  switch (command) {
    case 'open-session': {
      if (previewOnly) {
        return {
          dry_run: true,
          operation: 'open-session',
          tenant_id: tenantId,
          local_peer_id: String(argv['local-peer-id'] || argv['peer-id'] || ''),
          remote_peer_id: String(argv['remote-peer-id'] || ''),
          topic: String(argv.topic || ''),
        };
      }
      const session = createPeerConversationSession({
        tenantId,
        sessionId: argv['session-id'] ? String(argv['session-id']) : undefined,
        localPeerId: String(argv['local-peer-id'] || argv['peer-id'] || ''),
        remotePeerId: String(argv['remote-peer-id'] || ''),
        topic: String(argv.topic || ''),
        title: argv.title ? String(argv.title) : undefined,
        relatedWorkItemIds,
        metadata: parseSafeJsonObjectInput(argv.metadata, 'peer conversation metadata'),
      });
      savePeerConversationSession(session);
      return session;
    }
    case 'send-message': {
      if (previewOnly) {
        return {
          dry_run: true,
          operation: 'send-message',
          tenant_id: tenantId,
          sender_peer_id: String(argv['local-peer-id'] || argv['peer-id'] || ''),
          recipient_peer_id: String(argv['remote-peer-id'] || ''),
          text: String(argv.text || ''),
        };
      }
      const senderPeerId = String(argv['local-peer-id'] || argv['peer-id'] || '');
      // A send through an explicit catalog is never re-sent by outbox redelivery.
      const recovery = resolvesThroughTenantPeerCatalog({
        tenantId,
        ...(argv.catalog ? { catalogPath: String(argv.catalog) } : {}),
      })
        ? undefined
        : ('caller' as const);
      const outcome = await sendPeerConversationMessageToPeer({
        tenantId,
        senderPeerId,
        recipientPeerId: String(argv['remote-peer-id'] || ''),
        sessionId: argv['session-id'] ? String(argv['session-id']) : undefined,
        topic: String(argv.topic || ''),
        title: argv.title ? String(argv.title) : undefined,
        text: String(argv.text || ''),
        messageKind: argv.kind as any,
        relatedWorkItemIds,
        metadata: parseSafeJsonObjectInput(argv.metadata, 'peer conversation metadata'),
        timeoutMs: Number(argv['timeout-ms']),
        catalogPath: argv.catalog ? String(argv.catalog) : undefined,
      }).catch((error: unknown) => {
        if (error instanceof PeerConversationBookkeepingError) {
          throw new Error(
            `peer_conversation_message_delivered_but_not_recorded:${error.receipt.message_id} — the peer accepted the message, but its reply was not recorded in the local transcript: ${error.cause instanceof Error ? error.cause.message : String(error.cause)} | next: do not send it again; the outbox redelivery pass retries the transcript record for 24 h`,
            { cause: error }
          );
        }
        const failure = peerDeliveryFailureOf(error);
        if (!failure) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `peer_conversation_message_not_delivered — ${message} | ${describePeerDeliveryFailureNextStep({ failure, senderPeerId, recovery })}`,
          { cause: error }
        );
      });
      if (outcome.receipt.ok) return outcome;
      return {
        ...outcome,
        next: describePeerDeliveryFailureNextStep({
          failure: outcome.receipt.failure,
          senderPeerId,
          recovery,
        }),
      };
    }
    case 'list-sessions': {
      const peerId = String(argv['peer-id'] || argv['local-peer-id'] || '');
      return { sessions: listPeerConversationSessions(tenantId, peerId) };
    }
    case 'show-session': {
      const peerId = String(argv['peer-id'] || argv['local-peer-id'] || '');
      return {
        session: loadPeerConversationSession(tenantId, peerId, String(argv['session-id'] || '')),
      };
    }
    case 'close-session': {
      const peerId = String(argv['peer-id'] || argv['local-peer-id'] || '');
      const sessionId = String(argv['session-id'] || '');
      if (previewOnly) {
        return {
          dry_run: true,
          operation: 'close-session',
          tenant_id: tenantId,
          local_peer_id: peerId,
          session_id: sessionId,
        };
      }
      const session = loadPeerConversationSession(tenantId, peerId, sessionId);
      if (!session) throw new Error(`Conversation session not found: ${peerId}/${sessionId}`);
      const closed = appendPeerConversationTranscript({
        tenantId,
        sessionId,
        localPeerId: peerId,
        remotePeerId: session.remote_peer_id,
        kind: 'close',
        direction: 'outbound',
        text: String(argv.text || 'Conversation closed'),
        relatedWorkItemIds,
        metadata: parseSafeJsonObjectInput(argv.metadata, 'peer conversation metadata'),
      });
      return closed;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export const runPeerConversation = defineScript({
  name: 'peer:conversation',
  run: async ({ argv, dryRun, check, print }) => {
    const result = await main(argv, { dryRun, check });
    print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'peer_conversation.ts') ||
  isDirectScript(import.meta.url, 'peer_conversation.js')
)
  void runPeerConversation();
