import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileSchema } from '../foundation/schema.js';
import { readJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import type { IngressReadiness, PublicIngressProvider } from './public-ingress-contract.js';
import {
  getPublicIngressProviderDescriptor,
  listPublicIngressCandidates,
  loadPublicIngressProvider,
  listPublicIngressProviderDescriptors,
  probePublicIngressDescriptor,
  resetPublicIngressProviderLoads,
  selectPublicIngressProvider,
} from './public-ingress-provider-registry.js';
import {
  getRegisteredPublicIngressProvider,
  registerPublicIngressProvider,
  resetPublicIngressProviders,
} from './public-ingress-seam.js';

function fakeProvider(id: string, readiness: Partial<IngressReadiness>): PublicIngressProvider {
  return {
    id,
    probe: vi.fn(async () => ({
      status: 'ready',
      reason: 'fake',
      network_class: 'public_internet',
      ...readiness,
    })) as PublicIngressProvider['probe'],
    up: vi.fn(),
    down: vi.fn(),
    status: vi.fn(),
  };
}

afterEach(() => {
  resetPublicIngressProviders();
  resetPublicIngressProviderLoads();
  vi.unstubAllEnvs();
});

describe('public-ingress-providers catalog', () => {
  it('validates against its schema and declares the expected providers', () => {
    const validate = compileSchema(
      pathResolver.knowledge('product/schemas/public-ingress-providers.schema.json')
    );
    const raw = readJson<Record<string, unknown>>(
      pathResolver.knowledge('product/governance/public-ingress-providers.json')
    );
    const { $schema: _schema, ...body } = raw;
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);

    const ids = listPublicIngressProviderDescriptors().map((entry) => entry.provider_id);
    expect(ids).toEqual(['tailscale-funnel', 'cloudflared-quick', 'cloudflared-named', 'ngrok']);
    expect(getPublicIngressProviderDescriptor('tailscale-funnel')).toMatchObject({
      status: 'live',
      stable_url: true,
      tool_id: 'tailscale',
      network_class: 'public_internet',
      secret_refs: [],
    });
    expect(getPublicIngressProviderDescriptor('cloudflared-named')).toMatchObject({
      status: 'planned',
      config_requirements: ['domain'],
    });
    expect(getPublicIngressProviderDescriptor('ngrok')?.secret_refs).toEqual(['NGROK_AUTHTOKEN']);
  });

  it('rejects descriptors carrying secrets-shaped values, shell fragments or foreign modules', () => {
    const validate = compileSchema(
      pathResolver.knowledge('product/schemas/public-ingress-providers.schema.json')
    );
    const base = {
      provider_id: 'x',
      display_name: 'X',
      status: 'live',
      adapter: 'cli',
      module: getPublicIngressProviderDescriptor('tailscale-funnel')!.module!.replace(
        'tailscale-funnel',
        'x'
      ),
      tool_id: 'x',
      stable_url: false,
      network_class: 'public_internet',
      secret_refs: [],
      platforms: ['darwin'],
    };
    const valid = (provider: Record<string, unknown>) =>
      validate({ version: '1', providers: [provider] });
    expect(valid(base)).toBe(true);
    expect(valid({ ...base, module: 'node:child_process' })).toBe(false);
    expect(valid({ ...base, module: undefined })).toBe(false); // live needs a module
    expect(valid({ ...base, secret_refs: ['sk-live-abc'] })).toBe(false);
    expect(valid({ ...base, command: 'ngrok http 80; rm -rf /' })).toBe(false);
    expect(valid({ ...base, fallback_path: '../../etc/passwd' })).toBe(false);
  });
});

describe('public ingress readiness and selection', () => {
  it('planned providers are visible as unsupported, never hidden', async () => {
    registerPublicIngressProvider(fakeProvider('tailscale-funnel', {}));
    const candidates = await listPublicIngressCandidates({ platform: 'darwin' });
    expect(candidates.map((c) => [c.provider_id, c.readiness.status])).toEqual([
      ['tailscale-funnel', 'ready'],
      ['cloudflared-quick', 'unsupported'],
      ['cloudflared-named', 'unsupported'],
      ['ngrok', 'unsupported'],
    ]);
    expect(candidates[1]!.readiness.reason).toMatch(/not implemented yet/);
  });

  it('a descriptor whose platform does not match is unsupported with a reason', async () => {
    const descriptor = {
      ...getPublicIngressProviderDescriptor('tailscale-funnel')!,
      platforms: ['linux'],
    };
    const readiness = await probePublicIngressDescriptor(descriptor, 'darwin');
    expect(readiness).toMatchObject({ status: 'unsupported' });
    expect(readiness.reason).toMatch(/platform darwin/);
  });

  it('default selection picks the first ready live provider and reports the route', async () => {
    const provider = fakeProvider('tailscale-funnel', {});
    registerPublicIngressProvider(provider);
    const selection = await selectPublicIngressProvider({ platform: 'darwin' });
    expect(selection.provider).toBe(provider);
    expect(selection.route).toBe('default');
    expect(selection.reason).toMatch(/first ready provider/);
    expect(selection.candidates).toHaveLength(4);
  });

  it('no ready provider: fails with every readiness reason (visible fallback)', async () => {
    registerPublicIngressProvider(
      fakeProvider('tailscale-funnel', {
        status: 'needs_setup',
        reason: 'tailscale is NeedsLogin, not Running',
      })
    );
    await expect(selectPublicIngressProvider({ platform: 'darwin' })).rejects.toThrow(
      /INGRESS_NO_READY_PROVIDER.*tailscale-funnel=needs_setup \(tailscale is NeedsLogin.*ngrok=unsupported/
    );
  });

  it('explicit and env selection never fall back to another provider', async () => {
    registerPublicIngressProvider(fakeProvider('tailscale-funnel', {}));
    await expect(selectPublicIngressProvider({ providerId: 'ngrok' })).rejects.toThrow(
      /INGRESS_PROVIDER_NOT_READY.*ngrok is unsupported/
    );
    await expect(selectPublicIngressProvider({ providerId: 'nope' })).rejects.toThrow(
      /INGRESS_PROVIDER_UNKNOWN/
    );

    vi.stubEnv('KYBERION_INGRESS_PROVIDER', 'tailscale-funnel');
    const fromEnv = await selectPublicIngressProvider({ platform: 'darwin' });
    expect(fromEnv.route).toBe('env');
    expect(fromEnv.reason).toMatch(/KYBERION_INGRESS_PROVIDER=tailscale-funnel/);

    const explicit = await selectPublicIngressProvider({
      providerId: 'tailscale-funnel',
      platform: 'darwin',
    });
    expect(explicit.route).toBe('explicit');
  });

  it('loads the live provider module named by the catalog and registers it in the seam', async () => {
    const provider = await loadPublicIngressProvider(
      getPublicIngressProviderDescriptor('tailscale-funnel')!
    );
    expect(provider.id).toBe('tailscale-funnel');
    expect(getRegisteredPublicIngressProvider('tailscale-funnel')).toBe(provider);
  });

  it('a module that fails to load resolves to unsupported (fail closed)', async () => {
    const descriptor = getPublicIngressProviderDescriptor('tailscale-funnel')!;
    const readiness = await probePublicIngressDescriptor(
      {
        ...descriptor,
        module: descriptor.module!.replace('tailscale-funnel', 'does-not-exist'),
        fallback_path: undefined,
      },
      'darwin'
    );
    expect(readiness.status).toBe('unsupported');
    expect(readiness.reason).toMatch(/failed to load/);
  });
});
