import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { reduceDiscussionRoom } from '@agent/core/discussion/discussion-reducer';
import { readDiscussionRoom } from '@agent/core/discussion/discussion-store';
import {
  readSavedDiscussionArtifact,
  SavedDiscussionArtifactError,
} from '@agent/core/discussion/discussion-outcomes';
import { resolveViewerContextForRequest } from '../../../../../../lib/viewer-context';
import { guardRequest, requireChronosAccess } from '../../../../../../lib/api-guard';
import { GET } from './route';
import { GET as genericAssetGET } from '../../../../mission-asset/route';

vi.mock('../../../../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  getChronosAccessRoleOrThrow: vi.fn(() => 'readonly'),
  roleToMissionRole: vi.fn(() => 'chronos_readonly'),
}));
vi.mock('../../../../../../lib/viewer-context', async (original) => ({
  ...(await original<typeof import('../../../../../../lib/viewer-context')>()),
  resolveViewerContextForRequest: vi.fn(),
  withViewerExecutionContext: vi.fn((_viewer, action) => action()),
}));
vi.mock('@agent/core/discussion/discussion-store', async (original) => ({
  ...(await original<typeof import('@agent/core/discussion/discussion-store')>()),
  readDiscussionRoom: vi.fn(),
}));
vi.mock('@agent/core/discussion/discussion-outcomes', async (original) => ({
  ...(await original<typeof import('@agent/core/discussion/discussion-outcomes')>()),
  readSavedDiscussionArtifact: vi.fn(),
}));

const viewer = () => ({
  role: 'readonly' as const,
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public', 'confidential'] as Array<'public' | 'confidential'>,
  principalId: 'viewer-a',
  source: 'token' as const,
});
const request = () =>
  new NextRequest(
    'http://localhost/api/discussions/disc-1/artifacts/ART-1?tenant=tenant-b&path=events.jsonl'
  );
const params = (id = 'disc-1', artifactId = 'ART-1') => ({
  params: Promise.resolve({ id, artifactId }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(guardRequest).mockReturnValue(null);
  vi.mocked(requireChronosAccess).mockReturnValue(null);
  vi.mocked(resolveViewerContextForRequest).mockReturnValue({ context: viewer() });
  const room = reduceDiscussionRoom('disc-1', []);
  room.scope = {
    tenant_slug: 'tenant-a',
    organization_id: 'org-a',
    project_id: 'project-a',
    tier: 'confidential',
  };
  vi.mocked(readDiscussionRoom).mockReturnValue(room);
  vi.mocked(readSavedDiscussionArtifact).mockReturnValue({
    name: 'brief.html',
    kind: 'html',
    bytes: Buffer.from('<script>unsafe()</script><h1>Saved bytes</h1>'),
    sha256: 'a'.repeat(64),
  });
});

describe('saved discussion artifact authorization', () => {
  it('serves saved bytes with no-script opaque sandbox and private no-store headers', async () => {
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<script>unsafe()</script><h1>Saved bytes</h1>');
    expect(response.headers.get('X-Artifact-Integrity')).toBe('verified');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "sandbox; default-src 'none'"
    );
    expect(response.headers.get('Content-Security-Policy')).not.toContain('allow-scripts');
    expect(response.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(readSavedDiscussionArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'disc-1' }),
      'ART-1'
    );
  });

  it.each(['tenant_slug', 'organization_id', 'project_id'] as const)(
    'blocks cross-%s scope before artifact read',
    async (field) => {
      const room = vi.mocked(readDiscussionRoom).getMockImplementation()!('disc-1')!;
      room.scope[field] = 'other';
      const response = await GET(request(), params());
      expect(response.status).toBe(403);
      expect(readSavedDiscussionArtifact).not.toHaveBeenCalled();
    }
  );

  it('blocks insufficient tiers and unscoped rooms for tenant-limited viewers', async () => {
    vi.mocked(resolveViewerContextForRequest).mockReturnValueOnce({
      context: { ...viewer(), tierAccess: ['public'] },
    });
    expect((await GET(request(), params())).status).toBe(403);
    const room = vi.mocked(readDiscussionRoom).getMockImplementation()!('disc-1')!;
    room.scope = {};
    expect((await GET(request(), params())).status).toBe(403);
    expect(readSavedDiscussionArtifact).not.toHaveBeenCalled();
  });

  it('honors guard, access, and authenticated viewer failures before room access', async () => {
    for (const seam of [guardRequest, requireChronosAccess]) {
      vi.mocked(seam).mockReturnValueOnce(new Response(null, { status: 401 }) as never);
      expect((await GET(request(), params())).status).toBe(401);
    }
    vi.mocked(resolveViewerContextForRequest).mockReturnValueOnce({
      response: new Response(null, { status: 403 }) as never,
    });
    expect((await GET(request(), params())).status).toBe(403);
    expect(readDiscussionRoom).not.toHaveBeenCalled();
    expect(readSavedDiscussionArtifact).not.toHaveBeenCalled();
  });

  it('returns not found for absent rooms or unknown artifact bindings', async () => {
    vi.mocked(readDiscussionRoom).mockReturnValueOnce(null);
    expect((await GET(request(), params())).status).toBe(404);
    expect(readSavedDiscussionArtifact).not.toHaveBeenCalled();
    vi.mocked(readSavedDiscussionArtifact).mockReturnValueOnce(null);
    expect((await GET(request(), params())).status).toBe(404);
  });

  it('marks legacy and mismatched evidence unavailable without returning saved content', async () => {
    for (const code of ['unverified', 'integrity_mismatch', 'unavailable'] as const) {
      vi.mocked(readSavedDiscussionArtifact).mockImplementationOnce(() => {
        throw new SavedDiscussionArtifactError(code, 'Use the current brief view.');
      });
      const response = await GET(request(), params());
      expect(response.status).toBe(409);
      expect(response.headers.get('X-Artifact-Integrity')).toBe('unverified');
      expect(await response.json()).toEqual({
        ok: false,
        error: 'Use the current brief view.',
        error_code: 'saved_artifact_' + code,
      });
    }
  });

  it('rejects invalid room identifiers before loading a room', async () => {
    for (const id of ['..', '.', ' disc-1'])
      expect((await GET(request(), params(id))).status).toBe(400);
    expect(readDiscussionRoom).not.toHaveBeenCalled();
  });

  it('keeps the generic mission-asset route closed to discussion runtime files', async () => {
    for (const name of ['brief.html', 'minutes.md', 'events.jsonl']) {
      const response = await genericAssetGET(
        new NextRequest(
          'http://localhost/api/mission-asset?path=active/shared/runtime/discussions/disc-1/' + name
        )
      );
      expect(response.status).toBe(400);
    }
  });
});
