import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const guard = vi.hoisted(() => vi.fn(() => null));
const writes = vi.hoisted(() => ({
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  writeTenantProfile: vi.fn(),
  applyBrowserOnboarding: vi.fn(),
  applyBrowserOnboardingSettingsPatch: vi.fn(async () => ({
    ok: true,
    applied_at: '2026-11-03T00:00:00.000Z',
    artifacts: [],
    warnings: [],
  })),
}));

vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: guard }));
const installation = vi.hoisted(() => ({
  gate: vi.fn((): { grant?: unknown; response?: Response } => ({
    grant: { allowed: true, mode: 'write' },
  })),
}));
vi.mock('../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({ context: { role: 'localadmin', source: 'token' } })),
}));
vi.mock('../../../lib/installation-access', () => ({
  requireConciergeInstallationAccess: installation.gate,
  resolveConciergeInstallationAccess: vi.fn(() => ({ allowed: true })),
}));
vi.mock('../../../lib/front-desk-member', () => ({ resolveConciergeDecidedBy: vi.fn(() => null) }));
vi.mock('../../../lib/i18n', () => ({
  conciergeText: vi.fn((key: string) => key),
  resolveConciergeLocale: vi.fn(() => 'en'),
}));
vi.mock('@agent/core/foundation', () => ({
  getRegisteredEnvText: vi.fn(() => undefined),
  nowIso: vi.fn(() => '2026-11-03T00:00:00.000Z'),
  readJson: vi.fn(() => ({})),
  readJsonObjectRequest: vi.fn(async (req: { json: () => Promise<unknown> }) => {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? { ok: true, body }
      : { ok: false, error: 'request body must be an object' };
  }),
}));
vi.mock('@agent/shared-vision/browser-onboarding', () => ({
  applyBrowserOnboarding: writes.applyBrowserOnboarding,
  applyBrowserOnboardingSettingsPatch: writes.applyBrowserOnboardingSettingsPatch,
  getBrowserOnboardingState: vi.fn(() => ({})),
  saveBrowserOnboardingVoiceSample: vi.fn(),
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  getInstalledReasoningMode: vi.fn(),
}));
vi.mock('@agent/core/agent/agent-identity', () => ({ listAgentIdentities: vi.fn(() => []) }));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: vi.fn(() => []),
  readTenantProfile: vi.fn(),
  writeTenantProfile: writes.writeTenantProfile,
}));
vi.mock('@agent/core/surface/operator-notifications', () => ({
  loadNotificationPreferences: vi.fn(() => ({})),
}));
vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: vi.fn(() => '/tmp/profile'),
}));
vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/repo'),
    knowledge: vi.fn((value: string) => `/tmp/repo/knowledge/${value}`),
    rootResolve: vi.fn((value: string) => `/tmp/repo/${value}`),
    toRepoRelative: vi.fn((value: string) => value),
  },
}));
vi.mock('@agent/core/surface/surface-runtime', () => ({
  loadSurfaceManifest: vi.fn(() => ({ surfaces: [] })),
}));
vi.mock('@agent/core/surface/surface-role-catalog', () => ({
  loadSurfaceRoleCatalog: vi.fn(() => ({ roles: [] })),
}));
vi.mock('@agent/core/secure-io', () => ({
  safeExistsSync: vi.fn(() => false),
  safeMkdir: writes.safeMkdir,
  safeWriteFile: writes.safeWriteFile,
  withSensitivePathMediation: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/authority', () => ({
  // S4: store facades open their declared store grant (withStoreGrant).
  withStoreGrant: (_name: string, fn: () => unknown) => fn(),
  withStoreGrantAsync: async (_name: string, fn: () => unknown) => fn(),
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
}));

import { POST } from './route.js';

function request(body: unknown) {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}

describe('concierge setup input contract', () => {
  it.each([
    ['null body', null],
    ['array body', []],
    ['tenant array', { action: 'save_management', tenant: [] }],
    ['agent object value', { action: 'save_management', agent: { provider: {} } }],
    ['vision array', { action: 'save_management', vision: [] }],
    ['sample refs object', { action: 'apply_onboarding', draft: { voice: { sample_refs: {} } } }],
    ['unknown root field', { action: 'save_management', debug: true }],
    ['unknown tenant field', { action: 'save_management', tenant: { debug: true } }],
    ['unknown agent field', { action: 'save_management', agent: { debug: true } }],
    ['settings patch with a draft', { action: 'save_settings', patch: {}, draft: {} }],
    ['settings patch array', { action: 'save_settings', patch: [] }],
  ])('rejects %s before any write', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('api.onboarding_input');
    expect(writes.safeWriteFile).not.toHaveBeenCalled();
    expect(writes.writeTenantProfile).not.toHaveBeenCalled();
    expect(writes.applyBrowserOnboarding).not.toHaveBeenCalled();
    expect(writes.applyBrowserOnboardingSettingsPatch).not.toHaveBeenCalled();
  });
});

describe('concierge setup installation write gate', () => {
  it('refuses a non-owner or un-stepped-up write before reading the body', async () => {
    installation.gate.mockReturnValueOnce({
      response: new Response(
        JSON.stringify({ ok: false, error: 'installation_step_up_required' }),
        {
          status: 403,
        }
      ),
    });
    const json = vi.fn(async () => ({ action: 'save_settings', patch: {} }));
    const response = await POST({
      headers: new Headers({ 'content-type': 'application/json' }),
      json,
    } as unknown as NextRequest);
    expect(response.status).toBe(403);
    expect(json).not.toHaveBeenCalled();
    expect(installation.gate).toHaveBeenLastCalledWith(
      expect.anything(),
      'write',
      expect.anything(),
      'setup update'
    );
    expect(writes.applyBrowserOnboardingSettingsPatch).not.toHaveBeenCalled();
  });
});

describe('concierge settings saves change only what was edited', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards a settings patch to the merging writer, never the full onboarding draft', async () => {
    const patch = { identity: { name: 'Renamed' }, voice: { sample_refs: ['voice/a.webm'] } };
    const response = await POST(request({ action: 'save_settings', patch }));

    expect(response.status).toBe(200);
    expect((await response.json()).onboarding.ok).toBe(true);
    expect(writes.applyBrowserOnboarding).not.toHaveBeenCalled();
    expect(writes.applyBrowserOnboardingSettingsPatch).toHaveBeenCalledWith({
      identity: { name: 'Renamed' },
      voice: { sample_refs: ['/tmp/repo/voice/a.webm'] },
    });
  });

  it('answers a malformed settings patch with 400 instead of a server error', async () => {
    const zodError = Object.assign(new Error('bad patch'), { name: 'ZodError' });
    writes.applyBrowserOnboardingSettingsPatch.mockRejectedValueOnce(zodError);
    const response = await POST(request({ action: 'save_settings', patch: { identity: {} } }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('api.onboarding_input');
  });

  it.each([
    ['no tenant', { action: 'save_management', agent: { agent_id: 'agent-1' } }],
    ['an unregistered tenant', { action: 'save_management', tenant: { slug: 'default' } }],
  ])('refuses save_management with %s instead of creating one', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'TENANT_SELECTION_REQUIRED',
      error: 'api.config.tenant_invalid',
    });
    expect(writes.writeTenantProfile).not.toHaveBeenCalled();
    expect(writes.safeWriteFile).not.toHaveBeenCalled();
  });
});
