/**
 * XP-07 close-out: `provider-backend-resolver.ts`.
 * See docs/developer/improvement-plans-2026-07/
 * CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-07.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from './index.js';
import {
  resolveProviderBackend,
  resetProviderBackendResolverCacheForTests,
  type ProviderBackendHandle,
} from './provider-backend-resolver.js';
import type { ProviderCapability } from './provider-capability-registry.js';

function capability(overrides: Partial<ProviderCapability> = {}): ProviderCapability {
  return {
    provider_id: 'claude',
    binary_found: true,
    authenticated: 'unknown',
    headless: true,
    structured_output: true,
    models: [],
    probed_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function fakeHandle(tag: string): ProviderBackendHandle {
  return {
    async delegateTask(instruction: string) {
      return `${tag}:${instruction}`;
    },
  };
}

beforeEach(() => {
  resetProviderBackendResolverCacheForTests();
});

describe('resolveProviderBackend', () => {
  it('routes Codex environment reads through the governed accessor', () => {
    const sources = ['libs/core/provider-backend-resolver.ts', 'libs/core/codex-cli-query.ts'].map(
      (file) => String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' }))
    );
    for (const source of sources) {
      expect(source).not.toMatch(/env\.KYBERION_/u);
      expect(source).toContain('getRegisteredEnvText');
    }
  });

  it('resolves each known provider to an object satisfying the structural interface, via injected (unmocked-config) constructors', () => {
    const constructCalls: string[] = [];
    for (const provider of ['claude', 'codex', 'agy', 'grok'] as const) {
      const handle = resolveProviderBackend(provider, {
        registrySnapshot: () => null, // no cached opinion — fails open, but construction is still seamed below
        construct: {
          [provider]: () => {
            constructCalls.push(provider);
            return fakeHandle(provider);
          },
        },
      });
      expect(handle).not.toBeNull();
      expect(typeof handle?.delegateTask).toBe('function');
    }
    expect(constructCalls.sort()).toEqual(['agy', 'claude', 'codex', 'grok']);
  });

  it('never touches real construction when a construct seam is supplied (no config/binary access)', async () => {
    const handle = resolveProviderBackend('claude', {
      construct: { claude: () => fakeHandle('claude') },
    });
    expect(handle).not.toBeNull();
    await expect(handle!.delegateTask('hi')).resolves.toBe('claude:hi');
  });

  it('returns null for an unknown provider', () => {
    expect(resolveProviderBackend('not-a-real-provider')).toBeNull();
    expect(resolveProviderBackend('')).toBeNull();
  });

  it('returns null when the XP-01 registry snapshot says the binary is not found', () => {
    const handle = resolveProviderBackend('claude', {
      registrySnapshot: () => [capability({ provider_id: 'claude', binary_found: false })],
      construct: {
        claude: () => {
          throw new Error('must not construct when registry says unavailable');
        },
      },
    });
    expect(handle).toBeNull();
  });

  it('fails open (still constructs) when the registry has no entry for the provider', () => {
    const handle = resolveProviderBackend('codex', {
      registrySnapshot: () => [capability({ provider_id: 'agy', binary_found: false })],
      construct: { codex: () => fakeHandle('codex') },
    });
    expect(handle).not.toBeNull();
  });

  it('fails open (still constructs) when the registry snapshot is null (no cached opinion)', () => {
    const handle = resolveProviderBackend('agy', {
      registrySnapshot: () => null,
      construct: { agy: () => fakeHandle('agy') },
    });
    expect(handle).not.toBeNull();
  });

  it('caches: the same provider resolves to the same instance across calls', () => {
    let calls = 0;
    const construct = { claude: () => (calls++, fakeHandle('claude')) };
    const first = resolveProviderBackend('claude', {
      registrySnapshot: () => null,
      construct,
    });
    const second = resolveProviderBackend('claude', {
      registrySnapshot: () => null,
      construct,
    });
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it('caches null resolutions too (unavailable provider is not re-constructed)', () => {
    let calls = 0;
    const registrySnapshot = () => [capability({ provider_id: 'codex', binary_found: false })];
    const construct = {
      codex: () => {
        calls++;
        return fakeHandle('codex');
      },
    };
    expect(resolveProviderBackend('codex', { registrySnapshot, construct })).toBeNull();
    expect(resolveProviderBackend('codex', { registrySnapshot, construct })).toBeNull();
    expect(calls).toBe(0);
  });

  it('never throws: a throwing constructor resolves to null instead', () => {
    expect(() =>
      resolveProviderBackend('agy', {
        registrySnapshot: () => null,
        construct: {
          agy: () => {
            throw new Error('boom');
          },
        },
      })
    ).not.toThrow();
    const handle = resolveProviderBackend('agy', {
      registrySnapshot: () => null,
      construct: {
        agy: () => {
          throw new Error('boom');
        },
      },
    });
    expect(handle).toBeNull();
  });

  it('normalizes known reasoning-backend-name aliases to their provider id', () => {
    const handle = resolveProviderBackend('shell-claude-cli', {
      registrySnapshot: () => null,
      construct: { claude: () => fakeHandle('claude-alias') },
    });
    expect(handle).not.toBeNull();

    const grokHandle = resolveProviderBackend('shell-grok-cli', {
      registrySnapshot: () => null,
      construct: { grok: () => fakeHandle('grok-alias') },
    });
    expect(grokHandle).not.toBeNull();
  });
});

describe('resolveProviderBackend (default real constructors)', () => {
  it('constructs a real backend for a known provider without spawning a process (construction only)', () => {
    // No `construct` seam here — exercises the module's real
    // DEFAULT_CONSTRUCTORS. Registry snapshot forced to "no opinion" so this
    // doesn't depend on a cached capability file existing in the test env.
    // If construction spawned anything, this would hang/timeout instead of
    // returning synchronously.
    const handle = resolveProviderBackend('claude', { registrySnapshot: () => null });
    expect(handle).not.toBeNull();
    expect(typeof handle?.delegateTask).toBe('function');
  });

  it('constructs a real Grok backend without probing or spawning a process', () => {
    const handle = resolveProviderBackend('grok', { registrySnapshot: () => null });
    expect(handle).not.toBeNull();
    expect(typeof handle?.delegateTask).toBe('function');
  });
});
