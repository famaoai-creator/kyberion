import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withLocalPeerRequest } from '../../test/local-peer-fixture';

const REGISTERED_TOKEN = 'registered-concierge-token';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mockRegistrations(entries: unknown[]): void {
  vi.doMock('@agent/core/chronos-access-registry', async () => ({
    ...(await vi.importActual<typeof import('@agent/core/chronos-access-registry')>(
      '@agent/core/chronos-access-registry'
    )),
    readChronosTokenRegistrations: () => entries,
  }));
}

describe('concierge viewer-context tier masking', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@agent/core/chronos-access-registry');
  });

  it('never grants the personal tier to a loopback localadmin viewer', async () => {
    const { resolveConciergeViewerContext } = await import('./viewer-context.js');
    const context = withLocalPeerRequest(
      new NextRequest('http://localhost/api/concierge/inbox'),
      resolveConciergeViewerContext
    );
    expect(context).toMatchObject({ role: 'localadmin', source: 'loopback' });
    expect(context.tierAccess).not.toContain('personal');
    expect(context.tierAccess).toEqual(['confidential', 'public']);
  });

  it('rejects forwarded loopback authority even when trust-proxy is enabled', async () => {
    vi.stubEnv('KYBERION_TRUST_PROXY', 'true');
    const { resolveConciergeViewerContext } = await import('./viewer-context.js');
    expect(() =>
      resolveConciergeViewerContext(
        new NextRequest('http://localhost:3050/api/me', {
          headers: { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '::1' },
        })
      )
    ).toThrow(/viewer principal/);
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
    vi.doMock('@agent/core/chronos-access-registry', async () => {
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
