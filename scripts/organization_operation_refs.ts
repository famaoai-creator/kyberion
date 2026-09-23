import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import type { OrganizationOperationRecord } from '@agent/core/organization-operating-model';

export function assertScopedOperationRunRef(
  ref: string,
  operation: OrganizationOperationRecord,
  label: string
): void {
  const tenant = operation.tenant_slug;
  const scopeRoots =
    operation.tier === 'confidential' && tenant
      ? [
          `knowledge/confidential/${tenant}/`,
          'knowledge/confidential/common/',
          'knowledge/product/',
          'active/shared/',
          `active/missions/confidential/${tenant}/`,
          `active/projects/confidential/${tenant}/`,
          `active/organizations/confidential/${tenant}/`,
        ]
      : operation.tier === 'public'
        ? [
            'knowledge/public/',
            'knowledge/product/',
            'active/shared/',
            'active/missions/public/',
            'active/projects/public/',
            'active/organizations/public/',
          ]
        : tenant
          ? [
              `knowledge/personal/${tenant}/`,
              'knowledge/product/',
              'active/shared/',
              `active/missions/personal/${tenant}/`,
              `active/projects/personal/${tenant}/`,
              `active/organizations/personal/${tenant}/`,
            ]
          : ['knowledge/product/'];
  if (
    ref.includes('\\') ||
    ref.split('/').includes('..') ||
    !scopeRoots.some((prefix) => ref.startsWith(prefix)) ||
    !safeExistsSync(pathResolver.rootResolve(ref))
  ) {
    throw new Error(`${label} must be an existing path within the operation scope: ${ref}`);
  }
}
