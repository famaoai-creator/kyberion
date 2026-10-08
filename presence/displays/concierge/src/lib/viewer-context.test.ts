import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REGISTERED_TOKEN = 'registered-concierge-token';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// viewer-context (and the secure-io / tier-guard / authority stack under it) is
// imported once per file and reused from the module cache; re-importing that
// stack per test with vi.resetModules() repeated its module initialisation
// every test (operations-hygiene-runbook §5). Only the tests that vi.doMock the
// token registry need a fresh module graph: they call mockRegistryModule(), and
// afterEach drops that mocked graph again so later tests re-bind the real one.
let registryMocked = false;

function mockRegistryModule(factory: () => Promise<Record<string, unknown>>): void {
  vi.resetModules();
  registryMocked = true;
  vi.doMock('@agent/core/chronos-access-registry', factory);
}

function mockRegistrations(entries: unknown[]): void {
  mockRegistryModule(async () => ({
    ...(await vi.importActual<typeof import('@agent/core/chronos-access-registry')>(
      '@agent/core/chronos-access-registry'
    )),
    readChronosTokenRegistrations: () => entries,
  }));
}

describe('concierge viewer-context tier masking', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@agent/core/chronos-access-registry');
    if (registryMocked) {
      registryMocked = false;
      vi.resetModules();
    }
  });

  it('never grants the personal tier to a loopback localadmin viewer', async () => {
    vi.stubEnv('KYBERION_TRUST_PROXY', 'true');
    const { resolveConciergeViewerContext } = await import('./viewer-context.js');
    const context = resolveConciergeViewerContext(
      new NextRequest('http://localhost/api/concierge/inbox', {
        headers: { 'x-forwarded-for': '127.0.0.1' },
      })
    );
    expect(context).toMatchObject({ role: 'localadmin', source: 'loopback' });
    expect(context.tierAccess).not.toContain('personal');
    expect(context.tierAccess).toEqual(['confidential', 'public']);
  });

  it('never grants the personal tier to an unregistered localadmin token', async () => {
    mockRegistrations([]);
    vi.stubEnv('KYBERION_LOCALADMIN_TOKEN', 'localadmin-token');
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    const { resolveConciergeViewerContext } = await import('./viewer-context.js');
    const context = resolveConciergeViewerContext(
      new NextRequest('https://concierge.example/api/concierge/inbox', {
        headers: { authorization: 'Bearer localadmin-token' },
      })
    );
    expect(context).toMatchObject({ role: 'localadmin', source: 'token' });
    expect(context.tierAccess).not.toContain('personal');
  });

  it('never grants the personal tier to a registered localadmin token', async () => {
    mockRegistrations([
      {
        token_hash: tokenHash(REGISTERED_TOKEN),
        role: 'localadmin',
        tenant_slugs: ['tenant-a'],
        label: 'concierge-registered',
      },
    ]);
    const { resolveConciergeViewerContext } = await import('./viewer-context.js');
    const context = resolveConciergeViewerContext(
      new NextRequest('https://concierge.example/api/concierge/inbox', {
        headers: { authorization: `Bearer ${REGISTERED_TOKEN}` },
      })
    );
    expect(context).toMatchObject({
      role: 'localadmin',
      tenantSlugs: ['tenant-a'],
      source: 'token',
    });
    expect(context.tierAccess).toEqual(['confidential', 'public']);
  });

  it('TR-01: reads the token registry under the narrow reader role under SYSTEM_ROLE', async () => {
    const rolesDuringRead: string[] = [];
    mockRegistryModule(async () => {
      const actual = await vi.importActual<typeof import('@agent/core/chronos-access-registry')>(
        '@agent/core/chronos-access-registry'
      );
      const { resolveRole } = await import('@agent/core/authority');
      return {
        ...actual,
        readChronosTokenRegistrations: () => {
          rolesDuringRead.push(resolveRole() ?? '');
          return [
            {
              token_hash: tokenHash(REGISTERED_TOKEN),
              role: 'readonly',
              tenant_slugs: ['tenant-a'],
            },
          ];
        },
      };
    });
    vi.stubEnv('SYSTEM_ROLE', 'concierge');
    const { resolveConciergeViewerContext } = await import('./viewer-context.js');
    const context = resolveConciergeViewerContext(
      new NextRequest('https://concierge.example/api/concierge/inbox', {
        headers: { authorization: `Bearer ${REGISTERED_TOKEN}` },
      })
    );
    expect(context).toMatchObject({ role: 'readonly', tenantSlugs: ['tenant-a'], source: 'token' });
    expect(rolesDuringRead.length).toBeGreaterThan(0);
    expect(new Set(rolesDuringRead)).toEqual(new Set(['chronos_token_registry_reader']));
  });

  it('rejects a registration that explicitly requests the personal tier', async () => {
    mockRegistrations([
      {
        token_hash: tokenHash(REGISTERED_TOKEN),
        role: 'localadmin',
        tenant_slugs: ['tenant-a'],
        tier_access: ['personal', 'confidential'],
        label: 'concierge-personal',
      },
    ]);
    const { resolveConciergeViewer, resolveConciergeViewerContext } =
      await import('./viewer-context.js');
    const request = () =>
      new NextRequest('https://concierge.example/api/concierge/inbox', {
        headers: { authorization: `Bearer ${REGISTERED_TOKEN}` },
      });
    expect(() => resolveConciergeViewerContext(request())).toThrow(
      'exceeds the localadmin role policy'
    );
    expect(resolveConciergeViewer(request()).response?.status).toBe(403);
  });

  it('denies an explicit personal tier request and masks the role default', async () => {
    const { defaultTierAccess, resolveTierAccess } = await import('./viewer-context.js');
    expect(defaultTierAccess('localadmin')).toEqual(['confidential', 'public']);
    expect(defaultTierAccess('readonly')).toEqual(['public', 'confidential']);
    expect(resolveTierAccess('localadmin')).toEqual(['confidential', 'public']);
    expect(resolveTierAccess('localadmin', ['confidential', 'public'])).toEqual([
      'confidential',
      'public',
    ]);
    expect(() => resolveTierAccess('localadmin', ['personal'])).toThrow(
      'Concierge viewer tier scope exceeds the localadmin role policy.'
    );
    expect(() => resolveTierAccess('readonly', ['personal'])).toThrow(
      'exceeds the readonly role policy'
    );
  });

  it('keeps the personal tier out of the projected viewer scopes', async () => {
    const { conciergeHeadlessScope, toSurfaceAuthorizationContext } =
      await import('./viewer-context.js');
    const viewer = {
      role: 'localadmin' as const,
      tenantSlugs: ['tenant-a'],
      organizationIds: 'all' as const,
      projectIds: 'all' as const,
      tierAccess: ['personal' as const, 'confidential' as const, 'public' as const],
      source: 'loopback' as const,
      principalId: 'human:concierge-localadmin',
    };
    expect(conciergeHeadlessScope(viewer).tier_access).toEqual(['confidential', 'public']);
    expect(toSurfaceAuthorizationContext(viewer).tierAccess).toEqual(['confidential', 'public']);
  });

  it('projects a single-tenant confidential viewer into a non-personal conversation scope', async () => {
    const { conciergeConversationScope } = await import('./viewer-context.js');
    expect(
      conciergeConversationScope({
        role: 'localadmin',
        tenantSlugs: ['tenant-a'],
        organizationIds: 'all',
        projectIds: 'all',
        tierAccess: ['confidential', 'public'],
        source: 'token',
      })
    ).toEqual({ scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' });
  });

  it('uses a public system scope when the viewer spans multiple tenants', async () => {
    const { conciergeConversationScope } = await import('./viewer-context.js');
    expect(
      conciergeConversationScope({
        role: 'localadmin',
        tenantSlugs: 'all',
        organizationIds: 'all',
        projectIds: 'all',
        tierAccess: ['confidential', 'public'],
        source: 'loopback',
      })
    ).toEqual({ scope_kind: 'system', tier: 'public' });
  });

  it('retains a single tenant boundary for a public-only viewer', async () => {
    const { conciergeConversationScope } = await import('./viewer-context.js');
    expect(
      conciergeConversationScope({
        role: 'readonly',
        tenantSlugs: ['tenant-a'],
        organizationIds: 'all',
        projectIds: 'all',
        tierAccess: ['public'],
        source: 'token',
      })
    ).toEqual({ scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' });
  });
});
