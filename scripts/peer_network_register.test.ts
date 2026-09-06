import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerPeerNetworkPeer: vi.fn(),
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
  logger: { success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@agent/core/peer-messaging', () => ({
  registerPeerNetworkPeer: mocks.registerPeerNetworkPeer,
}));

vi.mock('@agent/core/authority', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/authority')>('@agent/core/authority');
  return { ...actual, withExecutionContext: mocks.withExecutionContext };
});

vi.mock('@agent/core/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/core')>('@agent/core/core');
  return { ...actual, logger: mocks.logger };
});

describe('peer_network_register', () => {
  const previousSecret = process.env.KYBERION_PEER_SHARED_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KYBERION_PEER_SHARED_SECRET = 'test-secret';
    mocks.registerPeerNetworkPeer.mockReturnValue({
      catalogPath: '/repo/active/shared/runtime/peers.json',
      catalog: { tenant_id: 'tenant-a' },
      peer: {
        peer_id: 'peer-b',
        base_url: 'https://peer.example.test',
        exposure: 'private_network',
        allow_local_network: false,
        capabilities: ['chat'],
      },
    });
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.KYBERION_PEER_SHARED_SECRET;
    else process.env.KYBERION_PEER_SHARED_SECRET = previousSecret;
  });

  it('parses explicit argv and emits the registration result through the printer', async () => {
    const { main } = await import('./peer_network_register.js');
    const print = vi.fn();
    await main(
      [
        '--tenant-id',
        'tenant-a',
        '--peer-id',
        'peer-b',
        '--base-url',
        'https://peer.example.test',
        '--exposure',
        'private_network',
        '--capabilities',
        'chat',
      ],
      print
    );

    expect(mocks.registerPeerNetworkPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        peerId: 'peer-b',
        baseUrl: 'https://peer.example.test',
        sharedSecret: 'test-secret',
      })
    );
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({ catalog_path: '/repo/active/shared/runtime/peers.json' })
    );
  });
});
