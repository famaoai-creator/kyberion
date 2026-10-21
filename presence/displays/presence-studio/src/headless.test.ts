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

  it('publishes scoped overview resources; every write operation is a component-host action for localadmin', () => {
    const manifest = buildPresenceHeadlessManifest();
    expect(manifest.surface).toBe('presence-studio');
    expect(manifest.resources).toEqual([
      expect.objectContaining({ resource: 'overview', a2ui_path: '/api/headless/a2ui/overview' }),
      expect.objectContaining({ resource: 'components', query_path: '/api/components' }),
      expect.objectContaining({ resource: 'hearing', a2ui_path: '/api/headless/a2ui/hearing' }),
    ]);
    expect(
      manifest.operations.find((operation) => operation.operation_id === 'presence.overview.a2ui')
        ?.input_schema.properties
    ).toHaveProperty('tenant');
    // AU-02/03: the hearing flow's actions are the only write operations, and
    // each one demands the loopback localadmin + the write permission.
    const writes = manifest.operations.filter((operation) => operation.effect === 'write');
    expect(writes.map((operation) => operation.operation_id).sort()).toEqual([
      'presence.hearing.answer',
      'presence.hearing.decide',
      'presence.hearing.handoff',
    ]);
    for (const operation of writes) {
      expect(operation.required_role).toBe('localadmin');
      expect(operation.required_permissions).toContain('surface.headless.write');
    }
  });
});
