import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
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
    artifact_id: 'ART-CONFIDENTIAL',
    tenant_slug: 'tenant-a',
    kind: 'markdown',
    storage_class: 'artifact_store',
    path: 'active/projects/confidential/tenant-a/report.md',
    preview_text: 'confidential preview',
  })),
}));

import { GET } from './route';

describe('deliverable-preview viewer tier authorization', () => {
  it('rejects a confidential inline preview for a public-only viewer', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/deliverable-preview?artifactId=ART-CONFIDENTIAL')
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
