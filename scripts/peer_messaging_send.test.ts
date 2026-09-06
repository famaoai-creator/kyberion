import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildPeerMessageEnvelope: vi.fn(),
  loadPeerNetworkCatalog: vi.fn(),
  resolvePeerDispatchTarget: vi.fn(),
  sendPeerMessage: vi.fn(),
  logger: { success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@agent/core/peer-messaging', () => ({
  buildPeerMessageEnvelope: mocks.buildPeerMessageEnvelope,
  loadPeerNetworkCatalog: mocks.loadPeerNetworkCatalog,
  resolvePeerDispatchTarget: mocks.resolvePeerDispatchTarget,
  sendPeerMessage: mocks.sendPeerMessage,
}));

vi.mock('@agent/core/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/core')>('@agent/core/core');
  return { ...actual, logger: mocks.logger };
});

describe('peer_messaging_send', () => {
  const previousTenant = process.env.KYBERION_TENANT_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KYBERION_TENANT_ID = 'tenant-a';
    mocks.loadPeerNetworkCatalog.mockReturnValue({ tenant_id: 'tenant-a' });
    mocks.resolvePeerDispatchTarget.mockReturnValue({
      peer: { peer_id: 'peer-b' },
      sharedSecret: 'secret',
      destinationUrl: 'https://peer.example.test',
      allowLocalNetwork: false,
    });
    mocks.buildPeerMessageEnvelope.mockReturnValue({ message_id: 'msg-1' });
    mocks.sendPeerMessage.mockResolvedValue({ ok: true, message_id: 'msg-1' });
  });

  afterEach(() => {
    if (previousTenant === undefined) delete process.env.KYBERION_TENANT_ID;
    else process.env.KYBERION_TENANT_ID = previousTenant;
  });

  it('parses explicit argv and emits the delivery receipt through the printer', async () => {
    const { main } = await import('./peer_messaging_send.js');
    const print = vi.fn();
    await main(
      [
        '--from-peer-id',
        'peer-a',
        '--to-peer-id',
        'peer-b',
        '--subject',
        'hello',
        '--payload',
        '{"ok":true}',
      ],
      print
    );

    expect(mocks.buildPeerMessageEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        senderPeerId: 'peer-a',
        recipientPeerId: 'peer-b',
        subject: 'hello',
        payload: { ok: true },
      })
    );
    expect(print).toHaveBeenCalledWith({ ok: true, message_id: 'msg-1' });
  });
});
