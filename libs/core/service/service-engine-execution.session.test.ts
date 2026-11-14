import { resolveServiceBinding } from './service-binding.js';
import { executeServicePreset } from './service-engine.js';
import { issueTenantServiceEngineAdmission } from './service-engine-admission.js';
import { buildSafeExecEnv } from '../secure-io.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeServicePresetAlternative,
  type ServicePresetAlternativeExecutionContext,
} from './service-engine-execution.js';

const mocks = vi.hoisted(() => ({
  tenant: 'alpha' as string | undefined,
  personalClaim: undefined as object | undefined,
  actor: 'worker-a',
  source: 'binding-a',
  selected: {} as Record<string, unknown>,
  env: {} as Record<string, string>,
  fresh: true,
  generation: 'one',
  beforeSpawn: undefined as undefined | (() => void),
  authorized: false,
  authorizedBinding: 'binding-a',
  exec: vi.fn(),
  checkHome: vi.fn(),
}));
vi.mock('../governance/chain-integrity.js', async (original) => ({
  ...(await original<typeof import('../governance/chain-integrity.js')>()),
  resolveAuditChainKey: () => Buffer.alloc(32, 7),
}));
vi.mock('../foundation/credential-binding.js', async (original) => ({
  ...(await original<typeof import('../foundation/credential-binding.js')>()),
  credentialExecutionIdentity: () => ({
    tenantSlug: mocks.tenant,
    personalClaim: mocks.personalClaim,
  }),
  resolveTaskServiceProviderBinding: (
    _provider: string,
    expected: { serviceBindingId: string; actorId: string }
  ) => {
    if (
      !mocks.fresh ||
      expected.serviceBindingId !== mocks.source ||
      expected.actorId !== 'worker-a'
    )
      throw new Error('CREDENTIAL_PROVENANCE_DENIED');
    return {
      environment: mocks.env,
      provenance: {
        ...expected,
        serviceId: 'google-workspace',
        sourceOwnerRef: 'alpha',
        generation: mocks.generation,
      },
    };
  },
}));
vi.mock('../authn/actor-context.js', () => ({
  currentActor: () => ({
    actor: { id: mocks.actor },
    provenance: 'claim',
    scope: { tenant_slug: mocks.tenant },
  }),
}));
vi.mock('../provider/provider-auth-home.js', () => ({
  assertIsolatedProviderHome: (...args: unknown[]) => mocks.checkHome(...args),
}));
vi.mock('./service-binding-registry.js', async (original) => ({
  ...(await original<typeof import('./service-binding-registry.js')>()),
  loadServiceBindingRecord: () => mocks.selected,
  listServiceBindingRecords: () => [mocks.selected],
  authorizeTenantServiceAction: () => ({ bindingId: 'binding-a', approvalRequired: false }),
}));
vi.mock('./service-endpoint-registry.js', async (original) => ({
  ...(await original<typeof import('./service-endpoint-registry.js')>()),
  loadServiceEndpointsCatalog: () => ({
    services: { 'google-workspace': { preset_path: 'gws-fixture', allow_unsafe_cli: true } },
  }),
}));
vi.mock('./service-preset-registry.js', async (original) => ({
  ...(await original<typeof import('./service-preset-registry.js')>()),
  getServicePresetRecord: () => ({
    allow_unsafe_cli: true,
    operations: {
      read: { type: 'cli', command: 'gws', args: ['gmail', 'users', 'getProfile'], risk: 'read' },
    },
  }),
}));
vi.mock('../platform.js', () => ({
  platform: {
    checkBinary: async () => {
      mocks.beforeSpawn?.();
      return true;
    },
  },
}));
vi.mock('../secure-io.js', async (original) => ({
  ...(await original<typeof import('../secure-io.js')>()),
  safeExec: (...args: unknown[]) => mocks.exec(...args),
}));
vi.mock('../governance/human-execution.js', () => ({
  hasHumanExecutionContext: () => false,
  currentHumanExecutionAuthorization: () => undefined,
}));
vi.mock('../governance/delegated-execution.js', async (original) => ({
  ...(await original<typeof import('../governance/delegated-execution.js')>()),
  hasDelegatedExecutionContext: () => mocks.authorized,
  currentDelegatedExecution: () =>
    mocks.authorized
      ? {
          target: {
            operationId: 'service:preset:google-workspace:read',
            params: { request: {}, auth: 'none' },
            tenantSlug: 'alpha',
            agentId: 'worker-a',
            serviceBindingId: mocks.authorizedBinding,
            source: { taskId: 'task-a' },
            stepId: 'read',
            correlationId: 'session-test',
          },
        }
      : undefined,
}));

function context(): ServicePresetAlternativeExecutionContext {
  return {
    serviceId: 'google-workspace',
    action: 'read',
    alt: {
      type: 'cli',
      command: 'gws',
      args: ['gmail', 'users', 'getProfile'],
      env: { HOME: '/personal', GOOGLE_WORKSPACE_CLI_TOKEN: 'personal-token' },
    },
    serviceConfig: { allow_unsafe_cli: true },
    preset: {
      allow_unsafe_cli: true,
      operations: { read: { risk: 'read', allow_unsafe_cli: true } },
    },
    params: {},
    envelope: { templateVars: {}, hasBody: false },
    mergedParams: {},
    selectedBinding: { ...mocks.selected },
    binding: { serviceId: 'google-workspace', authMode: 'session' },
  } as ServicePresetAlternativeExecutionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant = 'alpha';
  mocks.personalClaim = undefined;
  mocks.actor = 'worker-a';
  mocks.source = 'binding-a';
  mocks.fresh = true;
  mocks.generation = 'one';
  mocks.beforeSpawn = undefined;
  mocks.authorized = false;
  mocks.authorizedBinding = 'binding-a';
  mocks.selected = {
    binding_id: 'binding-a',
    service_id: 'google-workspace',
    owner_kind: 'organization',
    owner_ref: 'alpha',
    tenant_slug: 'alpha',
    auth_mode: 'session',
    secret_refs: [],
  };
  mocks.env = { HOME: '/isolated', GOOGLE_WORKSPACE_CLI_CONFIG_DIR: '/isolated' };
  mocks.exec.mockReturnValue('{"ok":true}');
});

afterEach(() => vi.unstubAllEnvs());

describe('tenant GWS session transport', () => {
  it.each([false, true])(
    'executes the real admitted engine with selector none and authority active=%s',
    async (authorized) => {
      mocks.authorized = authorized;
      const admission = issueTenantServiceEngineAdmission({
        bindingId: 'binding-a',
        approvalGranted: false,
        securityScope: {
          tenant_slug: 'alpha',
          mission_id: 'mission-a',
          read_tiers: ['confidential'],
          write_tier: 'confidential',
          purpose: 'session test',
        },
      });
      await expect(
        executeServicePreset('google-workspace', 'read', {}, 'none', undefined, admission)
      ).resolves.toEqual({ ok: true });
      expect(mocks.exec).toHaveBeenCalledWith('gws', ['gmail', 'users', 'getProfile'], {
        env: expect.objectContaining(mocks.env),
      });
    }
  );
  it('binds the effect fingerprint to generation and refuses rotation before spawn', async () => {
    mocks.authorized = true;
    const { currentDelegatedExecution, delegatedExecutionEffectConfigurationHash } =
      await import('../governance/delegated-execution.js');
    const target = currentDelegatedExecution('service:preset:google-workspace:read', {
      request: {},
      auth: 'none',
    })!.target;
    const firstHash = delegatedExecutionEffectConfigurationHash(target);
    mocks.generation = 'two';
    expect(delegatedExecutionEffectConfigurationHash(target)).not.toBe(firstHash);
    mocks.generation = 'one';
    mocks.beforeSpawn = () => {
      mocks.generation = 'two';
    };
    const admission = issueTenantServiceEngineAdmission({
      bindingId: 'binding-a',
      approvalGranted: false,
      securityScope: {
        tenant_slug: 'alpha',
        mission_id: 'mission-a',
        read_tiers: ['confidential'],
        write_tier: 'confidential',
        purpose: 'session test',
      },
    });
    await expect(
      executeServicePreset('google-workspace', 'read', {}, 'none', undefined, admission)
    ).rejects.toThrow();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it.each(['source', 'actor', 'generation', 'authority-selection'])(
    'real engine denies %s drift before dispatch',
    async (change) => {
      const admission = issueTenantServiceEngineAdmission({
        bindingId: 'binding-a',
        approvalGranted: false,
        securityScope: {
          tenant_slug: 'alpha',
          mission_id: 'mission-a',
          read_tiers: ['confidential'],
          write_tier: 'confidential',
          purpose: 'session test',
        },
      });
      if (change === 'source') mocks.source = 'binding-b';
      if (change === 'actor') mocks.actor = 'worker-b';
      if (change === 'generation') mocks.fresh = false;
      if (change === 'authority-selection') {
        mocks.authorized = true;
        mocks.authorizedBinding = 'binding-b';
      }
      await expect(
        executeServicePreset('google-workspace', 'read', {}, 'none', undefined, admission)
      ).rejects.toThrow();
      expect(mocks.exec).not.toHaveBeenCalled();
    }
  );

  it('dispatches with the selected isolated session, ignoring template credentials', async () => {
    vi.stubEnv('HF_TOKEN', 'personal-secret');
    vi.stubEnv('CODEX_HOME', '/personal-codex');
    vi.stubEnv('NODE_OPTIONS', '--require=/personal-hook');
    await expect(executeServicePresetAlternative(context())).resolves.toEqual({
      result: { ok: true },
    });
    expect(mocks.exec).toHaveBeenCalledWith('gws', ['gmail', 'users', 'getProfile'], {
      env: expect.objectContaining(mocks.env),
    });
    const childEnv = buildSafeExecEnv(mocks.exec.mock.calls[0]![2].env);
    expect(childEnv.HF_TOKEN).toBe('');
    expect(childEnv.CODEX_HOME).toBe('');
    expect(childEnv.NODE_OPTIONS).toBe('');
    expect(childEnv.HOME).toBe('/isolated');
    expect(mocks.checkHome).toHaveBeenCalledWith(mocks.env, 'alpha');
  });
  it.each(['missing', 'source', 'actor', 'generation', 'config', 'ambient', 'record'])(
    'denies %s drift before spawn',
    async (change) => {
      const input = context();
      if (change === 'missing') input.selectedBinding = undefined;
      if (change === 'source') mocks.source = 'binding-b';
      if (change === 'actor') mocks.actor = 'worker-b';
      if (change === 'generation') mocks.fresh = false;
      if (change === 'config') mocks.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = '/personal';
      if (change === 'ambient') mocks.env.OTHER_TOKEN = 'ambient';
      if (change === 'record') mocks.selected.owner_ref = 'beta';
      await expect(executeServicePresetAlternative(input)).rejects.toThrow(
        'CREDENTIAL_PROVENANCE_DENIED'
      );
      expect(mocks.exec).not.toHaveBeenCalled();
    }
  );
  it('retains the separately admitted fixed capture transport', async () => {
    const input = context();
    input.selectedBinding = undefined;
    input.captureProviderEnvironment = mocks.env;
    input.captureAuthority = vi.fn();
    await executeServicePresetAlternative(input);
    expect(input.captureAuthority).toHaveBeenCalled();
    expect(mocks.exec).toHaveBeenCalledWith('gws', expect.any(Array), { env: mocks.env });
  });
  it('rejects claimed personal GWS instead of inheriting the operator session', async () => {
    mocks.tenant = undefined;
    mocks.personalClaim = { ownerId: 'user:owner' };
    expect(() => resolveServiceBinding('google-workspace', 'session')).toThrow(
      'CREDENTIAL_PROVENANCE_DENIED'
    );
    await expect(executeServicePresetAlternative(context())).rejects.toThrow(
      'CREDENTIAL_PROVENANCE_DENIED'
    );
    await expect(executeServicePreset('google-workspace', 'read', {}, 'none')).rejects.toThrow(
      'Personal claimed PRESET'
    );
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it('retains personal execution without a tenant', async () => {
    mocks.tenant = undefined;
    await executeServicePresetAlternative(context());
    expect(mocks.exec).toHaveBeenCalledWith('gws', expect.any(Array), {
      env: { HOME: '/personal', GOOGLE_WORKSPACE_CLI_TOKEN: 'personal-token' },
    });
  });
});
