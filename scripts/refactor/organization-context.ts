import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { stanceDirForSlug } from '@agent/core/stance-resolver';

export type OrganizationContextOptions = {
  /** Override overlay detection (tests). Default: `knowledge/personal/stances/{slug}/` exists. */
  stanceOverlayExists?: (slug: string) => boolean;
};

function defaultStanceOverlayExists(slug: string): boolean {
  return safeExistsSync(stanceDirForSlug(slug, pathResolver.rootDir()));
}

/**
 * Bind organization-scoped defaults for the duration of `fn`.
 *
 * `organization_id` and the stance (`KYBERION_STANCE`) are different layers —
 * see stance-tenant-customer-model. Always set `KYBERION_ORGANIZATION_ID`. Only
 * switch `KYBERION_STANCE` when `knowledge/personal/stances/{slug}/` exists
 * (company-bootstrap stances where the company slug doubles as the stance).
 */
export function withOrganizationContext<T>(
  organizationId: string | undefined,
  fn: () => T,
  options: OrganizationContextOptions = {}
): T {
  const previousStance = getRegisteredEnvText('KYBERION_STANCE');
  const previousOrganization = getRegisteredEnvText('KYBERION_ORGANIZATION_ID');
  const stanceOverlayExists = options.stanceOverlayExists ?? defaultStanceOverlayExists;
  const slug = organizationId?.trim();
  if (slug) {
    setRegisteredEnv('KYBERION_ORGANIZATION_ID', slug);
    if (stanceOverlayExists(slug)) {
      setRegisteredEnv('KYBERION_STANCE', slug);
    }
  }
  try {
    return fn();
  } finally {
    setRegisteredEnv('KYBERION_STANCE', previousStance);
    setRegisteredEnv('KYBERION_ORGANIZATION_ID', previousOrganization);
  }
}
