import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  authorizeSurfaceMutation,
  defaultSurfaceViewerTierAccess,
  extractSurfaceBearerToken,
  narrowSurfaceViewerScope,
  narrowSurfaceViewerTenant,
  narrowSurfaceViewerTier,
  resolveSurfaceViewerToken,
  resolveSurfaceViewerTierAccess,
} from './surface-mutation-guard.js';

function makeRequest(url: string, headers: Record<string, string> = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return { url, getHeader: (name: string) => normalized[name.toLowerCase()] ?? null };
}

const originalApiToken = process.env.KYBERION_API_TOKEN;
const originalAdminToken = process.env.KYBERION_LOCALADMIN_TOKEN;

afterEach(() => {
  if (originalApiToken === undefined) delete process.env.KYBERION_API_TOKEN;
  else process.env.KYBERION_API_TOKEN = originalApiToken;
  if (originalAdminToken === undefined) delete process.env.KYBERION_LOCALADMIN_TOKEN;
  else process.env.KYBERION_LOCALADMIN_TOKEN = originalAdminToken;
});

describe('surface-mutation-guard', () => {
  it('resolves registered and configured viewer credentials through one boundary', () => {
    const registered = resolveSurfaceViewerToken('registered-token', {
      registrations: [
        {
          token_hash: createHash('sha256').update('registered-token').digest('hex'),
          role: 'readonly',
          tenant_slugs: ['tenant-a'],
          label: 'registered viewer',
        },
      ],
      apiToken: 'registered-token',
    });
    expect(registered).toMatchObject({
      role: 'readonly',
      registration: { label: 'registered viewer' },
    });

    expect(resolveSurfaceViewerToken('api-token', { apiToken: 'api-token' })).toMatchObject({
      role: 'readonly',
    });
    expect(
      resolveSurfaceViewerToken('admin-token', { localadminToken: 'admin-token' })
    ).toMatchObject({ role: 'localadmin' });
  });

  it('extracts bearer credentials without broadening the accepted header form', () => {
    expect(extractSurfaceBearerToken('Bearer secret-token')).toBe('secret-token');
    expect(extractSurfaceBearerToken('Bearer   secret-token  ')).toBe('secret-token');
    expect(extractSurfaceBearerToken('bearer secret-token')).toBe('');
    expect(extractSurfaceBearerToken('Basic secret-token')).toBe('');
    expect(extractSurfaceBearerToken('Bearer')).toBe('');
    expect(extractSurfaceBearerToken(undefined)).toBe('');
  });

  it('does not trust a loopback request URL without request authentication', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const decision = authorizeSurfaceMutation(makeRequest(`http://${host}:3050/api/x`));
      expect(decision.ok, host).toBe(false);
      expect(decision.status).toBe(403);
    }
  });

  it('rejects a spoofed loopback host without a token or same-origin proof', () => {
    const decision = authorizeSurfaceMutation(
      makeRequest('http://localhost:3050/api/approvals/approval-1', {
        host: 'localhost:3050',
        origin: 'https://evil.example.com',
      })
    );
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('allows a valid bearer token on non-loopback hosts', () => {
    process.env.KYBERION_API_TOKEN = 'secret-token';
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', {
        authorization: 'Bearer secret-token',
      })
    );
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe('token');
  });

  it('rejects an invalid bearer token without same-origin', () => {
    process.env.KYBERION_API_TOKEN = 'secret-token';
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', { authorization: 'Bearer wrong' })
    );
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('does not treat an unset configured token as a valid bearer token', () => {
    delete process.env.KYBERION_API_TOKEN;
    delete process.env.KYBERION_LOCALADMIN_TOKEN;
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', { authorization: 'Bearer undefined' })
    );
    expect(decision.ok).toBe(false);
  });

  it('allows same-origin requests', () => {
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', {
        origin: 'https://kyberion.example.com',
      })
    );
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe('same-origin');
  });

  it('denies cross-origin requests without a token', () => {
    const decision = authorizeSurfaceMutation(
      makeRequest('https://kyberion.example.com/api/x', { origin: 'https://evil.example.com' })
    );
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
  });
});

describe('surface viewer scope', () => {
  it('keeps role tier policy and permits only narrower registrations', () => {
    expect(defaultSurfaceViewerTierAccess('readonly')).toEqual(['public', 'confidential']);
    expect(defaultSurfaceViewerTierAccess('localadmin')).toEqual([
      'personal',
      'confidential',
      'public',
    ]);
    expect(resolveSurfaceViewerTierAccess('localadmin', ['public'])).toEqual(['public']);
    expect(() => resolveSurfaceViewerTierAccess('readonly', ['personal'])).toThrow(
      'exceeds the readonly role policy'
    );
  });

  it('rejects invalid or widening tenant and entity selections', () => {
    const viewer = {
      tenantSlugs: ['tenant-a'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
    };
    expect(narrowSurfaceViewerScope(viewer, { tenant: 'tenant-a' })).toEqual({
      tenantSlugs: ['tenant-a'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
    });
    expect(() => narrowSurfaceViewerTenant(viewer, 'tenant-b')).toThrow(
      'viewer tenant scope denied'
    );
    expect(() => narrowSurfaceViewerScope(viewer, { organizationId: 'org-b' })).toThrow(
      'viewer organization scope denied'
    );
  });

  it('enforces the resolved tier at the data-bearing boundary', () => {
    expect(narrowSurfaceViewerTier({ role: 'readonly', tierAccess: ['public'] }, 'public')).toBe(
      'public'
    );
    expect(() =>
      narrowSurfaceViewerTier({ role: 'readonly', tierAccess: ['public'] }, 'confidential')
    ).toThrow('viewer tier scope denied');
  });
});
