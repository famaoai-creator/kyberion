import * as path from 'node:path';
import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import { rawExistsSync } from '@agent/core/fs-primitives';
import { pathResolver } from '@agent/core/path-resolver';

/**
 * Bind organization-scoped defaults for the duration of `fn`.
 *
 * `organization_id` and customer stance (`KYBERION_CUSTOMER`) are different
 * layers — see stance-tenant-customer-model. Always set
 * `KYBERION_ORGANIZATION_ID`. Only switch `KYBERION_CUSTOMER` when
 * `customer/{slug}/` actually exists (legacy company-bootstrap overlays where
 * the company slug doubles as stance).
 */
export function withOrganizationContext<T>(organizationId: string | undefined, fn: () => T): T {
  const previousCustomer = getRegisteredEnvText('KYBERION_CUSTOMER');
  const previousOrganization = getRegisteredEnvText('KYBERION_ORGANIZATION_ID');
  const slug = organizationId?.trim();
  if (slug) {
    setRegisteredEnv('KYBERION_ORGANIZATION_ID', slug);
    const customerDir = path.join(pathResolver.rootDir(), 'customer', slug);
    if (rawExistsSync(customerDir)) {
      setRegisteredEnv('KYBERION_CUSTOMER', slug);
    }
  }
  try {
    return fn();
  } finally {
    setRegisteredEnv('KYBERION_CUSTOMER', previousCustomer);
    setRegisteredEnv('KYBERION_ORGANIZATION_ID', previousOrganization);
  }
}
