import { afterEach, describe, expect, it } from 'vitest';
import { withOrganizationContext } from './organization-context.js';

describe('organization-context', () => {
  const originalCustomer = process.env.KYBERION_STANCE;
  const originalOrganization = process.env.KYBERION_ORGANIZATION_ID;

  afterEach(() => {
    if (originalCustomer === undefined) delete process.env.KYBERION_STANCE;
    else process.env.KYBERION_STANCE = originalCustomer;
    if (originalOrganization === undefined) delete process.env.KYBERION_ORGANIZATION_ID;
    else process.env.KYBERION_ORGANIZATION_ID = originalOrganization;
  });

  it('sets KYBERION_ORGANIZATION_ID without switching stance when no customer overlay exists', () => {
    process.env.KYBERION_STANCE = 'baseline';

    const observed = withOrganizationContext(
      'noriba-community',
      () => ({
        customer: process.env.KYBERION_STANCE,
        organization: process.env.KYBERION_ORGANIZATION_ID,
      }),
      { stanceOverlayExists: () => false }
    );

    expect(observed).toEqual({
      customer: 'baseline',
      organization: 'noriba-community',
    });
    expect(process.env.KYBERION_STANCE).toBe('baseline');
    expect(process.env.KYBERION_ORGANIZATION_ID).toBe(originalOrganization);
  });

  it('switches KYBERION_STANCE only when customer/{slug}/ exists', () => {
    process.env.KYBERION_STANCE = 'baseline';
    const overlaySlug = 'legacy-company';

    const observed = withOrganizationContext(
      overlaySlug,
      () => ({
        customer: process.env.KYBERION_STANCE,
        organization: process.env.KYBERION_ORGANIZATION_ID,
      }),
      { stanceOverlayExists: (slug) => slug === overlaySlug }
    );

    expect(observed).toEqual({
      customer: overlaySlug,
      organization: overlaySlug,
    });
    expect(process.env.KYBERION_STANCE).toBe('baseline');
  });

  it('leaves KYBERION_STANCE unset when no organization is provided', () => {
    delete process.env.KYBERION_STANCE;

    const observed = withOrganizationContext(undefined, () => process.env.KYBERION_STANCE);

    expect(observed).toBeUndefined();
    expect(process.env.KYBERION_STANCE).toBeUndefined();
  });
});
