import * as path from 'node:path';
import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';

export type OrganizationContextOptions = {
  /** Override overlay detection (tests). Default: `customer/{slug}/` exists. */
  customerOverlayExists?: (slug: string) => boolean;
};

function defaultCustomerOverlayExists(slug: string): boolean {
  return safeExistsSync(path.join(pathResolver.rootDir(), 'customer', slug));
}

/**
 * Bind organization-scoped defaults for the duration of `fn`.
 *
 * `organization_id` and customer stance (`KYBERION_CUSTOMER`) are different
 * layers — see stance-tenant-customer-model. Always set
 * `KYBERION_ORGANIZATION_ID`. Only switch `KYBERION_CUSTOMER` when
 * `customer/{slug}/` actually exists (legacy company-bootstrap overlays where
 * the company slug doubles as stance).
 */
export function withOrganizationContext<T>(
  organizationId: string | undefined,
  fn: () => T,
  options: OrganizationContextOptions = {}
): T {
  const previousCustomer = getRegisteredEnvText('KYBERION_CUSTOMER');
  const previousOrganization = getRegisteredEnvText('KYBERION_ORGANIZATION_ID');
  const customerOverlayExists = options.customerOverlayExists ?? defaultCustomerOverlayExists;
  const slug = organizationId?.trim();
  if (slug) {
    setRegisteredEnv('KYBERION_ORGANIZATION_ID', slug);
    if (customerOverlayExists(slug)) {
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
