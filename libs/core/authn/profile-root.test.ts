import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stanceRoot: vi.fn(),
  activeStance: vi.fn(),
  rootDir: vi.fn(),
  knowledge: vi.fn(),
}));

vi.mock('./stance-resolver.js', () => ({
  STANCES_DIR: path.join('knowledge', 'personal', 'stances'),
  stanceRoot: mocks.stanceRoot,
  activeStance: mocks.activeStance,
}));

vi.mock('../path-resolver.js', () => ({
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
    mocks.activeStance.mockReturnValue('acme');
    mocks.stanceRoot.mockImplementation(() => {
      throw new Error('unexpected customer filesystem probe');
    });
    const { resolveActiveProfileRoot } = await import('./profile-root.js');
    expect(resolveActiveProfileRoot({ lexicalOnly: true })).toBe(
      path.join(mocks.rootDir(), 'knowledge', 'personal', 'stances', 'acme')
    );
    expect(mocks.stanceRoot).not.toHaveBeenCalled();
    expect(mocks.activeStance).toHaveBeenCalledTimes(1);
  });

  it('keeps personal lexical resolution probe-free and propagates invalid customer selection', async () => {
    mocks.activeStance.mockReturnValue(null);
    const { resolveActiveProfileRoot } = await import('./profile-root.js');
    expect(resolveActiveProfileRoot({ lexicalOnly: true })).toBe('/tmp/personal');
    expect(mocks.stanceRoot).not.toHaveBeenCalled();
    mocks.activeStance.mockImplementation(() => {
      throw new Error('Invalid KYBERION_STANCE');
    });
    expect(() => resolveActiveProfileRoot({ lexicalOnly: true })).toThrow(
      'Invalid KYBERION_STANCE'
    );
    expect(mocks.stanceRoot).not.toHaveBeenCalled();
  });
  it('prefers the customer overlay root when active', async () => {
    mocks.stanceRoot.mockReturnValue('/tmp/customer/acme');
    mocks.knowledge.mockReturnValue('/tmp/personal');
    const { resolveActiveProfileRoot } = await import('./profile-root.js');

    expect(resolveActiveProfileRoot()).toBe('/tmp/customer/acme');
  });

  it('falls back to the personal knowledge root when no customer is active', async () => {
    mocks.stanceRoot.mockReturnValue(null);
    mocks.knowledge.mockReturnValue('/tmp/personal');
    const { resolveActiveProfileRoot } = await import('./profile-root.js');

    expect(resolveActiveProfileRoot()).toBe('/tmp/personal');
  });
});
