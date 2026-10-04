import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));

import { auditChain } from '../governance/audit-chain.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { RISKY_OPS } from '../risky-op-ids.js';
import type { SurfaceRuntimeDefinition } from '../surface/surface-runtime.js';
import type { IngressExposure, PublicIngressProvider } from './public-ingress-contract.js';
import { resetPublicIngressProviderLoads } from './public-ingress-provider-registry.js';
import {
  registerPublicIngressProvider,
  resetPublicIngressProviders,
} from './public-ingress-seam.js';
import {
  exposeSurface,
  listSurfaceIngressStatus,
  loadPublicIngressState,
  planSurfaceIngress,
  withdrawSurface,
  type PublicIngressServiceDeps,
} from './public-ingress-service.js';

const EVENT_INTAKE: SurfaceRuntimeDefinition = {
  id: 'event-intake-surface',
  kind: 'service',
  description: 'intake',
  command: 'node',
  port: 8791,
  healthPath: '/health',
  ingress: { allowed: true, path_prefix: '/events' },
};
const PRIVATE_SURFACE: SurfaceRuntimeDefinition = {
  id: 'operator-surface',
  kind: 'ui',
  description: 'ops',
  command: 'node',
  port: 3000,
  healthPath: '/health',
};

function fakeProvider(): PublicIngressProvider & { up: ReturnType<typeof vi.fn> } {
  const exposures = new Map<string, IngressExposure>();
  return {
    id: 'tailscale-funnel',
    probe: async () => ({
      status: 'ready',
      reason: 'fake ready',
      network_class: 'public_internet',
    }),
    up: vi.fn(async (request) => {
      const exposure: IngressExposure = {
        surface_id: request.surfaceId,
        provider_id: 'tailscale-funnel',
        public_url: `https://mac.tail1.ts.net${request.pathPrefix}`,
        local_port: request.localPort,
        path_prefix: request.pathPrefix ?? '/',
        started_at: '2026-10-05T00:00:00.000Z',
        stable_url: true,
      };
      exposures.set(request.surfaceId, exposure);
      return exposure;
    }),
    down: vi.fn(async (request) => {
      exposures.delete(request.surfaceId);
    }),
    status: vi.fn(async (request) => exposures.get(request.surfaceId)),
  } as PublicIngressProvider & { up: ReturnType<typeof vi.fn> };
}

let deps: PublicIngressServiceDeps;
let tmpDir: string;
let provider: ReturnType<typeof fakeProvider>;
const approve = vi.fn();

beforeEach(() => {
  tmpDir = pathResolver.sharedTmp(`ingress-service-test-${process.pid}-${Date.now()}`);
  provider = fakeProvider();
  registerPublicIngressProvider(provider);
  approve.mockReset();
  approve.mockReturnValue({ allowed: true, status: 'approved' });
  deps = {
    statePath: path.join(tmpDir, 'state.json'),
    loadSurfaces: () => [EVENT_INTAKE, PRIVATE_SURFACE],
    probeHealth: async () => ({ status: 'healthy', detail: 'http_200' }),
    approve,
    now: () => new Date('2026-10-05T00:00:00.000Z'),
  };
  vi.mocked(auditChain.record).mockClear();
});

afterEach(() => {
  resetPublicIngressProviders();
  resetPublicIngressProviderLoads();
  if (safeExistsSync(tmpDir)) safeRmSync(tmpDir, { recursive: true, force: true });
});

describe('public ingress service', () => {
  it('refuses surfaces that do not opt in, before any provider or approval call', async () => {
    expect(() => planSurfaceIngress(PRIVATE_SURFACE)).toThrow(/INGRESS_SURFACE_NOT_ALLOWED/);
    await expect(exposeSurface({ surfaceId: 'operator-surface' }, deps)).rejects.toThrow(
      /INGRESS_SURFACE_NOT_ALLOWED/
    );
    expect(approve).not.toHaveBeenCalled();
    expect(provider.up).not.toHaveBeenCalled();
  });

  it('refuses an unhealthy surface', async () => {
    await expect(
      exposeSurface(
        { surfaceId: 'event-intake' },
        { ...deps, probeHealth: async () => ({ status: 'unhealthy', detail: 'connect_failed' }) }
      )
    ).rejects.toThrow(/INGRESS_SURFACE_UNHEALTHY.*start it before exposing/);
    expect(provider.up).not.toHaveBeenCalled();
  });

  it('gates up on ingress:expose approval and does not expose while pending', async () => {
    approve.mockReturnValue({
      allowed: false,
      status: 'pending',
      requestId: 'APR-1',
      message: 'pending',
    });
    const result = await exposeSurface({ surfaceId: 'event-intake' }, deps);
    expect(result).toMatchObject({
      status: 'approval_required',
      approval_request_id: 'APR-1',
      provider_id: 'tailscale-funnel',
    });
    expect(provider.up).not.toHaveBeenCalled();
    const call = approve.mock.calls[0]![0];
    expect(call.opId).toBe(RISKY_OPS.INGRESS_EXPOSE);
    expect(call.correlationId).toBe('ingress:expose:event-intake-surface:tailscale-funnel');
    expect(call.payload).toMatchObject({
      surface_id: 'event-intake-surface',
      provider_id: 'tailscale-funnel',
      local_port: 8791,
      path_prefix: '/events',
      network_class: 'public_internet',
    });
    expect(call.expiresAt).toBe('2026-10-06T00:00:00.000Z');
    expect(loadPublicIngressState(deps).exposures).toEqual({});
  });

  it('exposes after approval, persists state, audits, and withdraws', async () => {
    const result = await exposeSurface({ surfaceId: 'event-intake-surface' }, deps);
    expect(result.status).toBe('exposed');
    expect(provider.up).toHaveBeenCalledWith({
      surfaceId: 'event-intake-surface',
      localPort: 8791,
      pathPrefix: '/events',
      localHealthPath: '/health',
    });
    const state = loadPublicIngressState(deps);
    expect(state.exposures['event-intake-surface']?.public_url).toBe(
      'https://mac.tail1.ts.net/events'
    );
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ingress_expose',
        metadata: expect.objectContaining({
          surface_id: 'event-intake-surface',
          provider_id: 'tailscale-funnel',
          public_url: 'https://mac.tail1.ts.net/events',
        }),
      })
    );

    const statuses = await listSurfaceIngressStatus({}, deps);
    expect(statuses).toEqual([
      expect.objectContaining({ surface_id: 'event-intake-surface', live_check: 'confirmed' }),
    ]);

    const withdrawn = await withdrawSurface({ surfaceId: 'event-intake' }, deps);
    expect(withdrawn.status).toBe('withdrawn');
    expect(provider.down).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceId: 'event-intake-surface', pathPrefix: '/events' })
    );
    expect(loadPublicIngressState(deps).exposures).toEqual({});
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ingress_withdraw' })
    );
    expect(await withdrawSurface({ surfaceId: 'event-intake' }, deps)).toEqual({
      status: 'not_exposed',
    });
  });

  it('the committed event-intake manifest opts in at /events', async () => {
    const { loadSurfaceManifest } = await import('../surface/surface-runtime.js');
    const surface = loadSurfaceManifest().surfaces.find(
      (entry) => entry.id === 'event-intake-surface'
    )!;
    expect(planSurfaceIngress(surface)).toEqual({
      localPort: 8791,
      pathPrefix: '/events',
      healthPath: '/health',
    });
  });
});
