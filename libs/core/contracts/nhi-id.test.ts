import { describe, expect, it } from 'vitest';
import {
  AgentIdentityFormatError,
  buildNhiId,
  buildTenantlessNhiId,
  canonicalNhiIdFromLegacy,
  isLegacyNhiId,
  NHI_ID_PATTERN,
  nhiIdBelongsToOrganization,
  parseNhiId,
} from './nhi-id.js';

describe('nhi-id (concept model v2 D3)', () => {
  it('formats and parses kyberion://agent/<tenant>/<org>/<slug>', () => {
    const id = buildNhiId('acme', 'sales', 'planner');
    expect(id).toBe('kyberion://agent/acme/sales/planner');
    expect(parseNhiId(id)).toEqual({
      tenant_slug: 'acme',
      organization_id: 'sales',
      slug: 'planner',
      legacy: false,
    });
    expect(NHI_ID_PATTERN.test(id)).toBe(true);
  });

  it('writes _ for an NHI that belongs to no organization in its tenant', () => {
    expect(buildNhiId('acme', null, 'planner')).toBe('kyberion://agent/acme/_/planner');
    expect(buildNhiId('acme', undefined, 'planner')).toBe('kyberion://agent/acme/_/planner');
    expect(parseNhiId('kyberion://agent/acme/_/planner')).toMatchObject({
      tenant_slug: 'acme',
      organization_id: null,
    });
  });

  it('rejects a missing tenant', () => {
    expect(() => buildNhiId('', 'sales', 'planner')).toThrow(AgentIdentityFormatError);
    expect(() => buildNhiId('  ', null, 'planner')).toThrow(/tenant slug is required/);
  });

  it('rejects a reserved scope name as the tenant, when building and when parsing', () => {
    for (const reserved of ['public', 'confidential', 'personal', 'shared']) {
      expect(() => buildNhiId(reserved, null, 'planner')).toThrow(/reserved scope name/);
      expect(parseNhiId(`kyberion://agent/${reserved}/_/planner`)).toBeNull();
    }
  });

  it('rejects an invalid organization or slug', () => {
    expect(() => buildNhiId('acme', 'Sales Team', 'planner')).toThrow(/organization id/);
    expect(() => buildNhiId('acme', null, 'Planner')).toThrow(/invalid slug/);
  });

  it('builds a tenantless id only through the explicit builder', () => {
    const id = buildTenantlessNhiId('haru');
    expect(id).toBe('kyberion://agent/_/_/haru');
    expect(parseNhiId(id)).toEqual({
      tenant_slug: null,
      organization_id: null,
      slug: 'haru',
      legacy: false,
    });
    // An organization never appears without its tenant.
    expect(parseNhiId('kyberion://agent/_/sales/haru')).toBeNull();
  });

  it('parses the pre-D3 shape as a legacy alias for one release', () => {
    const legacy = 'kyberion://agent/acme-org/planner';
    expect(isLegacyNhiId(legacy)).toBe(true);
    expect(parseNhiId(legacy)).toEqual({
      tenant_slug: null,
      organization_id: 'acme-org',
      slug: 'planner',
      legacy: true,
    });
    expect(NHI_ID_PATTERN.test(legacy)).toBe(true);
    expect(isLegacyNhiId('kyberion://agent/acme/_/planner')).toBe(false);
  });

  it('maps a legacy alias to its canonical id, dropping the removed default org', () => {
    expect(canonicalNhiIdFromLegacy('kyberion://agent/acme-org/planner', 'acme')).toBe(
      'kyberion://agent/acme/acme-org/planner'
    );
    expect(canonicalNhiIdFromLegacy('kyberion://agent/default/planner', 'acme')).toBe(
      'kyberion://agent/acme/_/planner'
    );
    expect(canonicalNhiIdFromLegacy('kyberion://agent/default/planner', null)).toBe(
      'kyberion://agent/_/_/planner'
    );
    expect(canonicalNhiIdFromLegacy('kyberion://agent/acme/_/planner', 'other')).toBe(
      'kyberion://agent/acme/_/planner'
    );
    expect(canonicalNhiIdFromLegacy('not-an-nhi', 'acme')).toBeNull();
    expect(() => canonicalNhiIdFromLegacy('kyberion://agent/x/planner', 'public')).toThrow(
      AgentIdentityFormatError
    );
  });

  it('matches an organization inside its tenant; a legacy alias matches on its org', () => {
    expect(nhiIdBelongsToOrganization('kyberion://agent/acme/sales/a', 'acme', 'sales')).toBe(true);
    expect(nhiIdBelongsToOrganization('kyberion://agent/other/sales/a', 'acme', 'sales')).toBe(
      false
    );
    expect(nhiIdBelongsToOrganization('kyberion://agent/acme/_/a', 'acme', 'sales')).toBe(false);
    expect(nhiIdBelongsToOrganization('kyberion://agent/sales/a', 'acme', 'sales')).toBe(true);
  });
});
