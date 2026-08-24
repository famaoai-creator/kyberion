import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizePresenceStudioRequest,
  presenceStudioRecordInScope,
  type PresenceStudioViewerContext,
} from '../security.js';
import { buildPresenceHeadlessManifest } from '../headless.js';

function request(remoteAddress: string, authorization?: string) {
  return {
    socket: { remoteAddress },
    headers: authorization ? { authorization } : {},
  } as never;
}

const remoteViewer: PresenceStudioViewerContext = {
  principalId: 'human:test',
  tenantSlugs: ['tenant-a'],
  source: 'token',
};

describe('Presence Studio headless boundary', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('fails closed when remote mode has no token', () => {
    vi.stubEnv('PRESENCE_STUDIO_ALLOW_REMOTE', 'true');
    vi.stubEnv('PRESENCE_STUDIO_TOKEN', '');

    expect(authorizePresenceStudioRequest(request('198.51.100.24'))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('does not project unscoped or other-tenant records to remote viewers', () => {
    expect(presenceStudioRecordInScope(remoteViewer, { tenant_slug: 'tenant-a' })).toBe(true);
    expect(presenceStudioRecordInScope(remoteViewer, { tenant_slug: 'tenant-b' })).toBe(false);
    expect(
      presenceStudioRecordInScope(remoteViewer, { project_id: 'project-without-tenant' })
    ).toBe(false);
  });

  it('publishes scoped overview resources and no write operation', () => {
    const manifest = buildPresenceHeadlessManifest();
    expect(manifest.surface).toBe('presence-studio');
    expect(manifest.resources).toEqual([
      expect.objectContaining({ resource: 'overview', a2ui_path: '/api/headless/a2ui/overview' }),
    ]);
    expect(
      manifest.operations.find((operation) => operation.operation_id.endsWith('.a2ui'))
        ?.input_schema.properties
    ).toHaveProperty('tenant');
    expect(manifest.operations.every((operation) => operation.effect === 'read')).toBe(true);
  });
});
