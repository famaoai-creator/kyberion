import { describe, expect, it } from 'vitest';

import { resolveRuntimeReferenceScope, resolveSafeRuntimeReferencePath } from './route';

describe('runtime-file scope resolution', () => {
  it('uses the governed tier and tenant path segments', () => {
    expect(
      resolveRuntimeReferenceScope('active/projects/confidential/tenant-a/skeleton.md', [])
    ).toEqual({ tier: 'confidential', tenantSlug: 'tenant-a' });
    expect(resolveRuntimeReferenceScope('active/projects/public/shared/skeleton.md', [])).toEqual({
      tier: 'public',
    });
  });

  it('resolves legacy project paths from the project registry', () => {
    expect(
      resolveRuntimeReferenceScope('active/projects/legacy-project/skeleton.md', [
        {
          project_id: 'PRJ-LEGACY',
          name: 'Legacy project',
          summary: '',
          status: 'active',
          tier: 'confidential',
          tenant_slug: 'tenant-a',
          repositories: [
            {
              repo_id: 'REPO-LEGACY',
              kind: 'project-root',
              root_path: 'active/projects/legacy-project',
            },
          ],
        },
      ])
    ).toEqual({ tier: 'confidential', tenantSlug: 'tenant-a' });
    expect(resolveRuntimeReferenceScope('active/projects/unknown/skeleton.md', [])).toBeNull();
  });

  it('does not mistake a legacy tier path filename for a tenant', () => {
    expect(
      resolveRuntimeReferenceScope('active/projects/public/skeleton.md', [
        {
          project_id: 'PRJ-LEGACY-TIER',
          name: 'Legacy tier project',
          summary: '',
          status: 'active',
          tier: 'public',
          repositories: [
            {
              repo_id: 'REPO-LEGACY-TIER',
              kind: 'project-root',
              root_path: 'active/projects/public',
            },
          ],
        },
      ])
    ).toEqual({ tier: 'public' });
  });

  it('rejects a missing runtime reference before reading it', () => {
    expect(resolveSafeRuntimeReferencePath('active/projects/public/missing.md')).toBeNull();
  });
});
