import { withAccountProvisionAdmission } from '../foundation/account-provision-admission.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeAccountBroker,
  provisionAccountMaterial,
  type AccountProvisionRequest,
} from './account-broker.js';
import {
  registerSecretResolver,
  resetSecretResolver,
  ShellSecretResolver,
  installSecretResolverIfAvailable,
} from './secret-resolver.js';

const fixture = vi.hoisted(() => ({
  tenant: undefined as string | undefined,
  plugin: false,
  binding: {
    binding_id: 'org-github',
    service_type: 'api',
    scope: 'tenant',
    target: 'org',
    service_id: 'github',
    owner_kind: 'organization',
    owner_ref: 'acme',
    tenant_slug: 'acme',
    auth_mode: 'secret-guard',
    secret_refs: ['GITHUB_TOKEN'],
    allowed_actions: ['read'],
    approval_policy: { read: 'allowed' },
  },
  exec: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: fixture.exec }));
vi.mock('../foundation/credential-binding.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../foundation/credential-binding.js')>()),
  credentialExecutionIdentity: () => ({ tenantSlug: fixture.tenant }),
}));
vi.mock('../shell/sandbox-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shell/sandbox-policy.js')>()),
  getPluginExecutionContext: () => (fixture.plugin ? {} : null),
}));
vi.mock('../service/service-binding-reader.js', () => ({
  loadServiceBindingRecord: () => fixture.binding,
}));
vi.mock('../service/service-endpoint-registry.js', () => ({
  getServiceEndpointRecord: () => ({ credential_suffixes: { accessToken: ['TOKEN'] } }),
}));
const reference = {
  serviceId: 'github',
  bindingId: 'org-github',
  ownerKind: 'organization' as const,
  ownerRef: 'acme',
  tenantSlug: 'acme',
  generation: '12345678-1234-4123-8123-123456789abc',
};
const receipt = (request: AccountProvisionRequest) => ({
  version: 1,
  requestId: request.requestId,
  reference: request.reference,
  expectedGeneration: request.expectedGeneration,
  status: 'provisioned',
});
function install(
  provision = vi.fn((request: AccountProvisionRequest): unknown => receipt(request))
) {
  const writer = { id: 'destination-v1', provision };
  registerSecretResolver({ name: 'fixture', resolve: () => null, accountProvisioner: writer });
  return writer;
}
function request() {
  return {
    brokerId: describeAccountBroker()!.brokerId,
    reference: { ...reference },
    expectedGeneration: null,
    material: { GITHUB_TOKEN: 'private-token' },
  };
}
function admittedProvision(input: Parameters<typeof provisionAccountMaterial>[0]) {
  return withAccountProvisionAdmission(input, () => provisionAccountMaterial(input));
}
describe('account broker provisioning', () => {
  beforeEach(() => {
    fixture.tenant = undefined;
    fixture.plugin = false;
    fixture.binding.owner_ref = 'acme';
    fixture.binding.secret_refs = ['GITHUB_TOKEN'];
  });
  afterEach(() => {
    resetSecretResolver();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it('does not infer a writer from ordinary secret resolution', () => {
    registerSecretResolver({ name: 'readonly', resolve: () => 'token' });
    expect(describeAccountBroker()).toBeNull();
  });
  it('refuses direct shell writer invocation without an admitted broker request', () => {
    const resolver = new ShellSecretResolver({
      command: 'reader',
      accountProvisionCommand: 'writer',
    });
    expect(() =>
      resolver.accountProvisioner!.provision({
        version: 1,
        requestId: 'fake',
        reference,
        expectedGeneration: null,
        material: { GITHUB_TOKEN: 'private-token' },
      })
    ).toThrow('ACCOUNT_BROKER_UNAVAILABLE');
    expect(fixture.exec).not.toHaveBeenCalled();
  });
  it('refuses direct calls without an approved introduction admission', async () => {
    const writer = install();
    await expect(provisionAccountMaterial(request())).rejects.toThrow('ACCOUNT_BROKER_UNAVAILABLE');
    expect(writer.provision).not.toHaveBeenCalled();
  });
  it('bounds a stalled adapter and never accepts its late result', async () => {
    vi.useFakeTimers();
    try {
      install(vi.fn(() => new Promise(() => {})));
      const result = expect(admittedProvision(request())).rejects.toThrow(
        'ACCOUNT_BROKER_UNAVAILABLE'
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
  it('provisions the exact organization generation with a correlated CAS request', async () => {
    const writer = install();
    await admittedProvision(request());
    expect(writer.provision).toHaveBeenCalledOnce();
    expect(writer.provision.mock.calls[0]![0]).toMatchObject({
      reference,
      expectedGeneration: null,
      material: { GITHUB_TOKEN: 'private-token' },
    });
  });
  it.each([
    'owner',
    'generation',
    'service',
    'personal',
    'unrelated-key',
    'missing-key',
    'plugin',
    'tenant',
  ])('refuses %s mismatches before transmitting material', async (kind) => {
    const writer = install();
    const input = request();
    if (kind === 'owner') input.reference.ownerRef = 'other';
    if (kind === 'generation') input.reference.generation = 'invalid';
    if (kind === 'service') input.reference.serviceId = 'slack';
    if (kind === 'personal')
      Object.assign(input.reference, { ownerKind: 'person', ownerRef: 'user:owner' });
    if (kind === 'unrelated-key') Object.assign(input.material, { SLACK_TOKEN: 'other' });
    if (kind === 'missing-key') fixture.binding.secret_refs.push('GITHUB_ACCESS_TOKEN');
    if (kind === 'plugin') fixture.plugin = true;
    if (kind === 'tenant') fixture.tenant = 'acme';
    await expect(admittedProvision(input)).rejects.toThrow('ACCOUNT_BROKER_UNAVAILABLE');
    expect(writer.provision).not.toHaveBeenCalled();
  });
  it.each(['stale', 'extra', 'owner', 'prior', 'error', 'changed-binding', 'changed-writer'])(
    'refuses %s responses without exposing adapter content',
    async (kind) => {
      const provision = vi.fn((req: AccountProvisionRequest): unknown => {
        if (kind === 'error') throw new Error('private-token');
        if (kind === 'changed-binding') fixture.binding.owner_ref = 'other';
        if (kind === 'changed-writer') writer.id = 'destination-v2';
        return {
          ...receipt(req),
          ...(kind === 'stale' ? { requestId: 'old' } : {}),
          ...(kind === 'extra' ? { material: 'private-token' } : {}),
          ...(kind === 'owner' ? { reference: { ...reference, ownerRef: 'other' } } : {}),
          ...(kind === 'prior' ? { expectedGeneration: reference.generation } : {}),
        };
      });
      const writer = install(provision);
      await expect(admittedProvision(request())).rejects.toThrow(
        '[ACCOUNT_BROKER_UNAVAILABLE] Account provisioning unavailable'
      );
    }
  );
  it('uses only the separately configured writer and stdin, with bounded timeout', async () => {
    vi.stubEnv('SLACK_TOKEN', 'unrelated-provider-token');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'unrelated-cloud-key');
    vi.stubEnv('SYSTEM_ROLE', 'sovereign_concierge');
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    vi.stubEnv('KYBERION_DELEGATED_ROLE', 'mission_controller');
    vi.stubEnv('KYBERION_BASE_ROLE', 'sovereign');
    vi.stubEnv('KYBERION_PERSONA', 'sovereign');
    fixture.exec.mockImplementation((_shell: unknown, _args: unknown, options: { input: string }) =>
      JSON.stringify(receipt(JSON.parse(options.input)))
    );
    registerSecretResolver(
      new ShellSecretResolver({
        command: 'reader',
        accountProvisionCommand: 'writer',
        timeoutMs: 100000,
      })
    );
    await admittedProvision(request());
    expect(fixture.exec).toHaveBeenCalledWith(
      expect.any(String),
      ['-c', 'writer'],
      expect.objectContaining({
        timeout: 10000,
        env: expect.objectContaining({
          SYSTEM_ROLE: '',
          MISSION_ROLE: '',
          KYBERION_DELEGATED_ROLE: '',
          KYBERION_BASE_ROLE: '',
          KYBERION_PERSONA: '',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
        input: expect.stringContaining('private-token'),
      })
    );
    expect(JSON.stringify(fixture.exec.mock.calls[0]!.slice(0, 2))).not.toContain('private-token');
    const writerEnv = fixture.exec.mock.calls[0]![2].env;
    expect(writerEnv).not.toHaveProperty('SLACK_TOKEN');
    expect(writerEnv).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(Object.keys(writerEnv).sort()).toEqual(
      [
        'PATH',
        'HOME',
        'LANG',
        'LC_ALL',
        'TMPDIR',
        'TMP',
        'TEMP',
        'SHELL',
        'SYSTEM_ROLE',
        'MISSION_ROLE',
        'KYBERION_DELEGATED_ROLE',
        'KYBERION_BASE_ROLE',
        'KYBERION_PERSONA',
      ].sort()
    );
  });
  it('configuration identity changes when the writer destination changes', () => {
    registerSecretResolver(
      new ShellSecretResolver({ command: 'reader', accountProvisionCommand: 'first' })
    );
    const first = describeAccountBroker();
    resetSecretResolver();
    registerSecretResolver(
      new ShellSecretResolver({ command: 'reader', accountProvisionCommand: 'second' })
    );
    expect(describeAccountBroker()).not.toEqual(first);
  });
  it('installs the explicit writer through the normal bootstrap environment', async () => {
    fixture.exec.mockImplementation((_shell: unknown, _args: unknown, options: { input: string }) =>
      JSON.stringify(receipt(JSON.parse(options.input)))
    );
    expect(
      installSecretResolverIfAvailable({
        KYBERION_SECRET_RESOLVER_COMMAND: 'reader',
        KYBERION_ACCOUNT_PROVISION_COMMAND: 'configured-writer',
      })
    ).toBe(true);
    await admittedProvision(request());
    expect(fixture.exec.mock.calls[0]![1]).toEqual(['-c', 'configured-writer']);
  });
});
