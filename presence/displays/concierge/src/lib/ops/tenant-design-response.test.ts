import { describe, expect, it } from 'vitest';
import { parseTenantDesignResponse } from './tenant-design-response';

describe('tenant design response boundary', () => {
  it('accepts CSS custom properties and nullable brand name', () => {
    expect(
      parseTenantDesignResponse({
        source: 'tenant-profile',
        brand_name: 'Tenant A',
        css_vars: { '--kb-bg-main': '#fff' },
      })
    ).toEqual({
      source: 'tenant-profile',
      brand_name: 'Tenant A',
      css_vars: { '--kb-bg-main': '#fff' },
    });
  });

  it('rejects malformed fields and non-custom-property keys before style spread', () => {
    expect(
      parseTenantDesignResponse({ source: 'tenant', brand_name: 1, css_vars: {} })
    ).toBeUndefined();
    expect(
      parseTenantDesignResponse({ source: 'tenant', brand_name: null, css_vars: { color: 'red' } })
    ).toBeUndefined();
    expect(
      parseTenantDesignResponse(
        JSON.parse('{"source":"tenant","brand_name":null,"css_vars":{"__proto__":"bad"}}')
      )
    ).toBeUndefined();
  });
});
