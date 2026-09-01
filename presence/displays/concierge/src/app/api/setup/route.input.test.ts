import { describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const guard = vi.hoisted(() => vi.fn(() => null));
const writes = vi.hoisted(() => ({
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  writeTenantProfile: vi.fn(),
  applyBrowserOnboarding: vi.fn(),
}));

vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: guard }));
vi.mock('../../../lib/viewer-context', () => ({ resolveConciergeViewer: vi.fn() }));
vi.mock('../../../lib/i18n', () => ({
  conciergeText: vi.fn((key: string) => key),
  resolveConciergeLocale: vi.fn(() => 'en'),
}));
vi.mock('@agent/core/foundation', () => ({
  getRegisteredEnvText: vi.fn(() => undefined),
  readJson: vi.fn(() => ({})),
}));
vi.mock('@agent/core/browser-onboarding', () => ({
  applyBrowserOnboarding: writes.applyBrowserOnboarding,
  getBrowserOnboardingState: vi.fn(() => ({})),
  saveBrowserOnboardingVoiceSample: vi.fn(),
}));
vi.mock('@agent/core/reasoning-bootstrap', () => ({ getInstalledReasoningMode: vi.fn() }));
vi.mock('@agent/core/agent-identity', () => ({ listAgentIdentities: vi.fn(() => []) }));
vi.mock('@agent/core/tenant-registry', () => ({
  listTenantProfileSlugs: vi.fn(() => []),
  readTenantProfile: vi.fn(),
  writeTenantProfile: writes.writeTenantProfile,
}));
vi.mock('@agent/core/operator-notifications', () => ({
  loadNotificationPreferences: vi.fn(() => ({})),
}));
vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: vi.fn(() => '/tmp/profile'),
}));
vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: {
    rootResolve: vi.fn((value: string) => `/tmp/repo/${value}`),
    toRepoRelative: vi.fn((value: string) => value),
  },
}));
vi.mock('@agent/core/surface-runtime', () => ({
  loadSurfaceManifest: vi.fn(() => ({ surfaces: [] })),
}));
vi.mock('@agent/core/surface-role-catalog', () => ({
  loadSurfaceRoleCatalog: vi.fn(() => ({ roles: [] })),
}));
vi.mock('@agent/core/secure-io', () => ({
  safeExistsSync: vi.fn(() => false),
  safeMkdir: writes.safeMkdir,
  safeWriteFile: writes.safeWriteFile,
  withSensitivePathMediation: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/authority', () => ({
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
  ])('rejects %s before any write', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('api.onboarding_input');
    expect(writes.safeWriteFile).not.toHaveBeenCalled();
    expect(writes.writeTenantProfile).not.toHaveBeenCalled();
    expect(writes.applyBrowserOnboarding).not.toHaveBeenCalled();
  });
});
