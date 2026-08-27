import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';

export function withOrganizationContext<T>(organizationId: string | undefined, fn: () => T): T {
  const previousCustomer = getRegisteredEnvText('KYBERION_CUSTOMER');
  const slug = organizationId?.trim();
  if (slug) {
    setRegisteredEnv('KYBERION_CUSTOMER', slug);
  }
  try {
    return fn();
  } finally {
    setRegisteredEnv('KYBERION_CUSTOMER', previousCustomer);
  }
}
