import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  getChronosAccessRoleOrThrow: vi.fn(() => 'readonly'),
  roleToMissionRole: vi.fn(() => 'mission_controller'),
}));

vi.mock('../../../lib/viewer-context', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/viewer-context')>(
    '../../../lib/viewer-context'
  );
  return {
    ...actual,
    resolveViewerContextForRequest: vi.fn(() => ({
      context: {
        role: 'readonly',
        tenantSlugs: 'all',
        tierAccess: ['public'],
        principalId: 'test-viewer',
        source: 'loopback',
      },
    })),
  };
});

vi.mock('@agent/core/workforce/artifact-record', () => ({
  loadArtifactRecord: vi.fn(() => ({
    artifact_id: 'ART-TENANT-A',
    tenant_slug: 'tenant-a',
    kind: 'markdown',
    storage_class: 'artifact_store',
  })),
}));

import { GET } from './route';
import { resolveViewerContextForRequest } from '../../../lib/viewer-context';

describe('mission-asset viewer tier authorization', () => {
  it('rejects a confidential asset for a public-only viewer before reading it', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/mission-asset?path=active/projects/confidential/tenant-a/report.md'
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it('rejects an artifact id whose tenant conflicts with the requested path', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/mission-asset?artifactId=ART-TENANT-A&path=active/projects/confidential/tenant-b/report.md'
      )
    );

    expect(response.status).toBe(403);
  });

  it('serves only organization artifacts, never organization state', async () => {
    for (const assetPath of [
      'active/organizations/public/shared/org-a/state/operational-state.json',
      // `.`/empty segments would shift the parsed owner after normalization.
      'active/organizations/./public/shared/artifacts/state.json',
      'active/organizations/public//shared/artifacts/x/state.json',
      'active/organizations/bogus/shared/org-a/artifacts/report/d.json',
    ]) {
      const response = await GET(
        new NextRequest(`http://localhost/api/mission-asset?path=${assetPath}`)
      );
      expect(response.status, assetPath).toBe(400);
    }
  });

  it("rejects another organization's artifact for an organization-scoped viewer", async () => {
    const scopedViewer = {
      context: {
        role: 'readonly',
        tenantSlugs: 'all',
        organizationIds: ['org-a'],
        tierAccess: ['public'],
        principalId: 'test-viewer',
        source: 'loopback',
      },
    };
    vi.mocked(resolveViewerContextForRequest).mockReturnValueOnce(scopedViewer as never);
    const outside = await GET(
      new NextRequest(
        'http://localhost/api/mission-asset?path=active/organizations/public/shared/org-b/artifacts/report/d.json'
      )
    );
    expect(outside.status).toBe(403);

    vi.mocked(resolveViewerContextForRequest).mockReturnValueOnce(scopedViewer as never);
    const own = await GET(
      new NextRequest(
        'http://localhost/api/mission-asset?path=active/organizations/public/shared/org-a/artifacts/report/missing.json'
      )
    );
    // Within scope: authorization passes and the (absent) file is a 404.
    expect(own.status).toBe(404);
  });
});
