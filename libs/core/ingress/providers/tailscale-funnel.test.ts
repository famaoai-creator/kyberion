import { describe, expect, it } from 'vitest';
import {
  TailscaleFunnelProvider,
  buildTailscaleFunnelDownArgs,
  buildTailscaleFunnelUpArgs,
  parseTailscaleFunnelMapping,
  parseTailscaleStatus,
  type TailscaleCommandResult,
} from './tailscale-funnel.js';

const HOST = 'mac.tail1234.ts.net';

function statusJson(overrides: Record<string, unknown> = {}, self: Record<string, unknown> = {}) {
  return JSON.stringify({
    Version: '1.88.0',
    BackendState: 'Running',
    CertDomains: [HOST],
    Self: {
      DNSName: `${HOST}.`,
      CapMap: {
        funnel: null,
        https: null,
        'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null,
      },
      ...self,
    },
    ...overrides,
  });
}

function serveJson(handlers: Record<string, string>, allowFunnel = true): string {
  if (Object.keys(handlers).length === 0) return '{}';
  return JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: {
      [`${HOST}:443`]: {
        Handlers: Object.fromEntries(
          Object.entries(handlers).map(([mount, proxy]) => [mount, { Proxy: proxy }])
        ),
      },
    },
    ...(allowFunnel ? { AllowFunnel: { [`${HOST}:443`]: true } } : {}),
  });
}

const ok = (stdout: string): TailscaleCommandResult => ({ stdout, stderr: '', status: 0 });

/** Fake tailscale CLI: serve config mutates on funnel up/off. */
function fakeTailscale(options: {
  status?: string | TailscaleCommandResult;
  handlers?: Record<string, string>;
  allowFunnel?: boolean;
}) {
  const handlers = { ...(options.handlers ?? {}) };
  let allowFunnel = options.allowFunnel ?? Object.keys(handlers).length > 0;
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<TailscaleCommandResult> => {
    calls.push(args);
    if (args[0] === 'status') {
      return typeof options.status === 'object'
        ? options.status
        : ok(options.status ?? statusJson());
    }
    if (args[0] === 'funnel' && args[1] === 'status') return ok(serveJson(handlers, allowFunnel));
    if (args[0] === 'funnel' && args.at(-1) === 'off') {
      const mount = args.find((arg) => arg.startsWith('--set-path='))!.slice('--set-path='.length);
      delete handlers[mount];
      if (Object.keys(handlers).length === 0) allowFunnel = false;
      return ok('');
    }
    if (args[0] === 'funnel' && args.includes('--bg')) {
      const mount = args.find((arg) => arg.startsWith('--set-path='))!.slice('--set-path='.length);
      handlers[mount] = args.at(-1)!;
      allowFunnel = true;
      return ok('Available on the internet');
    }
    return { stdout: '', stderr: `unexpected ${args.join(' ')}`, status: 1 };
  };
  return { run, calls, handlers };
}

const NOW = () => new Date('2026-10-05T00:00:00.000Z');

describe('tailscale-funnel command construction', () => {
  it('builds a scoped funnel up command targeting loopback with the prefix', () => {
    expect(buildTailscaleFunnelUpArgs(8791, '/events')).toEqual([
      'funnel',
      '--bg',
      '--https=443',
      '--set-path=/events',
      'http://127.0.0.1:8791/events',
    ]);
    expect(buildTailscaleFunnelUpArgs(3000, '/')).toEqual([
      'funnel',
      '--bg',
      '--https=443',
      '--set-path=/',
      'http://127.0.0.1:3000',
    ]);
  });

  it('builds a down command that removes only that mapping (never reset)', () => {
    const args = buildTailscaleFunnelDownArgs('/events/');
    expect(args).toEqual(['funnel', '--https=443', '--set-path=/events', 'off']);
    expect(args).not.toContain('reset');
  });

  it('rejects unsafe prefixes and ports before building a command', () => {
    expect(() => buildTailscaleFunnelUpArgs(8791, '/../x')).toThrow(/INGRESS_INVALID_REQUEST/);
    expect(() => buildTailscaleFunnelUpArgs(0, '/events')).toThrow(/INGRESS_INVALID_REQUEST/);
  });
});

describe('tailscale-funnel parsing', () => {
  it('parses node status, MagicDNS name, HTTPS and funnel capability', () => {
    expect(parseTailscaleStatus(statusJson())).toEqual({
      backendState: 'Running',
      dnsName: HOST,
      httpsCertificates: true,
      funnelCapability: true,
    });
    const noFunnel = parseTailscaleStatus(
      statusJson({ CertDomains: [] }, { CapMap: { https: null } })
    );
    expect(noFunnel.funnelCapability).toBe(false);
    expect(noFunnel.httpsCertificates).toBe(true);
    const legacy = parseTailscaleStatus(statusJson({}, { CapMap: undefined }));
    expect(legacy.funnelCapability).toBeUndefined();
    const capsArray = parseTailscaleStatus(
      statusJson({}, { CapMap: undefined, Capabilities: ['https://tailscale.com/cap/funnel'] })
    );
    expect(capsArray.funnelCapability).toBe(true);
  });

  it('reads the mapping at a prefix and the other mounts on the same port', () => {
    const mapping = parseTailscaleFunnelMapping(
      serveJson({ '/events': 'http://127.0.0.1:8791/events', '/grafana': 'http://127.0.0.1:3000' }),
      HOST,
      '/events'
    );
    expect(mapping).toEqual({
      proxy: 'http://127.0.0.1:8791/events',
      localPort: 8791,
      funnelEnabled: true,
      otherPaths: ['/grafana'],
    });
    expect(parseTailscaleFunnelMapping('{}', HOST, '/events')).toEqual({
      funnelEnabled: false,
      otherPaths: [],
    });
    expect(parseTailscaleFunnelMapping('', HOST, '/events').funnelEnabled).toBe(false);
  });
});

describe('TailscaleFunnelProvider', () => {
  it('probe: needs_setup with install steps when the CLI is missing', async () => {
    const error = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    const provider = new TailscaleFunnelProvider({
      run: async () => ({ stdout: '', stderr: '', status: 1, error }),
    });
    const readiness = await provider.probe();
    expect(readiness.status).toBe('needs_setup');
    expect(readiness.reason).toMatch(/not found/);
    expect(readiness.setup_steps?.join(' ')).toMatch(/Install Tailscale/);
    expect(readiness.network_class).toBe('public_internet');
  });

  it('probe: walks login → HTTPS → funnel attribute → ready', async () => {
    const cases: Array<[string, RegExp]> = [
      [statusJson({ BackendState: 'NeedsLogin' }), /NeedsLogin/],
      [statusJson({ CertDomains: [] }, { CapMap: { funnel: null } }), /HTTPS certificates/],
      [statusJson({}, { CapMap: { https: null } }), /funnel node attribute/],
      [statusJson({}, { CapMap: undefined }), /does not report node capabilities/],
    ];
    for (const [status, reason] of cases) {
      const readiness = await new TailscaleFunnelProvider({
        run: fakeTailscale({ status }).run,
      }).probe();
      expect(readiness.status).toBe('needs_setup');
      expect(readiness.reason).toMatch(reason);
      expect(readiness.setup_steps?.length).toBeGreaterThan(0);
    }
    const ready = await new TailscaleFunnelProvider({ run: fakeTailscale({}).run }).probe();
    expect(ready).toMatchObject({ status: 'ready', network_class: 'public_internet' });
  });

  it('up publishes the prefix, verifies it, and returns a stable https URL', async () => {
    const fake = fakeTailscale({});
    const provider = new TailscaleFunnelProvider({ run: fake.run, now: NOW });
    const exposure = await provider.up({
      surfaceId: 'event-intake-surface',
      localPort: 8791,
      pathPrefix: '/events',
    });
    expect(exposure).toEqual({
      surface_id: 'event-intake-surface',
      provider_id: 'tailscale-funnel',
      public_url: `https://${HOST}/events`,
      local_port: 8791,
      path_prefix: '/events',
      started_at: '2026-10-05T00:00:00.000Z',
      stable_url: true,
    });
    expect(fake.calls).toContainEqual(buildTailscaleFunnelUpArgs(8791, '/events'));
    expect(fake.calls.some((args) => args.includes('reset'))).toBe(false);
  });

  it('up refuses a prefix mapped elsewhere and never publishes tailnet-only mounts', async () => {
    const taken = fakeTailscale({ handlers: { '/events': 'http://127.0.0.1:9999/events' } });
    await expect(
      new TailscaleFunnelProvider({ run: taken.run }).up({
        surfaceId: 's',
        localPort: 8791,
        pathPrefix: '/events',
      })
    ).rejects.toThrow(/already proxies/);

    const privateServe = fakeTailscale({
      handlers: { '/grafana': 'http://127.0.0.1:3000' },
      allowFunnel: false,
    });
    await expect(
      new TailscaleFunnelProvider({ run: privateServe.run }).up({
        surfaceId: 's',
        localPort: 8791,
        pathPrefix: '/events',
      })
    ).rejects.toThrow(/tailnet-only mappings/);
    expect(privateServe.calls.some((args) => args.includes('--bg'))).toBe(false);
  });

  it('up fails closed when the provider is not ready', async () => {
    const fake = fakeTailscale({ status: statusJson({ BackendState: 'Stopped' }) });
    await expect(
      new TailscaleFunnelProvider({ run: fake.run }).up({
        surfaceId: 's',
        localPort: 8791,
        pathPrefix: '/events',
      })
    ).rejects.toThrow(/INGRESS_PROVIDER_NOT_READY/);
    expect(fake.calls.some((args) => args.includes('--bg'))).toBe(false);
  });

  it('status reports the live mapping and down removes only that mapping', async () => {
    const fake = fakeTailscale({
      handlers: {
        '/events': 'http://127.0.0.1:8791/events',
        '/other': 'http://127.0.0.1:4000',
      },
    });
    const provider = new TailscaleFunnelProvider({ run: fake.run, now: NOW });
    const live = await provider.status({
      surfaceId: 'event-intake-surface',
      pathPrefix: '/events',
    });
    expect(live?.public_url).toBe(`https://${HOST}/events`);
    expect(live?.local_port).toBe(8791);

    await provider.down({ surfaceId: 'event-intake-surface', pathPrefix: '/events' });
    expect(fake.calls).toContainEqual(buildTailscaleFunnelDownArgs('/events'));
    expect(fake.handlers).toEqual({ '/other': 'http://127.0.0.1:4000' });
    expect(
      await provider.status({ surfaceId: 'event-intake-surface', pathPrefix: '/events' })
    ).toBeUndefined();

    // Already gone: down is a no-op, no second off command.
    const before = fake.calls.length;
    await provider.down({ surfaceId: 'event-intake-surface', pathPrefix: '/events' });
    expect(fake.calls.slice(before).some((args) => args.at(-1) === 'off')).toBe(false);
  });
});
