import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  stage: vi.fn(),
}));
vi.mock('../src/lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../src/lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({
    context: {
      tenantSlugs: 'all',
      organizationIds: 'all',
      projectIds: ['project-a'],
      tierAccess: ['public'],
      principalId: 'authenticated-uploader',
    },
  }),
}));
vi.mock('@agent/core/project/project-registry', () => ({
  loadProjectRecord: (id: string) =>
    id === 'project-a' ? { project_id: id, tier: 'public' } : null,
}));
vi.mock('@agent/core/surface/scoped-workspace-ingest', () => ({
  ingestScopedWorkspaceDocument: mocks.ingest,
}));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeWriteFile: mocks.stage,
  safeExecResult: mocks.stage,
}));
import { POST } from '../src/app/api/ingest/route';

function request(project: string, extra: Record<string, string> = {}) {
  const body = new FormData();
  body.set('file', new File(['# reusable context'], 'note.md', { type: 'text/markdown' }));
  body.set('project_id', project);
  for (const [key, value] of Object.entries(extra)) body.set(key, value);
  return new NextRequest('http://localhost/api/ingest', { method: 'POST', body });
}
describe('scoped upload HTTP admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ingest.mockResolvedValue({
      outcome: 'committed',
      artifact_id: 'ART-test',
      name: 'note',
      scope: { tier: 'public', project_id: 'project-a' },
    });
  });
  it('passes canonical parentless project and authenticated actor to the durable facade with a renderable response', async () => {
    const response = await POST(request('project-a'));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.message).toEqual(expect.any(String));
    expect(result.summary).toMatchObject({
      tenant: '',
      artifact_id: 'ART-test',
      scope: { tier: 'public', project_id: 'project-a' },
    });
    expect(mocks.ingest).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        actorId: 'authenticated-uploader',
        workspace: expect.objectContaining({
          selection: { kind: 'project', tier: 'public', project_id: 'project-a' },
        }),
      })
    );
    expect(mocks.stage).not.toHaveBeenCalled();
  });
  it('rejects a foreign project and forged parent before durable or subprocess side effects', async () => {
    expect((await POST(request('project-foreign'))).status).toBe(403);
    expect((await POST(request('project-a', { organization_id: 'forged-org' }))).status).toBe(403);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });
});
