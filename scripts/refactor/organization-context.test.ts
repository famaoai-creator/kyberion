import { afterEach, describe, expect, it } from 'vitest';
import { withOrganizationContext } from './organization-context.js';

describe('organization-context', () => {
  const originalCustomer = process.env.KYBERION_CUSTOMER;

  afterEach(() => {
    if (originalCustomer === undefined) delete process.env.KYBERION_CUSTOMER;
    else process.env.KYBERION_CUSTOMER = originalCustomer;
  });

  it('temporarily switches KYBERION_CUSTOMER and restores the previous value', () => {
    process.env.KYBERION_CUSTOMER = 'baseline';

    const observed = withOrganizationContext('acme-org', () => {
      expect(process.env.KYBERION_CUSTOMER).toBe('acme-org');
      return process.env.KYBERION_CUSTOMER;
    });

    expect(observed).toBe('acme-org');
    expect(process.env.KYBERION_CUSTOMER).toBe('baseline');
  });

  it('clears KYBERION_CUSTOMER temporarily when no organization is provided', () => {
    delete process.env.KYBERION_CUSTOMER;

    const observed = withOrganizationContext(undefined, () => {
      expect(process.env.KYBERION_CUSTOMER).toBeUndefined();
      return process.env.KYBERION_CUSTOMER;
    });

    expect(observed).toBeUndefined();
    expect(process.env.KYBERION_CUSTOMER).toBeUndefined();
  });
});
