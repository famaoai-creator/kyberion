import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  customerRoot: vi.fn(),
  knowledge: vi.fn(),
}));

vi.mock('./customer-resolver.js', () => ({
  customerRoot: mocks.customerRoot,
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    knowledge: mocks.knowledge,
  },
}));

describe('profile-root', () => {
  it('prefers the customer overlay root when active', async () => {
    mocks.customerRoot.mockReturnValue('/tmp/customer/acme');
    mocks.knowledge.mockReturnValue('/tmp/personal');
    const { resolveActiveProfileRoot } = await import('./profile-root.js');

    expect(resolveActiveProfileRoot()).toBe('/tmp/customer/acme');
  });

  it('falls back to the personal knowledge root when no customer is active', async () => {
    mocks.customerRoot.mockReturnValue(null);
    mocks.knowledge.mockReturnValue('/tmp/personal');
    const { resolveActiveProfileRoot } = await import('./profile-root.js');

    expect(resolveActiveProfileRoot()).toBe('/tmp/personal');
  });
});
