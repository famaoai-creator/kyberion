import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadServiceEndpointsCatalog: vi.fn(),
  inspectServiceAuth: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
  safeExistsSync: vi.fn(),
  rootDir: vi.fn(() => '/tmp/kyberion'),
  resolveOverlay: vi.fn(),
  overlayCandidates: vi.fn(),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    loadServiceEndpointsCatalog: mocks.loadServiceEndpointsCatalog,
    inspectServiceAuth: mocks.inspectServiceAuth,
    logger: mocks.logger,
    safeExistsSync: mocks.safeExistsSync,
    pathResolver: { ...actual.pathResolver, rootDir: mocks.rootDir },
    customerResolver: {
      ...actual.customerResolver,
      resolveOverlay: mocks.resolveOverlay,
      overlayCandidates: mocks.overlayCandidates,
    },
  };
});

// scripts/services_setup.ts imports these directly from their submodules
// (SX simplicity abstraction pass, commit a877d9c12) rather than the
// aggregate `@agent/core` entry point mocked above, so the fixtures above
// never reached the real call sites — mock the actual import sites too.
vi.mock('@agent/core/service/service-endpoint-registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/core/service/service-endpoint-registry')>();
  return {
    ...actual,
    loadServiceEndpointsCatalog: mocks.loadServiceEndpointsCatalog,
  };
});

vi.mock('@agent/core/service/service-validator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/service/service-validator')>();
  return {
    ...actual,
    inspectServiceAuth: mocks.inspectServiceAuth,
  };
});

vi.mock('@agent/core/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/core')>();
  return {
    ...actual,
    logger: mocks.logger,
  };
});

vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExistsSync: mocks.safeExistsSync,
  };
});

vi.mock('@agent/core/path-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/path-resolver')>();
  return {
    ...actual,
    pathResolver: { ...actual.pathResolver, rootDir: mocks.rootDir },
  };
});

vi.mock('@agent/core/stance-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/stance-resolver')>();
  return {
    ...actual,
    resolveOverlay: mocks.resolveOverlay,
    overlayCandidates: mocks.overlayCandidates,
  };
});

vi.mock('@agent/core/service/service-connection-readiness', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/core/service/service-connection-readiness')>();
  return {
    ...actual,
    requiredServiceConnectionKeys: (serviceId: string) =>
      serviceId === 'voice' ? ['voice_python_bin', 'voice_name'] : [],
    isServiceConnectionReady: () => true,
  };
});

vi.mock('@agent/core/service/service-onboarding-catalog', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/core/service/service-onboarding-catalog')>();
  return {
    ...actual,
    getServiceOnboardingCatalogEntry: (serviceId: string) =>
      serviceId === 'voice' ? { service_id: 'voice', prompt_kind: 'generic', label: 'TTS' } : null,
  };
});

describe('services_setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports auth and connection readiness for external services', async () => {
    const { setupServices } = await import('../scripts/services_setup');

    mocks.loadServiceEndpointsCatalog.mockReturnValue({
      version: '1.0.0',
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        slack: {
          preset_path: 'knowledge/product/orchestration/service-presets/slack.json',
          auth_strategy: 'bearer',
        },
        github: {
          preset_path: 'knowledge/product/orchestration/service-presets/github.json',
          auth_strategy: 'basic',
        },
        voice: {
          preset_path: 'knowledge/product/orchestration/service-presets/voice.json',
          auth_strategy: 'none',
        },
      },
    });
    mocks.inspectServiceAuth.mockImplementation((serviceId: string) => {
      if (serviceId === 'slack') {
        return {
          serviceId,
          presetPath: 'knowledge/product/orchestration/service-presets/slack.json',
          authStrategy: 'bearer',
          valid: false,
          reason: 'Missing token',
          requiredSecrets: ['SLACK_ACCESS_TOKEN'],
          foundSecrets: [],
          missingSecrets: ['SLACK_ACCESS_TOKEN'],
          cliFallbacks: ['slack-cli'],
          setupHint: 'Set one of: SLACK_ACCESS_TOKEN',
        };
      }
      if (serviceId === 'github') {
        return {
          serviceId,
          presetPath: 'knowledge/product/orchestration/service-presets/github.json',
          authStrategy: 'basic',
          valid: true,
          requiredSecrets: ['GITHUB_CLIENT_ID'],
          foundSecrets: ['GITHUB_CLIENT_ID'],
          missingSecrets: [],
          cliFallbacks: [],
          setupHint: 'Ready. Detected secrets: GITHUB_CLIENT_ID',
        };
      }
      return {
        serviceId,
        presetPath: 'knowledge/product/orchestration/service-presets/voice.json',
        authStrategy: 'none',
        valid: true,
        requiredSecrets: [],
        foundSecrets: [],
        missingSecrets: [],
        cliFallbacks: [],
        setupHint: 'No secrets needed for this preset.',
      };
    });
    mocks.overlayCandidates.mockImplementation((subPath: string) => {
      if (subPath.includes('slack.json')) {
        return {
          overlay: '/tmp/kyberion/customer/acme/connections/slack.json',
          base: '/tmp/kyberion/knowledge/personal/connections/slack.json',
        };
      }
      return {
        overlay: '/tmp/kyberion/customer/acme/connections/github.json',
        base: '/tmp/kyberion/knowledge/personal/connections/github.json',
      };
    });
    mocks.resolveOverlay.mockImplementation((subPath: string) => {
      if (subPath.includes('slack.json'))
        return '/tmp/kyberion/customer/acme/connections/slack.json';
      if (subPath.includes('github.json'))
        return '/tmp/kyberion/customer/acme/connections/github.json';
      return null;
    });
    mocks.safeExistsSync.mockImplementation(
      (p: string) => p === '/tmp/kyberion/customer/acme/connections/slack.json'
    );

    const result = await setupServices();

    expect(result.status).toBe('ok');
    expect(result.summary).toMatchObject({
      total: 3,
      authMissing: 1,
      connectionMissing: 1,
      connectionOptional: 1,
      ready: 2,
    });
    expect(result.rows[0]).toMatchObject({
      service: 'slack',
      auth: 'missing',
      connection: 'customer',
    });
    expect(result.rows[0].nextAction?.suggested_command).toBeUndefined();
    expect(result.rows[0].nextAction?.suggested_followup_request).toContain('SLACK_ACCESS_TOKEN');

    // Services that declare no connection keys are informational, not missing.
    const github = result.rows.find((row) => row.service === 'github');
    expect(github).toMatchObject({ auth: 'ready', connection: 'optional' });
    expect(github?.nextAction).toBeUndefined();

    // Only services whose connection file declares required keys are reported
    // missing, and only onboarding-catalog services get the wizard command.
    const voice = result.rows.find((row) => row.service === 'voice');
    expect(voice).toMatchObject({
      auth: 'ready',
      connection: 'missing',
      connectionReady: false,
    });
    expect(voice?.nextAction?.suggested_command).toBe(
      'pnpm onboarding -- --services-only --service voice'
    );
  });
});
