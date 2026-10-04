import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  TailscaleFunnelProvider,
  type TailscaleCommandResult,
} from './providers/tailscale-funnel.js';
import {
  exposeSurface,
  ingressEffectDigest,
  listSurfaceIngressStatus,
  loadPublicIngressState,
  planSurfaceIngress,
  probeSurfaceIdentity,
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
  ingress: { allowed: true, path_prefix: '/events', port_env: 'KYBERION_EVENT_INTAKE_PORT' },
};
const PRIVATE_SURFACE: SurfaceRuntimeDefinition = {
  id: 'operator-surface',
  kind: 'ui',
  description: 'ops',
  command: 'node',
  port: 3000,
  healthPath: '/health',
};

type FakeProvider = PublicIngressProvider & {
  up: ReturnType<typeof vi.fn>;
  down: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
};

function fakeProvider(): FakeProvider {
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
  } as FakeProvider;
}

const HOST = 'mac.tail1234.ts.net';
const ok = (stdout: string): TailscaleCommandResult => ({ stdout, stderr: '', status: 0 });

/** Real Tailscale adapter over a fake CLI whose serve config already maps /events. */
function tailscaleWithLiveMapping(proxy = 'http://127.0.0.1:8791/events') {
  const handlers: Record<string, string> = { '/events': proxy };
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<TailscaleCommandResult> => {
    calls.push(args);
    if (args[0] === 'status') {
      return ok(
        JSON.stringify({
          BackendState: 'Running',
          CertDomains: [HOST],
          Self: { DNSName: `${HOST}.`, CapMap: { funnel: null } },
        })
      );
    }
    if (args[1] === 'status') {
      const mounts = Object.keys(handlers);
      if (mounts.length === 0) return ok('{}');
      return ok(
        JSON.stringify({
          Web: {
            [`${HOST}:443`]: {
              Handlers: Object.fromEntries(
                mounts.map((mount) => [mount, { Proxy: handlers[mount] }])
              ),
            },
          },
          AllowFunnel: { [`${HOST}:443`]: true },
        })
      );
    }
    if (args.at(-1) === 'off') {
      delete handlers['/events'];
      return ok('');
    }
    return { stdout: '', stderr: 'unexpected', status: 1 };
  };
  return { provider: new TailscaleFunnelProvider({ run }), calls, handlers };
}

let deps: PublicIngressServiceDeps;
let tmpDir: string;
let provider: FakeProvider;
const approve = vi.fn();

function useProvider(next: PublicIngressProvider): void {
  resetPublicIngressProviders();
  registerPublicIngressProvider(next);
}

beforeEach(() => {
  vi.stubEnv('KYBERION_INGRESS_PROVIDER', '');
  vi.stubEnv('KYBERION_EVENT_INTAKE_PORT', '');
  tmpDir = pathResolver.sharedTmp(`ingress-service-test-${process.pid}-${Date.now()}`);
  provider = fakeProvider();
  registerPublicIngressProvider(provider);
  approve.mockReset();
  approve.mockReturnValue({ allowed: true, status: 'approved' });
  deps = {
    statePath: path.join(tmpDir, 'state.json'),
    loadSurfaces: () => [EVENT_INTAKE, PRIVATE_SURFACE],
    probeIdentity: async () => ({ ok: true, detail: 'service=event-intake-surface' }),
    approve,
    now: () => new Date('2026-10-05T00:00:00.000Z'),
  };
  vi.mocked(auditChain.record).mockClear();
});

afterEach(() => {
  resetPublicIngressProviders();
  resetPublicIngressProviderLoads();
  vi.unstubAllEnvs();
  if (safeExistsSync(tmpDir)) safeRmSync(tmpDir, { recursive: true, force: true });
});

describe('public ingress service — expose', () => {
  it('refuses surfaces that do not opt in, before any provider or approval call', async () => {
    expect(() => planSurfaceIngress(PRIVATE_SURFACE)).toThrow(/INGRESS_SURFACE_NOT_ALLOWED/);
    await expect(exposeSurface({ surfaceId: 'operator-surface' }, deps)).rejects.toThrow(
      /INGRESS_SURFACE_NOT_ALLOWED/
    );
    expect(approve).not.toHaveBeenCalled();
    expect(provider.up).not.toHaveBeenCalled();
  });

  it('refuses when the process on the port does not identify as the surface', async () => {
    await expect(
      exposeSurface(
        { surfaceId: 'event-intake' },
        {
          ...deps,
          probeIdentity: async () => ({
            ok: false,
            detail: "health identifies as 'voice-hub', not 'event-intake-surface'",
          }),
        }
      )
    ).rejects.toThrow(/INGRESS_SURFACE_UNHEALTHY.*identifies as 'voice-hub'/);
    expect(approve).not.toHaveBeenCalled();
    expect(provider.up).not.toHaveBeenCalled();
  });

  it('refuses when the surface port env moves the listener away from the manifest port', async () => {
    vi.stubEnv('KYBERION_EVENT_INTAKE_PORT', '9001');
    await expect(exposeSurface({ surfaceId: 'event-intake' }, deps)).rejects.toThrow(
      /KYBERION_EVENT_INTAKE_PORT=9001 differs from the manifest port 8791/
    );
    vi.stubEnv('KYBERION_EVENT_INTAKE_PORT', '8791');
    expect(planSurfaceIngress(EVENT_INTAKE).localPort).toBe(8791);
  });

  it('gates up on ingress:expose approval bound to the effect, and does not expose while pending', async () => {
    approve.mockReturnValue({
      allowed: false,
      status: 'pending',
      requestId: 'APR-1',
      requestStatus: 'created',
      message: 'Approval request APR-1 created; awaiting decision',
    });
    const result = await exposeSurface({ surfaceId: 'event-intake' }, deps);
    expect(result).toMatchObject({
      status: 'approval_required',
      approval_state: 'created',
      approval_request_id: 'APR-1',
      provider_id: 'tailscale-funnel',
      message: 'Approval request APR-1 created; awaiting decision',
    });
    expect(provider.up).not.toHaveBeenCalled();
    const call = approve.mock.calls[0]![0];
    expect(call.opId).toBe(RISKY_OPS.INGRESS_EXPOSE);
    const digest = ingressEffectDigest({
      provider_id: 'tailscale-funnel',
      local_port: 8791,
      path_prefix: '/events',
      network_class: 'public_internet',
    });
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
    expect(call.correlationId).toBe(
      `ingress:expose:event-intake-surface:tailscale-funnel:${digest}`
    );
    expect(
      ingressEffectDigest({
        provider_id: 'tailscale-funnel',
        local_port: 9001,
        path_prefix: '/events',
        network_class: 'public_internet',
      })
    ).not.toBe(digest);
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
        result: 'completed',
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
      expect.objectContaining({
        surfaceId: 'event-intake-surface',
        pathPrefix: '/events',
        localPort: 8791,
      })
    );
    expect(loadPublicIngressState(deps).exposures).toEqual({});
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ingress_withdraw' })
    );
    const again = await withdrawSurface({ surfaceId: 'event-intake' }, deps);
    expect(again).toEqual({ status: 'not_exposed', checked_providers: ['tailscale-funnel'] });
    expect(provider.status).toHaveBeenCalled();
  });

  it('audits a failed provider up and does not record state', async () => {
    provider.up.mockRejectedValueOnce(new Error('[INGRESS_COMMAND_FAILED] boom'));
    await expect(exposeSurface({ surfaceId: 'event-intake' }, deps)).rejects.toThrow(/boom/);
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ingress_expose', result: 'failed' })
    );
    expect(loadPublicIngressState(deps).exposures).toEqual({});
  });

  it('audits an exposure whose state record could not be written', async () => {
    const blocked = path.join(tmpDir, 'not-a-dir');
    const { safeWriteFile } = await import('../secure-io.js');
    safeWriteFile(blocked, 'file, not a directory');
    await expect(
      exposeSurface(
        { surfaceId: 'event-intake' },
        { ...deps, statePath: path.join(blocked, 'state.json') }
      )
    ).rejects.toThrow(
      /exposed at https:\/\/mac.tail1.ts.net\/events but the state record could not be written/
    );
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ingress_expose', result: 'error' })
    );
  });

  it('the committed event-intake manifest opts in at /events', async () => {
    const { loadSurfaceManifest } = await import('../surface/surface-runtime.js');
    const surface = loadSurfaceManifest().surfaces.find(
      (entry) => entry.id === 'event-intake-surface'
    )!;
    expect(surface.ingress?.port_env).toBe('KYBERION_EVENT_INTAKE_PORT');
    expect(planSurfaceIngress(surface)).toEqual({
      localPort: 8791,
      pathPrefix: '/events',
      healthPath: '/health',
    });
  });
});

describe('public ingress service — host-wide provider state', () => {
  it('state missing, mapping live: status reports it and down withdraws it through the provider', async () => {
    const tailscale = tailscaleWithLiveMapping();
    useProvider(tailscale.provider);
    expect(loadPublicIngressState(deps).exposures).toEqual({});

    const statuses = await listSurfaceIngressStatus({}, deps);
    expect(statuses).toEqual([
      expect.objectContaining({
        surface_id: 'event-intake-surface',
        provider_id: 'tailscale-funnel',
        live_check: 'unrecorded',
        live: expect.objectContaining({ public_url: `https://${HOST}/events`, local_port: 8791 }),
      }),
    ]);

    const result = await withdrawSurface(
      { surfaceId: 'event-intake', providerId: 'tailscale-funnel' },
      deps
    );
    expect(result).toMatchObject({
      status: 'withdrawn',
      unrecorded: true,
      checked_providers: ['tailscale-funnel'],
    });
    expect(tailscale.handlers).toEqual({});
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ingress_withdraw',
        reason: 'live unrecorded mapping withdrawn',
      })
    );
  });

  it('state missing, foreign mapping: neither reported as ours nor removed', async () => {
    const tailscale = tailscaleWithLiveMapping('http://127.0.0.1:9999/events');
    useProvider(tailscale.provider);
    const result = await withdrawSurface({ surfaceId: 'event-intake' }, deps);
    expect(result).toEqual({ status: 'not_exposed', checked_providers: ['tailscale-funnel'] });
    expect(tailscale.handlers['/events']).toBe('http://127.0.0.1:9999/events');
    expect(tailscale.calls.some((args) => args.at(-1) === 'off')).toBe(false);
  });

  it('tailscale missing: status is an error with the reason, down fails closed (never "not exposed")', async () => {
    const missing = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    useProvider(
      new TailscaleFunnelProvider({
        run: async () => ({ stdout: '', stderr: '', status: 1, error: missing }),
      })
    );
    const statuses = await listSurfaceIngressStatus({ surfaceId: 'event-intake' }, deps);
    expect(statuses).toEqual([
      expect.objectContaining({
        surface_id: 'event-intake-surface',
        live_check: 'error',
        detail: expect.stringMatching(/INGRESS_PROVIDER_NOT_READY.*tailscale CLI not found/),
      }),
    ]);
    await expect(withdrawSurface({ surfaceId: 'event-intake' }, deps)).rejects.toThrow(
      /INGRESS_PROVIDER_NOT_READY/
    );
  });
});

describe('probeSurfaceIdentity', () => {
  it('accepts only a 2xx JSON health whose service is the surface id', async () => {
    let body = JSON.stringify({ status: 'ok', service: 'event-intake-surface' });
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const plan = { localPort: port, pathPrefix: '/events', healthPath: '/health' };
    try {
      expect(await probeSurfaceIdentity(EVENT_INTAKE, plan)).toEqual({
        ok: true,
        detail: 'service=event-intake-surface',
      });
      body = JSON.stringify({ status: 'ok', service: 'voice-hub' });
      expect((await probeSurfaceIdentity(EVENT_INTAKE, plan)).ok).toBe(false);
      body = 'ok';
      expect((await probeSurfaceIdentity(EVENT_INTAKE, plan)).detail).toMatch(/not JSON/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect((await probeSurfaceIdentity(EVENT_INTAKE, plan)).detail).toBe('connect_failed');
  });
});
