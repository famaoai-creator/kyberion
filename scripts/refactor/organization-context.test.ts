import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { withOrganizationContext } from './organization-context.js';

describe('organization-context', () => {
  const originalCustomer = process.env.KYBERION_CUSTOMER;
  const originalOrganization = process.env.KYBERION_ORGANIZATION_ID;
  const overlaySlug = `org-ctx-${process.pid}`;
  const overlayDir = path.join(pathResolver.rootDir(), 'customer', overlaySlug);

  afterEach(() => {
    if (originalCustomer === undefined) delete process.env.KYBERION_CUSTOMER;
    else process.env.KYBERION_CUSTOMER = originalCustomer;
    if (originalOrganization === undefined) delete process.env.KYBERION_ORGANIZATION_ID;
    else process.env.KYBERION_ORGANIZATION_ID = originalOrganization;
    safeRmSync(overlayDir, { recursive: true, force: true });
  });

  it('sets KYBERION_ORGANIZATION_ID without switching stance when no customer overlay exists', () => {
    process.env.KYBERION_CUSTOMER = 'baseline';

    const observed = withOrganizationContext('noriba-community', () => ({
      customer: process.env.KYBERION_CUSTOMER,
      organization: process.env.KYBERION_ORGANIZATION_ID,
    }));

    expect(observed).toEqual({
      customer: 'baseline',
      organization: 'noriba-community',
    });
    expect(process.env.KYBERION_CUSTOMER).toBe('baseline');
    expect(process.env.KYBERION_ORGANIZATION_ID).toBe(originalOrganization);
  });

  it('switches KYBERION_CUSTOMER only when customer/{slug}/ exists', () => {
    process.env.KYBERION_CUSTOMER = 'baseline';
    safeMkdir(overlayDir, { recursive: true });

    const observed = withOrganizationContext(overlaySlug, () => ({
      customer: process.env.KYBERION_CUSTOMER,
      organization: process.env.KYBERION_ORGANIZATION_ID,
    }));

    expect(observed).toEqual({
      customer: overlaySlug,
      organization: overlaySlug,
    });
    expect(process.env.KYBERION_CUSTOMER).toBe('baseline');
  });

  it('leaves KYBERION_CUSTOMER unset when no organization is provided', () => {
    delete process.env.KYBERION_CUSTOMER;

    const observed = withOrganizationContext(undefined, () => process.env.KYBERION_CUSTOMER);

    expect(observed).toBeUndefined();
    expect(process.env.KYBERION_CUSTOMER).toBeUndefined();
  });
});
