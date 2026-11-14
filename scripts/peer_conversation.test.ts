import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendPeerConversationMessageToPeer: vi.fn() }));

vi.mock('@agent/core/mesh/peer-conversation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/mesh/peer-conversation')>()),
  sendPeerConversationMessageToPeer: mocks.sendPeerConversationMessageToPeer,
}));

const args = [
  'send-message',
  '--local-peer-id',
  'peer-a',
  '--remote-peer-id',
  'peer-b',
  '--topic',
  'hello',
  '--text',
  'hi',
  '--tenant-id',
  'tenant-a',
];

describe('peer_conversation send-message', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says the message was delivered when only the local record of the reply failed', async () => {
    const { PeerConversationBookkeepingError } = await import('@agent/core/mesh/peer-conversation');
    mocks.sendPeerConversationMessageToPeer.mockRejectedValue(
      new PeerConversationBookkeepingError(
        { ok: true, status: 200, message_id: 'PM-1' },
        new Error('peer_conversation_reply_identity_mismatch')
      )
    );
    const { main } = await import('./peer_conversation.js');
    const message = await main(args).catch((error: Error) => error.message);
    expect(message).toContain('peer_conversation_message_delivered_but_not_recorded:PM-1');
    expect(message).toContain('the peer accepted the message');
    expect(message).toContain('peer_conversation_reply_identity_mismatch');
    expect(message).toContain('do not send it again');
    expect(message).not.toContain('nothing was sent');
  });

  it('adds the next step to a non-2xx receipt', async () => {
    mocks.sendPeerConversationMessageToPeer.mockResolvedValue({
      session: { session_id: 'PCS-1' },
      receipt: {
        ok: false,
        status: 503,
        message_id: 'PM-2',
        failure: { disposition: 'retryable', reason: 'http_503' },
      },
    });
    const { main } = await import('./peer_conversation.js');
    const outcome = (await main(args)) as { next: string };
    expect(outcome.next).toContain('a retry is scheduled; do not send it again');
  });

  it('passes a failure that happened before any send through unchanged', async () => {
    mocks.sendPeerConversationMessageToPeer.mockRejectedValue(new Error('peer_not_found:peer-b'));
    const { main } = await import('./peer_conversation.js');
    await expect(main(args)).rejects.toThrow('peer_not_found:peer-b');
  });
});
