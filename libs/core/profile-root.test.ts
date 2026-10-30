import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  customerRoot: vi.fn(),
  activeCustomer: vi.fn(),
  rootDir: vi.fn(),
  knowledge: vi.fn(),
}));

vi.mock('./customer-resolver.js', () => ({
  customerRoot: mocks.customerRoot,
  activeCustomer: mocks.activeCustomer,
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    knowledge: mocks.knowledge,
    rootDir: mocks.rootDir,
  },
}));

describe('profile-root', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.rootDir.mockReturnValue(path.resolve('profile-root-fixture'));
    mocks.knowledge.mockReturnValue('/tmp/personal');
  });

  it('resolves a validated customer lexically without entering the filesystem-guarded helper', async () => {
    mocks.activeCustomer.mockReturnValue('acme');
    mocks.customerRoot.mockImplementation(() => {
      throw new Error('unexpected customer filesystem probe');
    });
    const { resolveActiveProfileRoot } = await import('./profile-root.js');
    expect(resolveActiveProfileRoot({ lexicalOnly: true })).toBe(
      path.join(mocks.rootDir(), 'customer', 'acme')
    );
    expect(mocks.customerRoot).not.toHaveBeenCalled();
    expect(mocks.activeCustomer).toHaveBeenCalledTimes(1);
  });

  it('keeps personal lexical resolution probe-free and propagates invalid customer selection', async () => {
    mocks.activeCustomer.mockReturnValue(null);
    const { resolveActiveProfileRoot } = await import('./profile-root.js');
    expect(resolveActiveProfileRoot({ lexicalOnly: true })).toBe('/tmp/personal');
    expect(mocks.customerRoot).not.toHaveBeenCalled();
    mocks.activeCustomer.mockImplementation(() => {
      throw new Error('Invalid KYBERION_CUSTOMER');
    });
    expect(() => resolveActiveProfileRoot({ lexicalOnly: true })).toThrow(
      'Invalid KYBERION_CUSTOMER'
    );
    expect(mocks.customerRoot).not.toHaveBeenCalled();
  });
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
