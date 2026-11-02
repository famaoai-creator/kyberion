import { safeRmSync } from '../secure-io.js';
import { registerSecretResolver, resetSecretResolver } from '../secret/secret-resolver.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContextAsync } from '../authority.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { issueTenantServiceEngineAdmission } from './service-engine-admission.js';
import { executeServicePreset } from './service-engine.js';
import { consumeScopedServiceCaptureAdmission as consumeInformationAssetCaptureAdmission } from './service-capture-admission.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import {
  issueInformationAssetCaptureAdmission,
  executeInformationAssetCapture,
} from '../information-assets/collector-capture.js';
import type {
  InformationAssetLocation,
  InformationAssetServiceRequest,
} from '../information-assets/types.js';

const fixture = vi.hoisted(() => ({
  revoked: false,
  ambientConnection: vi.fn(() => ({ account: 'wrong-ambient' })),
  ambientBinding: vi.fn(() => ({
    serviceId: 'github',
    authMode: 'none',
    accessToken: 'wrong-ambient-token',
  })),
  selected: {
    binding_id: 'github-acme',
    service_id: 'github',
    service_type: 'github',
    scope: 'tenant',
    target: 'acme/app',
    tenant_slug: 'acme',
    owner_kind: 'organization',
    owner_ref: 'acme',
    allowed_actions: ['list_pulls'],
    approval_policy: { list_pulls: 'allowed' } as Record<string, string>,
    secret_refs: [] as string[],
    auth_mode: 'none' as 'none' | 'secret-guard' | 'session',
  },
  execute: vi.fn(async (_context: unknown) => ({ result: [{ number: 1 }] })),
  missionGuard: vi.fn(() => {
    throw new Error('active mission required');
  }),
  preset: {
    service_id: 'github',
    tenant_binding_required: true,
    operations: {
      list_pulls: {
        type: 'api',
        method: 'GET',
        path: 'repos/{{owner}}/{{repo}}/pulls',
        kind: 'capture',
        risk: 'read',
        approval_required: false,
      },
    },
  } as {
    service_id: string;
    tenant_binding_required: boolean;
    operations: Record<string, Record<string, unknown>>;
  },
  location: undefined as InformationAssetLocation | undefined,
}));
vi.mock('../information-assets/catalog.js', () => ({
  authorizeInformationAssetCapture: async (
    scope: { tenant_slug: string; organization_id: string },
    locationId: string,
    operation: string
  ) => {
    const { currentExecutionScope: getScope } = await import('../foundation/execution-scope.js');
    const current = getScope();
    if (
      fixture.revoked ||
      !current?.tenantBound ||
      current.tenantSlug !== scope.tenant_slug ||
      current.organizationId !== scope.organization_id ||
      locationId !== fixture.location?.location_id ||
      !fixture.selected.allowed_actions.includes(operation)
    )
      throw new Error('catalog capture authorization refused');
    return structuredClone(fixture.location);
  },
}));
vi.mock('./service-endpoint-registry.js', () => ({
  getServiceEndpointRecord: () => ({ credential_suffixes: { accessToken: ['ACCESS_TOKEN'] } }),
  loadServiceEndpointsCatalog: () => ({
    services: {
      github: { preset_path: 'fixture', base_url: 'https://api.github.com' },
      'google-workspace': { preset_path: 'gws-fixture' },
    },
  }),
}));
vi.mock('./service-preset-registry.js', () => ({ getServicePresetRecord: () => fixture.preset }));
vi.mock('./service-binding.js', () => ({ resolveServiceBinding: fixture.ambientBinding }));
vi.mock('./service-binding-registry.js', () => ({
  authorizeTenantServiceAction: fixture.missionGuard,
  listServiceBindingRecords: () => [],
  loadServiceBindingRecord: () => fixture.selected,
}));
vi.mock('./service-engine-helpers.js', async (original) => ({
  ...(await original<typeof import('./service-engine-helpers.js')>()),
  loadConnectionWithFallback: fixture.ambientConnection,
}));
vi.mock('./service-engine-execution.js', () => ({
  executeServicePresetAlternative: fixture.execute,
  isReplaySafeServiceOperation: () => true,
}));
const request: InformationAssetServiceRequest = {
  service_id: 'github',
  action: 'list_pulls',
  params: { vars: { owner: 'acme', repo: 'app' } },
};
const location: InformationAssetLocation = {
  location_id: 'review-inbox',
  asset_type: 'code.review_request',
  scope: { tenant_slug: 'acme', organization_id: 'engineering' },
  binding_id: 'github-acme',
  service_id: 'github',
  collector_id: 'github.review_requests',
  selectors: { owner: 'acme', repo: 'app' },
  tier: 'confidential',
  authoritative: true,
  freshness_seconds: 300,
  enabled: true,
  version: 1,
  updated_at: '2026-11-01T00:00:00Z',
};
const scoped = <T>(fn: () => Promise<T>) =>
  withExecutionContextAsync('organization_operator', fn, undefined, 'acme', 'engineering');
afterEach(() => {
  resetSecretResolver();
  safeRmSync('active/shared/tmp/capture-broker-gws-fixture', { recursive: true, force: true });
});
beforeEach(() => {
  resetSecretResolver();
  fixture.location = structuredClone(location);
  fixture.revoked = false;
  fixture.selected.service_id = 'github';
  fixture.selected.allowed_actions = ['list_pulls'];
  fixture.selected.auth_mode = 'none';
  fixture.selected.secret_refs = [];
  fixture.selected.target = 'acme/app';
  fixture.selected.approval_policy.list_pulls = 'allowed';
  fixture.ambientConnection.mockClear();
  fixture.ambientBinding.mockClear();
  fixture.execute.mockReset().mockResolvedValue({ result: [{ number: 1 }] });
  fixture.missionGuard.mockClear();
  Object.assign(fixture.preset.operations.list_pulls!, {
    kind: 'capture',
    risk: 'read',
    method: 'GET',
    approval_required: false,
  });
});
describe('exact-request catalog capture admission at the real service engine boundary', () => {
  it('keeps mission-only actuator guard strict and admits a scoped read independently', async () => {
    const missionCapability = issueTenantServiceEngineAdmission({
      bindingId: 'github-acme',
      approvalGranted: false,
      securityScope: {
        mission_id: '',
        tenant_slug: 'acme',
        organization_id: 'engineering',
        read_tiers: ['confidential'],
        write_tier: 'confidential',
        purpose: 'fixture',
      },
    });
    await expect(
      scoped(() =>
        executeServicePreset(
          'github',
          'list_pulls',
          request.params,
          'none',
          undefined,
          missionCapability
        )
      )
    ).rejects.toThrow('active mission required');
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(await scoped(() => executeInformationAssetCapture(location, request))).toEqual([
      { number: 1 },
    ]);
    expect(fixture.missionGuard).toHaveBeenCalledTimes(1);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });
  it('uses the selected binding secret refs and never calls ambient credential or connection loaders', async () => {
    fixture.selected.auth_mode = 'secret-guard';
    fixture.selected.secret_refs = ['GITHUB_ACCESS_TOKEN'];
    await expect(scoped(() => executeInformationAssetCapture(location, request))).rejects.toThrow(
      /credential_broker_unavailable|bound_secret_missing/
    );
    await scoped(() =>
      withTaskCredentialBinding(
        { tenantSlug: 'acme', secrets: { GITHUB_ACCESS_TOKEN: 'bound-token' } },
        async () => {
          await executeInformationAssetCapture(location, request);
          const context = fixture.execute.mock.calls.at(-1)![0] as unknown as {
            binding: { accessToken: string };
            connection?: unknown;
          };
          expect(context.binding.accessToken).toBe('bound-token');
        }
      )
    );
    expect(fixture.ambientConnection).not.toHaveBeenCalled();
    expect(fixture.ambientBinding).not.toHaveBeenCalled();
  });
  it('binds a configured existing credential broker for CLI/daemon reads without an ambient task binding', async () => {
    fixture.selected.auth_mode = 'secret-guard';
    fixture.selected.secret_refs = ['GITHUB_ACCESS_TOKEN'];
    const resolve = vi.fn(async (input: { key: string; scope?: string; operation?: string }) => {
      expect(input).toEqual({
        key: 'GITHUB_ACCESS_TOKEN',
        scope: 'acme/service-bindings/github-acme',
        operation: 'information_asset.capture',
      });
      return 'scoped-broker-token';
    });
    registerSecretResolver({ name: 'capture-fixture-broker', resolve });
    let capturedToken = '';
    fixture.execute.mockImplementationOnce(async (context) => {
      capturedToken = (context as { binding: { accessToken: string } }).binding.accessToken;
      return { result: [{ number: 1 }] };
    });
    await scoped(() => executeInformationAssetCapture(location, request));
    expect(capturedToken).toBe('scoped-broker-token');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fixture.ambientConnection).not.toHaveBeenCalled();
    expect(fixture.ambientBinding).not.toHaveBeenCalled();
  });
  it('uses a scoped GWS broker token in an isolated disposable HOME without operator credentials', async () => {
    const mailLocation = {
      ...location,
      service_id: 'google-workspace',
      collector_id: 'gmail.history',
      selectors: {},
      asset_type: 'customer.request',
    };
    fixture.location = structuredClone(mailLocation);
    Object.assign(fixture.selected, {
      service_id: 'google-workspace',
      auth_mode: 'secret-guard',
      target: 'me',
      allowed_actions: ['gmail_profile_get'],
      secret_refs: ['GOOGLE_WORKSPACE_CLI_TOKEN'],
      approval_policy: { gmail_profile_get: 'allowed' },
    });
    fixture.preset.operations.gmail_profile_get = {
      type: 'cli',
      command: 'gws',
      args: ['gmail', 'users', 'getProfile', '--params', '{{params}}'],
      kind: 'capture',
      risk: 'read',
      approval_required: false,
    };
    const resolve = vi.fn(async () => 'broker-gmail-token');
    registerSecretResolver({ name: 'capture-gws-broker', resolve });
    let isolatedHome = '';
    fixture.execute.mockImplementationOnce(async (context) => {
      const input = context as { captureProviderEnvironment: Record<string, string> };
      expect(input.captureProviderEnvironment.GOOGLE_WORKSPACE_CLI_TOKEN).toBe(
        'broker-gmail-token'
      );
      isolatedHome = input.captureProviderEnvironment.HOME!;
      expect(isolatedHome).toContain('/active/shared/tmp/confidential/acme/');
      expect(input.captureProviderEnvironment.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe(isolatedHome);
      return { result: [{ number: 1 }] };
    });
    await scoped(() =>
      executeInformationAssetCapture(
        mailLocation,
        {
          service_id: 'google-workspace',
          action: 'gmail_profile_get',
          params: { params: { userId: 'me' } },
        },
        { rootDir: 'active/shared/tmp/capture-broker-gws-fixture' }
      )
    );
    expect(isolatedHome).not.toBe(process.env.HOME);
    expect(resolve).toHaveBeenCalledWith({
      key: 'GOOGLE_WORKSPACE_CLI_TOKEN',
      scope: 'acme/service-bindings/github-acme',
      operation: 'information_asset.capture',
    });
    expect(fixture.ambientBinding).not.toHaveBeenCalled();
    expect(fixture.ambientConnection).not.toHaveBeenCalled();
  });
  it('checks revocation again after broker resolution and sends no traffic', async () => {
    fixture.selected.auth_mode = 'secret-guard';
    fixture.selected.secret_refs = ['GITHUB_ACCESS_TOKEN'];
    registerSecretResolver({
      name: 'capture-revoking-broker',
      resolve: async () => {
        fixture.selected.approval_policy.list_pulls = 'denied';
        return 'revoked-broker-token';
      },
    });
    await expect(scoped(() => executeInformationAssetCapture(location, request))).rejects.toThrow();
    expect(fixture.execute).not.toHaveBeenCalled();
  });
  it('holds unsupported opaque refs and rejects mismatched provider targets before traffic', async () => {
    fixture.selected.auth_mode = 'secret-guard';
    fixture.selected.secret_refs = ['vault://unsupported'];
    await scoped(() =>
      withTaskCredentialBinding(
        { tenantSlug: 'acme', secrets: { GITHUB_ACCESS_TOKEN: 'bound-token' } },
        async () => {
          await expect(executeInformationAssetCapture(location, request)).rejects.toThrow(
            'secret_ref_unsupported'
          );
        }
      )
    );
    fixture.selected.auth_mode = 'none';
    fixture.selected.secret_refs = [];
    fixture.selected.target = 'other/repo';
    await expect(scoped(() => executeInformationAssetCapture(location, request))).rejects.toThrow(
      'target_mismatch'
    );
    expect(fixture.execute).not.toHaveBeenCalled();
  });
  it('denies cross-tenant and cross-organization scope before transport', async () => {
    expect(currentExecutionScope()?.organizationId).not.toBe('engineering');
    await expect(executeInformationAssetCapture(location, request)).rejects.toThrow();
    await expect(
      withExecutionContextAsync(
        'organization_operator',
        () => executeInformationAssetCapture(location, request),
        undefined,
        'other',
        'engineering'
      )
    ).rejects.toThrow();
    await expect(
      withExecutionContextAsync(
        'organization_operator',
        () => executeInformationAssetCapture(location, request),
        undefined,
        'acme',
        'other'
      )
    ).rejects.toThrow();
    expect(fixture.execute).not.toHaveBeenCalled();
  });
  it('rejects changed params, reuse, stale registrations and revoked grants', async () => {
    await scoped(async () => {
      const capability = await issueInformationAssetCaptureAdmission(location, request);
      await expect(
        consumeInformationAssetCaptureAdmission(
          capability,
          'github',
          'list_pulls',
          { vars: { owner: 'other' } },
          fixture.preset
        )
      ).rejects.toThrow('admission_denied');
      await expect(
        consumeInformationAssetCaptureAdmission(
          capability,
          'github',
          'list_pulls',
          request.params,
          fixture.preset
        )
      ).rejects.toThrow('admission_denied');
      const stale = await issueInformationAssetCaptureAdmission(location, request);
      fixture.location!.version++;
      await expect(
        consumeInformationAssetCaptureAdmission(
          stale,
          'github',
          'list_pulls',
          request.params,
          fixture.preset
        )
      ).rejects.toThrow('location_changed');
      fixture.location = structuredClone(location);
      const revoked = await issueInformationAssetCaptureAdmission(location, request);
      fixture.revoked = true;
      await expect(
        consumeInformationAssetCaptureAdmission(
          revoked,
          'github',
          'list_pulls',
          request.params,
          fixture.preset
        )
      ).rejects.toThrow('authorization refused');
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });
  it('rejects expired capabilities and changed preset bytes', async () => {
    await scoped(async () => {
      const capability = await issueInformationAssetCaptureAdmission(location, request);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30001);
      try {
        await expect(
          consumeInformationAssetCaptureAdmission(
            capability,
            'github',
            'list_pulls',
            request.params,
            fixture.preset
          )
        ).rejects.toThrow('admission_denied');
      } finally {
        clock.mockRestore();
      }
      const changed = await issueInformationAssetCaptureAdmission(location, request);
      fixture.preset.operations.list_pulls!.path = 'changed-route';
      await expect(
        consumeInformationAssetCaptureAdmission(
          changed,
          'github',
          'list_pulls',
          request.params,
          fixture.preset
        )
      ).rejects.toThrow('admission_denied');
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });
  it('rejects raw undeclared/read inference and mutation declarations', async () => {
    await scoped(async () => {
      delete fixture.preset.operations.list_pulls!.kind;
      await expect(executeInformationAssetCapture(location, request)).rejects.toThrow(
        'explicit_capture_read'
      );
      Object.assign(fixture.preset.operations.list_pulls!, {
        kind: 'apply',
        risk: 'write',
        method: 'POST',
      });
      await expect(executeInformationAssetCapture(location, request)).rejects.toThrow(
        'explicit_capture_read'
      );
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });
  it('sanitizes provider errors while retaining machine-readable status for expiry holds', async () => {
    fixture.execute.mockRejectedValueOnce(
      Object.assign(new Error('credential-shaped provider detail'), { status: 404 })
    );
    const error = await scoped(() => executeInformationAssetCapture(location, request)).catch(
      (value) => value as Error & { status: number }
    );
    expect(error).toMatchObject({ message: 'information_asset_capture_failed', status: 404 });
    expect(String(error)).not.toContain('credential-shaped');
  });
});
