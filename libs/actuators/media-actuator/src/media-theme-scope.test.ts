import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopeContext } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';

const fixture = vi.hoisted(() => ({
  scope: { tier: 'public' } as ScopeContext,
  packs: new Map<string, Record<string, unknown>>(),
  load: vi.fn(),
}));

vi.mock('@agent/core/scope-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/scope-context')>()),
  currentScope: () => fixture.scope,
}));
vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExistsSync: (target: string) => fixture.packs.has(target) || actual.safeExistsSync(target),
  };
});
vi.mock('./media-catalog-loaders.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media-catalog-loaders.js')>()),
  loadConfidentialThemePack: (root: string, target: string) => fixture.load(root, target),
}));

import { resolveConfidentialThemePack, resolveNamedTheme } from './media-design-protocol.js';

describe('confidential media theme scope', () => {
  const root = pathResolver.rootDir();
  const themePath = (tenant: string) =>
    path.join(root, 'knowledge/confidential', tenant, 'design/theme.json');
  beforeEach(() => {
    fixture.scope = { tier: 'confidential', tenant_slug: 'tenant-alpha' };
    fixture.packs.clear();
    for (const tenant of ['tenant-alpha', 'tenant-beta']) {
      fixture.packs.set(themePath(tenant), {
        theme_id: 'same-theme',
        tenant_slug: tenant,
        theme: {
          name: 'Same theme',
          colors: { primary: tenant === 'tenant-alpha' ? '#112233' : '#445566' },
        },
      });
    }
    fixture.load.mockReset().mockImplementation((_root, target) => fixture.packs.get(target));
  });

  it('resolves duplicate theme names only inside the current tenant', () => {
    expect(resolveNamedTheme(root, 'same-theme')?.colors?.primary).toBe('#112233');
    expect(
      fixture.load.mock.calls.every(([, target]) => target === themePath('tenant-alpha'))
    ).toBe(true);
    fixture.scope = { tier: 'confidential', tenant_slug: 'tenant-beta' };
    expect(resolveNamedTheme(root, 'same-theme')?.colors?.primary).toBe('#445566');
  });

  it.each([
    { tier: 'public' },
    { tier: 'public', tenant_slug: 'tenant-alpha' },
    { tier: 'confidential' },
    { tier: 'confidential', tenant_slug: '../tenant-beta' },
  ] as ScopeContext[])(
    'does not read confidential themes without a valid confidential scope: %j',
    (scope) => {
      fixture.scope = scope;
      expect(resolveConfidentialThemePack(root, 'same-theme')).toBeNull();
      expect(fixture.load).not.toHaveBeenCalled();
    }
  );

  it('does not infer another tenant from a theme name', () => {
    fixture.packs.set(themePath('tenant-beta'), {
      theme_id: 'tenant-beta-imported',
      theme: { name: 'Beta private' },
    });
    expect(resolveConfidentialThemePack(root, 'tenant-beta-imported')).toBeNull();
    expect(
      fixture.load.mock.calls.every(([, target]) => target === themePath('tenant-alpha'))
    ).toBe(true);
  });
});
