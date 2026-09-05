import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareOsControlPlane,
  CloudflareOsReadOnlySurface,
  CloudflareOsSurface,
  pathResolver,
  safeReadFile,
} from '@agent/core';
import {
  getComputerSurfaceAccess,
  getComputerSurfaceGuardedSurfaceUrl,
  getComputerSurfaceOsSnapshot,
  recordComputerSurfaceRead,
} from '../os-control-plane.js';
import { app } from '../server.js';

afterEach(() => vi.unstubAllEnvs());

async function withHttpApp<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const listener = createServer(app);
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    throw new Error('Computer Surface test server did not expose a TCP address');
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('Computer Surface Cloudflare OS projection', () => {
  it('routes OS projection environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/computer-surface/os-control-plane.ts'),
        {
          encoding: 'utf8',
        }
      )
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('derives human tenant-scoped access from server environment', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    vi.stubEnv('KYBERION_COMPUTER_SURFACE_PRINCIPAL', 'human:computer-a');

    expect(getComputerSurfaceAccess()).toEqual({
      principalId: 'human:computer-a',
      tenantSlugs: ['tenant-a'],
    });
  });

  it('fails closed when a tenant has no configured human principal', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    expect(() => getComputerSurfaceAccess()).toThrow('KYBERION_COMPUTER_SURFACE_PRINCIPAL');
  });

  it('filters the real surface projection to the configured tenant', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    vi.stubEnv('KYBERION_COMPUTER_SURFACE_PRINCIPAL', 'human:computer-a');
    const plane = new CloudflareOsControlPlane({ persist: false });
    plane.recordObservation({
      missionId: 'computer-surface-test',
      service: 'test-service',
      resourceRef: 'resource:a',
      tier: 'confidential',
      tenantSlug: 'tenant-a',
      purpose: 'surface verification',
      summary: 'tenant-a observation',
    });
    plane.recordObservation({
      missionId: 'computer-surface-test',
      service: 'test-service',
      resourceRef: 'resource:b',
      tier: 'confidential',
      tenantSlug: 'tenant-b',
      purpose: 'surface verification',
      summary: 'tenant-b observation',
    });

    const snapshot = getComputerSurfaceOsSnapshot(
      'computer-surface-test',
      new CloudflareOsReadOnlySurface(new CloudflareOsSurface(plane))
    );
    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.observations[0]?.tenantSlug).toBe('tenant-a');
  });

  it('accepts only http(s) guarded-surface URLs', () => {
    vi.stubEnv('KYBERION_OS_GUARDED_SURFACE_URL', 'javascript:alert(1)');
    expect(getComputerSurfaceGuardedSurfaceUrl()).toBeUndefined();
    vi.stubEnv('KYBERION_OS_GUARDED_SURFACE_URL', 'https://chronos.example.test/');
    expect(getComputerSurfaceGuardedSurfaceUrl()).toBe('https://chronos.example.test/');
  });

  it('records a tenant-bound read audit without including projection contents', () => {
    const access = {
      principalId: 'human:computer-a',
      tenantSlugs: ['tenant-a'],
    } as const;
    const snapshot = getComputerSurfaceOsSnapshot(
      'computer-surface-test',
      {
        snapshot: () => ({
          missionId: 'computer-surface-test',
          heldActions: [],
          observations: [],
        }),
      },
      access
    );
    const entries: Array<Record<string, unknown>> = [];
    recordComputerSurfaceRead(access, snapshot, (entry) => {
      entries.push(entry as Record<string, unknown>);
    });
    expect(entries[0]).toMatchObject({
      agentId: 'computer-surface',
      action: 'computer_surface.read',
      operation: 'os_control_plane',
      result: 'completed',
      tenantSlug: 'tenant-a',
      metadata: {
        principal_id: 'human:computer-a',
        tenant_scope: ['tenant-a'],
        mission_id: 'computer-surface-test',
        held_action_count: 0,
        observation_count: 0,
      },
    });
    expect(JSON.stringify(entries[0])).not.toContain('observation contents');
  });

  it('enforces the HTTP authorization, scope, and cache contracts', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'false');
    await withHttpApp(async (baseUrl) => {
      const unauthorized = await fetch(`${baseUrl}/api/os/control-plane`);
      expect(unauthorized.status).toBe(401);
    });

    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const repeatedMission = await withHttpApp(async (baseUrl) =>
      fetch(`${baseUrl}/api/os/control-plane?mission_id=one&mission_id=two`)
    );
    expect(repeatedMission.status).toBe(400);

    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    vi.stubEnv('KYBERION_COMPUTER_SURFACE_PRINCIPAL', '');
    const missingPrincipal = await withHttpApp(async (baseUrl) =>
      fetch(`${baseUrl}/api/os/control-plane`)
    );
    expect(missingPrincipal.status).toBe(403);

    vi.stubEnv('KYBERION_TENANT', '');
    vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', 'computer-surface-test-key');
    const successfulRead = await withHttpApp(async (baseUrl) =>
      fetch(`${baseUrl}/api/os/control-plane`)
    );
    const successfulBody = await successfulRead.json();
    expect({ status: successfulRead.status, body: successfulBody }).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(successfulRead.headers.get('cache-control')).toBe('private, no-store');
    expect(successfulBody).toMatchObject({
      heldActions: expect.any(Array),
      observations: expect.any(Array),
    });
  });

  it('enforces readonly versus localadmin operations at the route boundary', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'false');
    vi.stubEnv('KYBERION_API_TOKEN', 'computer-read-token');
    vi.stubEnv('KYBERION_LOCALADMIN_TOKEN', 'computer-admin-token');
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');

    await withHttpApp(async (baseUrl) => {
      const headers = { Authorization: 'Bearer computer-read-token' };
      const stateResponse = await fetch(`${baseUrl}/api/state`, { headers });
      expect(stateResponse.status).toBe(200);

      const manifestResponse = await fetch(`${baseUrl}/api/headless/manifest`, { headers });
      const manifest = await manifestResponse.json();
      expect(manifestResponse.status).toBe(200);
      expect(
        manifest.operations.map((operation: { operation_id: string }) => operation.operation_id)
      ).not.toContain('computer_surface.identity.read');

      const identityResponse = await fetch(`${baseUrl}/api/identity`, { headers });
      expect(identityResponse.status).toBe(403);

      const dispatchResponse = await fetch(`${baseUrl}/a2ui/dispatch`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ updateDataModel: { surfaceId: 'computer-surface', data: {} } }),
      });
      expect(dispatchResponse.status).toBe(403);

      const adminDispatchResponse = await fetch(`${baseUrl}/a2ui/dispatch`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer computer-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ updateDataModel: { surfaceId: 'computer-surface', data: {} } }),
      });
      expect(adminDispatchResponse.status).toBe(200);

      const malformedDispatchResponse = await fetch(`${baseUrl}/a2ui/dispatch`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer computer-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          updateDataModel: {
            surfaceId: 'computer-surface',
            data: [],
          },
        }),
      });
      expect(malformedDispatchResponse.status).toBe(400);

      const crossTenantDispatchResponse = await fetch(`${baseUrl}/a2ui/dispatch`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer computer-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          updateDataModel: {
            surfaceId: 'computer-surface',
            data: { metadata: { scope: { tenant_slug: 'tenant-b' } } },
          },
        }),
      });
      expect(crossTenantDispatchResponse.status).toBe(403);

      const adminManifestResponse = await fetch(`${baseUrl}/api/headless/manifest`, {
        headers: { Authorization: 'Bearer computer-admin-token' },
      });
      const adminManifest = await adminManifestResponse.json();
      expect(
        adminManifest.operations.map(
          (operation: { operation_id: string }) => operation.operation_id
        )
      ).toContain('computer_surface.identity.read');
    });
  });

  it('keeps the route and browser panel read-only for OS actions', () => {
    const server = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/computer-surface/server.ts'), {
        encoding: 'utf8',
      })
    );
    const html = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/computer-surface/static/index.html'),
        {
          encoding: 'utf8',
        }
      )
    );
    expect(server).toMatch(/app\.get\(['"]\/api\/os\/control-plane['"]/);
    expect(server).not.toMatch(/app\.(post|put|patch|delete)\(['"]\/api\/os\/control-plane['"]/i);
    expect(server).toContain('authorizeSurface(req, res,');
    expect(server).toContain("Cache-Control', 'private, no-store'");
    expect(html).toContain("fetch('/api/os/control-plane'");
    expect(html).not.toMatch(/\/api\/os\/(?:approve|apply|decide|held-actions)/i);
    expect(html).toContain('if (!res.ok)');
  });
});
