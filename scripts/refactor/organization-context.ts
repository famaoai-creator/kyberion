export function withOrganizationContext<T>(organizationId: string | undefined, fn: () => T): T {
  const previousCustomer = process.env.KYBERION_CUSTOMER;
  const slug = organizationId?.trim();
  if (slug) {
    process.env.KYBERION_CUSTOMER = slug;
  }
  try {
    return fn();
  } finally {
    if (previousCustomer === undefined) delete process.env.KYBERION_CUSTOMER;
    else process.env.KYBERION_CUSTOMER = previousCustomer;
  }
}
