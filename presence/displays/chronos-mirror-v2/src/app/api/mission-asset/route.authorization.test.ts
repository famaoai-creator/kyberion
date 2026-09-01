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

vi.mock('@agent/core/artifact-record', () => ({
  loadArtifactRecord: vi.fn(() => ({
    artifact_id: 'ART-TENANT-A',
    tenant_slug: 'tenant-a',
    kind: 'markdown',
    storage_class: 'artifact_store',
  })),
}));

import { GET } from './route';

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
});
