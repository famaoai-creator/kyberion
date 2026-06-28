import { createStandardYargs, logger } from '@agent/core';
import {
  appendPeerConversationTranscript,
  createPeerConversationSession,
  listPeerConversationSessions,
  loadPeerConversationSession,
  sendPeerConversationMessageToPeer,
} from '@agent/core';

function csv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
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
      choices: ['open', 'message', 'reply', 'handoff', 'close', 'status'],
      default: 'message',
    })
    .option('related-work-item-id', { type: 'array' })
    .option('metadata', { type: 'string' })
    .option('catalog', { type: 'string' })
    .option('timeout-ms', { type: 'number', default: 5000 })
    .demandCommand(1)
    .parseSync();

  const command = String(argv._[0]);
  const relatedWorkItemIds = csv(argv['related-work-item-id']);

  switch (command) {
    case 'open-session': {
      const session = createPeerConversationSession({
        sessionId: argv['session-id'] ? String(argv['session-id']) : undefined,
        localPeerId: String(argv['local-peer-id'] || argv['peer-id'] || ''),
        remotePeerId: String(argv['remote-peer-id'] || ''),
        topic: String(argv.topic || ''),
        title: argv.title ? String(argv.title) : undefined,
        relatedWorkItemIds,
        metadata: argv.metadata ? JSON.parse(String(argv.metadata)) : undefined,
      });
      console.log(JSON.stringify(session, null, 2));
      break;
    }
    case 'send-message': {
      const outcome = await sendPeerConversationMessageToPeer({
        senderPeerId: String(argv['local-peer-id'] || argv['peer-id'] || ''),
        recipientPeerId: String(argv['remote-peer-id'] || ''),
        sessionId: argv['session-id'] ? String(argv['session-id']) : undefined,
        topic: String(argv.topic || ''),
        title: argv.title ? String(argv.title) : undefined,
        text: String(argv.text || ''),
        messageKind: argv.kind as any,
        relatedWorkItemIds,
        metadata: argv.metadata ? JSON.parse(String(argv.metadata)) : undefined,
        timeoutMs: Number(argv['timeout-ms']),
        catalogPath: argv.catalog ? String(argv.catalog) : undefined,
      });
      logger.success(
        `[peer-conversation] ${outcome.receipt.ok ? 'delivered' : 'failed'} ${outcome.session.session_id}`,
      );
      console.log(JSON.stringify(outcome, null, 2));
      break;
    }
    case 'list-sessions': {
      const peerId = String(argv['peer-id'] || argv['local-peer-id'] || '');
      console.log(JSON.stringify({ sessions: listPeerConversationSessions(peerId) }, null, 2));
      break;
    }
    case 'show-session': {
      const peerId = String(argv['peer-id'] || argv['local-peer-id'] || '');
      console.log(JSON.stringify({ session: loadPeerConversationSession(peerId, String(argv['session-id'] || '')) }, null, 2));
      break;
    }
    case 'close-session': {
      const peerId = String(argv['peer-id'] || argv['local-peer-id'] || '');
      const sessionId = String(argv['session-id'] || '');
      const session = loadPeerConversationSession(peerId, sessionId);
      if (!session) throw new Error(`Conversation session not found: ${peerId}/${sessionId}`);
      const closed = appendPeerConversationTranscript({
        sessionId,
        localPeerId: peerId,
        remotePeerId: session.remote_peer_id,
        kind: 'close',
        direction: 'outbound',
        text: String(argv.text || 'Conversation closed'),
        relatedWorkItemIds,
        metadata: argv.metadata ? JSON.parse(String(argv.metadata)) : undefined,
      });
      console.log(JSON.stringify(closed, null, 2));
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: any) => {
  logger.error(error?.message || String(error));
  process.exit(1);
});
