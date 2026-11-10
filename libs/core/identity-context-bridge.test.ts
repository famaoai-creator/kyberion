import { describe, expect, it } from 'vitest';
import { coreSeamCatalog } from './seam.js';
import {
  registerIdentityContextResolver,
  resolvePolicyIdentityContext,
} from './identity-context-bridge.js';
import { registerPolicyIdentityResolver } from './foundation/identity-context.js';

const resolver = () => ({
  baseRole: 'worker' as const,
  executionMode: 'mission' as const,
  authorities: [],
  tenantSlug: 'registered-tenant',
});

describe('identity context registration lifecycle', () => {
  it('does not let a stale disposer clear a later registration of the same resolver', () => {
    const staleRelease = registerIdentityContextResolver(resolver);
    staleRelease();
    const release = registerIdentityContextResolver(resolver);
    try {
      staleRelease();
      expect(resolvePolicyIdentityContext().tenantSlug).toBe('registered-tenant');
      expect(coreSeamCatalog.get('identity-context-resolver')!.list()).toHaveLength(1);
    } finally {
      release();
    }
    expect(resolvePolicyIdentityContext('fallback-tenant').tenantSlug).toBe('fallback-tenant');
  });

  it('restores the foundation fallback even when a removed listener throws', () => {
    const release = registerIdentityContextResolver(resolver);
    const seam = coreSeamCatalog.get('identity-context-resolver')!;
    const stop = seam.on('removed', () => {
      throw new Error('removed listener failed');
    });
    try {
      expect(() => release()).toThrow('removed listener failed');
      expect(seam.list()).toHaveLength(0);
      expect(resolvePolicyIdentityContext('fallback-tenant').tenantSlug).toBe('fallback-tenant');
    } finally {
      stop();
      release();
    }
  });

  it('rejects direct replacement and leaves the bridge unregistered on failure', () => {
    const release = registerPolicyIdentityResolver(resolver);
    try {
      expect(() => registerPolicyIdentityResolver(resolver)).toThrow(/already registered/);
      expect(() => registerIdentityContextResolver(resolver)).toThrow(/already registered/);
      expect(coreSeamCatalog.get('identity-context-resolver')!.list()).toHaveLength(0);
      expect(resolvePolicyIdentityContext().tenantSlug).toBe('registered-tenant');
    } finally {
      release();
    }
    const bridgeRelease = registerIdentityContextResolver(resolver);
    bridgeRelease();
    expect(resolvePolicyIdentityContext('fallback-tenant').tenantSlug).toBe('fallback-tenant');
  });

  it('rolls back foundation registration when the seam added listener rejects it', () => {
    const seam = coreSeamCatalog.get('identity-context-resolver')!;
    const stop = seam.on('added', () => {
      throw new Error('added listener failed');
    });
    try {
      expect(() => registerIdentityContextResolver(resolver)).toThrow('added listener failed');
      expect(seam.list()).toHaveLength(0);
      expect(resolvePolicyIdentityContext('fallback-tenant').tenantSlug).toBe('fallback-tenant');
    } finally {
      stop();
    }
    const release = registerIdentityContextResolver(resolver);
    release();
  });
});
