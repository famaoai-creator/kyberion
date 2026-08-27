import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REGISTERED_TOKEN = 'registered-concierge-token';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mockRegistrations(entries: unknown[]): void {
  vi.doMock('@agent/core', async () => ({
    ...(await vi.importActual<typeof import('@agent/core')>('@agent/core')),
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
    vi.doUnmock('@agent/core');
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
});
