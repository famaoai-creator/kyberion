import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runPeerOutboxRedeliveryPass: vi.fn(),
  summarizePeerOutbox: vi.fn(),
}));

vi.mock('@agent/core/mesh/peer-outbox-redelivery', () => ({
  runPeerOutboxRedeliveryPass: mocks.runPeerOutboxRedeliveryPass,
  summarizePeerOutbox: mocks.summarizePeerOutbox,
}));

describe('peer_outbox', () => {
  const summary = { counts: { delivered: 1, refused: 0, given_up: 1, retrying: 0 } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.summarizePeerOutbox.mockReturnValue(summary);
    mocks.runPeerOutboxRedeliveryPass.mockResolvedValue({ status: 'completed', delivered: [] });
  });

  it('status reads the outbox state and sends nothing', async () => {
    const { main } = await import('./peer_outbox.js');
    const result = await main(['status', '--peer-id', 'peer-a', '--tenant-id', 'tenant-a']);
    expect(result).toBe(summary);
    expect(mocks.summarizePeerOutbox).toHaveBeenCalledWith('tenant-a', 'peer-a');
    expect(mocks.runPeerOutboxRedeliveryPass).not.toHaveBeenCalled();
  });

  it('redeliver runs one pass and reports the resulting outbox state', async () => {
    const { main } = await import('./peer_outbox.js');
    const result = await main(['redeliver', '--peer-id', 'peer-a', '--tenant-id', 'tenant-a']);
    expect(mocks.runPeerOutboxRedeliveryPass).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      peerId: 'peer-a',
    });
    expect(result).toEqual({ pass: { status: 'completed', delivered: [] }, outbox: summary });
  });

  it('redeliver --dry-run previews without sending', async () => {
    const { main } = await import('./peer_outbox.js');
    const result = await main(['redeliver', '--peer-id', 'peer-a', '--tenant-id', 'tenant-a'], {
      dryRun: true,
    });
    expect(result).toMatchObject({ dry_run: true, operation: 'peer-outbox.redeliver' });
    expect(mocks.runPeerOutboxRedeliveryPass).not.toHaveBeenCalled();
  });

  it('requires a tenant', async () => {
    const previous = process.env.KYBERION_TENANT_ID;
    delete process.env.KYBERION_TENANT_ID;
    try {
      const { main } = await import('./peer_outbox.js');
      await expect(main(['status', '--peer-id', 'peer-a'])).rejects.toThrow(/Missing tenant id/);
    } finally {
      if (previous !== undefined) process.env.KYBERION_TENANT_ID = previous;
    }
  });
});
