import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadServiceEndpointsCatalog: vi.fn(),
  inspectServiceAuth: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
  safeExistsSync: vi.fn(),
  rootDir: vi.fn(() => '/tmp/kyberion'),
  resolveOverlay: vi.fn(),
  overlayCandidates: vi.fn(),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    loadServiceEndpointsCatalog: mocks.loadServiceEndpointsCatalog,
    inspectServiceAuth: mocks.inspectServiceAuth,
    logger: mocks.logger,
    safeExistsSync: mocks.safeExistsSync,
    pathResolver: { ...(actual as any).pathResolver, rootDir: mocks.rootDir },
    customerResolver: {
      ...(actual as any).customerResolver,
      resolveOverlay: mocks.resolveOverlay,
      overlayCandidates: mocks.overlayCandidates,
    },
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
          preset_path: 'knowledge/public/orchestration/service-presets/slack.json',
          auth_strategy: 'bearer',
        },
        github: {
          preset_path: 'knowledge/public/orchestration/service-presets/github.json',
          auth_strategy: 'basic',
        },
      },
    });
    mocks.inspectServiceAuth.mockImplementation((serviceId: string) => {
      if (serviceId === 'slack') {
        return {
          serviceId,
          presetPath: 'knowledge/public/orchestration/service-presets/slack.json',
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
      return {
        serviceId,
        presetPath: 'knowledge/public/orchestration/service-presets/github.json',
        authStrategy: 'basic',
        valid: true,
        requiredSecrets: ['GITHUB_CLIENT_ID'],
        foundSecrets: ['GITHUB_CLIENT_ID'],
        missingSecrets: [],
        cliFallbacks: [],
        setupHint: 'Ready. Detected secrets: GITHUB_CLIENT_ID',
      };
    });
    mocks.overlayCandidates.mockImplementation((subPath: string) => {
      if (subPath.includes('slack.json')) {
        return { overlay: '/tmp/kyberion/customer/acme/connections/slack.json', base: '/tmp/kyberion/knowledge/personal/connections/slack.json' };
      }
      return { overlay: '/tmp/kyberion/customer/acme/connections/github.json', base: '/tmp/kyberion/knowledge/personal/connections/github.json' };
    });
    mocks.resolveOverlay.mockImplementation((subPath: string) => {
      if (subPath.includes('slack.json')) return '/tmp/kyberion/customer/acme/connections/slack.json';
      if (subPath.includes('github.json')) return '/tmp/kyberion/customer/acme/connections/github.json';
      return null;
    });
    mocks.safeExistsSync.mockImplementation((p: string) => p === '/tmp/kyberion/customer/acme/connections/slack.json');

    const result = await setupServices();

    expect(result.status).toBe('ok');
    expect(result.summary).toMatchObject({
      total: 2,
      authMissing: 1,
      connectionMissing: 1,
      ready: 1,
    });
    expect(result.rows[0]).toMatchObject({
      service: 'slack',
      auth: 'missing',
      connection: 'customer',
    });
    expect(result.rows[1]).toMatchObject({
      service: 'github',
      auth: 'ready',
      connection: 'missing',
    });
  });
});
