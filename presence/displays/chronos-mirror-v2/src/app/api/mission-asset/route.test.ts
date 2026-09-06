import { describe, expect, it } from 'vitest';

import { resolveMissionAssetTenant, resolveMissionAssetTier } from './route';

describe('mission-asset tier resolution', () => {
  it('derives the tier from a canonical repo-relative asset path', () => {
    expect(
      resolveMissionAssetTier({
        assetPath: 'active/projects/confidential/tenant-a/project/report.md',
      })
    ).toBe('confidential');
  });

  it('prefers the governed artifact metadata when the path is shared', () => {
    expect(
      resolveMissionAssetTier({
        artifact: {
          artifact_id: 'ART-TIER',
          kind: 'markdown',
          storage_class: 'artifact_store',
          path: 'active/shared/exports/report.md',
          metadata: { sensitivity_tier: 'confidential' },
        },
        assetPath: 'active/shared/exports/report.md',
      })
    ).toBe('confidential');
  });

  it('returns undefined when the governing tier cannot be established', () => {
    expect(
      resolveMissionAssetTier({ assetPath: 'active/shared/exports/legacy-report.md' })
    ).toBeUndefined();
    expect(
      resolveMissionAssetTier({ assetPath: 'active/shared/exports/public/report.md' })
    ).toBeUndefined();
  });

  it('binds a tiered project path to its tenant segment', () => {
    expect(
      resolveMissionAssetTenant({
        assetPath: 'active/projects/confidential/tenant-a/project/report.md',
      })
    ).toBe('tenant-a');
  });

  it('prefers the path tenant when a tiered asset path is available', () => {
    expect(
      resolveMissionAssetTenant({
        artifact: {
          artifact_id: 'ART-TENANT',
          tenant_slug: 'tenant-a',
          kind: 'markdown',
          storage_class: 'artifact_store',
        },
        assetPath: 'active/projects/confidential/tenant-b/project/report.md',
      })
    ).toBe('tenant-b');
  });
});
