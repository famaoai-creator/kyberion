import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildPeerMessageEnvelope: vi.fn(),
  loadPeerNetworkCatalog: vi.fn(),
  resolvePeerDispatchTarget: vi.fn(),
  sendPeerMessage: vi.fn(),
  logger: { debug: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@agent/core/mesh/peer-messaging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/mesh/peer-messaging')>()),
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

  const args = ['--from-peer-id', 'peer-a', '--to-peer-id', 'peer-b', '--subject', 'hello'];

  it('tells the operator a retryable failure is scheduled for retry, not to send again', async () => {
    const { main } = await import('./peer_messaging_send.js');
    const failure = { disposition: 'retryable', reason: 'receiver_retryable' };
    mocks.sendPeerMessage.mockResolvedValue({
      ok: false,
      status: 503,
      message_id: 'msg-1',
      failure,
    });
    const print = vi.fn();
    await main(args, print);
    expect(mocks.sendPeerMessage.mock.calls[0][1].recovery).toBeUndefined();
    const printed = print.mock.calls[0][0];
    expect(printed.next).toContain('a retry is scheduled; do not send it again');
    expect(printed.next).toContain('pnpm kyberion peer outbox status --peer-id peer-a');
    expect(mocks.logger.success).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('not delivered msg-1'));
  });

  it('says a terminal failure will not be retried', async () => {
    const { main } = await import('./peer_messaging_send.js');
    mocks.sendPeerMessage.mockResolvedValue({
      ok: false,
      status: 401,
      message_id: 'msg-1',
      error: 'invalid_signature',
      failure: { disposition: 'terminal', reason: 'http_401' },
    });
    const print = vi.fn();
    await main(args, print);
    expect(print.mock.calls[0][0].next).toBe('it will not be retried (http_401)');
  });

  it('marks a send through an explicit catalog as caller-managed and says so', async () => {
    const { main } = await import('./peer_messaging_send.js');
    mocks.sendPeerMessage.mockResolvedValue({
      ok: false,
      status: 503,
      message_id: 'msg-1',
      failure: { disposition: 'retryable', reason: 'http_503' },
    });
    const print = vi.fn();
    await main([...args, '--catalog', 'active/shared/tmp/other-catalog.json'], print);
    expect(mocks.sendPeerMessage.mock.calls[0][1].recovery).toBe('caller');
    expect(print.mock.calls[0][0].next).toContain('it will not be retried automatically');
  });
});
