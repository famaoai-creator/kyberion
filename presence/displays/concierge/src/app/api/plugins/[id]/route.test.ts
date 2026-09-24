import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  listManagedPlugins: vi.fn(),
  refreshManagedPluginActivation: vi.fn(),
  decideApprovalRequest: vi.fn(),
  loadApprovalRequest: vi.fn(),
}));

vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => null),
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({
    context: { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
  })),
}));
vi.mock('../../../../lib/front-desk-member', () => ({
  conciergeDecisionDenied: vi.fn(() => null),
  resolveConciergeDecidedBy: vi.fn(() => ({ id: 'owner-1', role: 'owner' })),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/plugin-managed-install', () => ({
  listManagedPlugins: mocks.listManagedPlugins,
  refreshManagedPluginActivation: mocks.refreshManagedPluginActivation,
}));
vi.mock('@agent/core/approval-store', () => ({
  decideApprovalRequest: mocks.decideApprovalRequest,
  loadApprovalRequest: mocks.loadApprovalRequest,
}));

import { POST } from './route.js';

function request(body: unknown, language = 'en'): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json', 'accept-language': language }),
    json: async () => body,
  } as unknown as NextRequest;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const mismatched = {
  pluginId: 'changed-plugin',
  trust: 'third-party',
  activationStatus: 'blocked_digest_mismatch',
  approvalChannel: 'plugin-install',
  approvalRequestId: 'req-1',
};

describe('concierge plugin decision route (EP-01 digest binding)', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listManagedPlugins.mockReturnValue([mismatched]);
  });

  it('refuses to approve a plugin that changed since approval', async () => {
    const response = await POST(request({ decision: 'approve' }), params('changed-plugin'));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { ok: boolean; error: string; plugin: unknown };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('changed after it was approved');
    expect(body.error).toContain('changed-plugin');
    expect(body.plugin).toMatchObject({ status: 'blocked_digest_mismatch' });
    expect(mocks.decideApprovalRequest).not.toHaveBeenCalled();
  });

  it('renders the reinstall message in Japanese', async () => {
    const response = await POST(request({ decision: 'approve' }, 'ja'), params('changed-plugin'));
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('再インストール');
  });
});
