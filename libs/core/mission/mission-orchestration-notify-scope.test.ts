// Team Channel P2: mission progress returns to the originating thread inside
// the originating channel's tenant outbox namespace.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueSurfaceOutboxMessage: vi.fn(() => 'outbox-path'),
  enqueueChronosOutboxMessage: vi.fn(() => 'chronos-path'),
}));

vi.mock('../surface/surface-coordination-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../surface/surface-coordination-store.js')>()),
  enqueueSurfaceOutboxMessage: mocks.enqueueSurfaceOutboxMessage,
  enqueueChronosOutboxMessage: mocks.enqueueChronosOutboxMessage,
}));

import { notifyRequestingSurface } from './mission-orchestration-lifecycle-handlers.js';

describe('notifyRequestingSurface tenant scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps team channel replies in the tenant namespace', () => {
    notifyRequestingSurface(
      {
        surface: 'slack',
        channel: 'C-team',
        threadTs: '1.0',
        confirmedBy: 'user:lead',
        scope: { tenant_slug: 'acme', tier: 'confidential' },
      },
      'MSN-X',
      'progress'
    );
    expect(mocks.enqueueSurfaceOutboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'slack',
        channel: 'C-team',
        threadTs: '1.0',
        scope: { tenant_slug: 'acme' },
      })
    );
    expect(mocks.enqueueChronosOutboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { tenant_slug: 'acme' } })
    );
  });

  it('leaves owner-direct replies unscoped', () => {
    notifyRequestingSurface(
      { surface: 'slack', channel: 'C-dm', threadTs: '1.0' },
      'MSN-Y',
      'done'
    );
    const call = (mocks.enqueueSurfaceOutboxMessage.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(call.scope).toBeUndefined();
  });
});
