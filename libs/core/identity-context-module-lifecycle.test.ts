import { describe, expect, it, vi } from 'vitest';

describe('identity context module graph lifecycle', () => {
  it('registers real authority again after the previous module graph is discarded', async () => {
    vi.resetModules();
    const firstAuthority = await import('./authority.js');
    const firstBridge = await import('./identity-context-bridge.js');
    const firstCatalog = (await import('./seam.js')).coreSeamCatalog;
    expect(firstCatalog.get('identity-context-resolver')!.get()).toBe(
      firstAuthority.resolveIdentityContext
    );
    expect(firstBridge.resolvePolicyIdentityContext('first-tenant').tenantSlug).toBe(
      'first-tenant'
    );

    vi.resetModules();
    const secondAuthority = await import('./authority.js');
    const secondBridge = await import('./identity-context-bridge.js');
    const secondCatalog = (await import('./seam.js')).coreSeamCatalog;
    expect(secondAuthority.resolveIdentityContext).not.toBe(firstAuthority.resolveIdentityContext);
    expect(secondCatalog.get('identity-context-resolver')!.get()).toBe(
      secondAuthority.resolveIdentityContext
    );
    expect(secondBridge.resolvePolicyIdentityContext('second-tenant').tenantSlug).toBe(
      'second-tenant'
    );
  });
});
