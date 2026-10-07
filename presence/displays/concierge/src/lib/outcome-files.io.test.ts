import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ floor: '', entry: {} as Record<string, unknown> }));
vi.mock('@agent/core/deliverable-inbox', () => ({ listInboxEntries: () => [fixture.entry] }));
vi.mock('@agent/core/owner-scope', () => ({
  clearOwnerScopeCache: () => {},
  resolveOwnerScope: () => ({
    owner: { kind: 'mission', id: 'MSN-FILES' },
    tier: 'public',
    tenant: 'acme',
    organization_id: 'ORG',
    project_id: 'PRJ',
    dir: path.join(fixture.floor, 'public', 'acme', 'MSN-FILES'),
  }),
}));
vi.mock('@agent/core/path-resolver', async (original) => {
  const actual = await original<typeof import('@agent/core/path-resolver')>();
  return {
    ...actual,
    pathResolver: {
      ...actual.pathResolver,
      missionDir: (id: string, tier: string) => path.join(fixture.floor, tier, id),
    },
  };
});
vi.mock('@agent/core/mission/mission-state-reader', () => ({
  loadMissionStateAtPath: () => ({
    mission_id: 'MSN-FILES',
    tier: 'public',
    tenant_slug: 'acme',
    organization_id: 'ORG',
  }),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  resolveMemberByPrincipal: () => ({
    member_id: 'alice',
    status: 'active',
    memberships: [{ tenant_slug: 'acme', role: 'owner' }],
  }),
}));
vi.mock('@agent/core/surface/surface-authn', () => ({
  authorizeSurfaceContextOperation: () => ({ allowed: true }),
}));
vi.mock('./viewer-context', () => ({ toSurfaceAuthorizationContext: (viewer: unknown) => viewer }));
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { listOutcomeFiles, readOutcomeFile } from './outcome-files';
import type { ConciergeViewerContext } from './viewer-context';
const viewer: ConciergeViewerContext = {
  principalId: 'user:alice',
  memberId: 'alice',
  source: 'token',
  role: 'localadmin',
  tenantSlugs: ['acme'],
  organizationIds: ['ORG'],
  projectIds: ['PRJ'],
  tierAccess: ['public'],
};
const write = <T>(fn: () => T) => withExecutionContext('ecosystem_architect', fn);
const mission = () => path.join(fixture.floor, 'public/acme/MSN-FILES');
beforeAll(() => {
  fixture.floor = pathResolver.sharedTmp('outcome-delivery-files-' + randomUUID());
});
beforeEach(() =>
  write(() => {
    safeRmSync(fixture.floor, { recursive: true, force: true });
    safeMkdir(path.join(mission(), 'artifacts/report'), { recursive: true });
    safeWriteFile(path.join(mission(), 'mission-state.json'), '{}');
    fixture.entry = {
      entry_id: 'INBOX-FILES',
      mission_id: 'MSN-FILES',
      title: 'files',
      summary: '',
      status: 'unread',
      created_at: '2026-10-07',
      updated_at: '2026-10-07',
      artifact_paths: [path.join(mission(), 'artifacts/report/test.pdf')],
    };
  })
);
afterAll(() => write(() => safeRmSync(fixture.floor, { recursive: true, force: true })));
describe('outcome delivery real secure I/O', () => {
  it('round-trips the exact binary file through secure-io', () => {
    const bytes = Buffer.from('%PDF-1.7\n' + String.fromCharCode(0, 255, 3));
    write(() => safeWriteFile(path.join(mission(), 'artifacts/report/test.pdf'), bytes));
    const file = listOutcomeFiles(() => viewer, 'INBOX-FILES').files[0];
    expect(file.status).toBe('available');
    if (file.status !== 'available') throw new Error('missing file');
    expect(readOutcomeFile(() => viewer, 'INBOX-FILES', file.id).bytes).toEqual(bytes);
    write(() => safeWriteFile(path.join(mission(), 'artifacts/report/test.pdf'), '%PDF-tampered'));
    expect(() => readOutcomeFile(() => viewer, 'INBOX-FILES', file.id)).toThrow();
  });
  it('rejects a leaf symlink and a symlinked ancestor with real filesystem checks', () => {
    const outside = path.join(fixture.floor, 'other-file.pdf');
    write(() => {
      safeWriteFile(outside, '%PDF-secret');
      safeSymlinkSync(outside, path.join(mission(), 'artifacts/report/test.pdf'));
    });
    expect(listOutcomeFiles(() => viewer, 'INBOX-FILES').files[0].status).toBe('unavailable');
    write(() => {
      safeRmSync(path.join(mission(), 'artifacts/report'), { recursive: true, force: true });
      safeMkdir(path.join(fixture.floor, 'foreign'), { recursive: true });
      safeWriteFile(path.join(fixture.floor, 'foreign/test.pdf'), '%PDF-secret');
      safeSymlinkSync(
        path.join(fixture.floor, 'foreign'),
        path.join(mission(), 'artifacts/report'),
        'dir'
      );
    });
    expect(listOutcomeFiles(() => viewer, 'INBOX-FILES').files[0].status).toBe('unavailable');
  });
  it('rejects a missing file and invalid filesystem owner ancestry without exposing paths', () => {
    const page = listOutcomeFiles(() => viewer, 'INBOX-FILES');
    expect(page.files[0].status).toBe('unavailable');
    expect(JSON.stringify(page)).not.toContain(fixture.floor);
  });
});
