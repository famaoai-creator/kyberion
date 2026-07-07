import { afterEach, describe, expect, it } from 'vitest';

import {
  pathResolver,
  resolveOrganizationOrgChart,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
} from '@agent/core';
import { bootstrapCompany, listCompanyVerticals } from './company_bootstrap.js';

const tmpRoot = pathResolver.rootResolve('active/shared/tmp/company-bootstrap-test');

afterEach(() => {
  safeRmSync(tmpRoot, { recursive: true, force: true });
});

describe('company bootstrap', () => {
  it('lists the shipped verticals', () => {
    const verticals = listCompanyVerticals();
    expect(verticals).toContain('saas-product-company');
    expect(verticals).toContain('consulting-firm');
    expect(verticals.length).toBeGreaterThanOrEqual(5);
  });

  it('materializes a vertical into customer/<slug> with placeholders substituted', () => {
    const result = bootstrapCompany({
      vertical: 'saas-product-company',
      slug: 'acme-saas',
      companyName: 'ACME株式会社',
      rootDir: tmpRoot,
    });

    expect(result.catalogId).toBe('saas-product-company');
    expect(result.writtenFiles.length).toBeGreaterThanOrEqual(6);

    const profileRaw = safeReadFile(`${tmpRoot}/customer/acme-saas/organization-profile.json`, {
      encoding: 'utf8',
    }) as string;
    expect(profileRaw).not.toContain('{COMPANY_');
    const profile = JSON.parse(profileRaw);
    expect(profile.organization_id).toBe('acme-saas');
    expect(profile.name).toContain('ACME株式会社');

    // The materialized chart must be picked up by the org-chart resolver as
    // an explicit customer chart (not derived).
    const chart = resolveOrganizationOrgChart('acme-saas', tmpRoot);
    expect(chart.source_kind).toBe('customer');
    expect(chart.organization_id).toBe('acme-saas');
    expect(chart.positions.some((position) => position.role_id === 'ceo')).toBe(true);
  });

  it('rejects invalid slugs, unknown verticals, and accidental overwrites', () => {
    expect(() =>
      bootstrapCompany({ vertical: 'saas-product-company', slug: 'Bad_Slug', rootDir: tmpRoot })
    ).toThrow(/invalid slug/);
    expect(() =>
      bootstrapCompany({ vertical: 'no-such-vertical', slug: 'acme-x', rootDir: tmpRoot })
    ).toThrow(/unknown vertical/);

    bootstrapCompany({ vertical: 'consulting-firm', slug: 'acme-consult', rootDir: tmpRoot });
    expect(() =>
      bootstrapCompany({ vertical: 'consulting-firm', slug: 'acme-consult', rootDir: tmpRoot })
    ).toThrow(/--force/);
    // Explicit force overwrites.
    const forced = bootstrapCompany({
      vertical: 'consulting-firm',
      slug: 'acme-consult',
      rootDir: tmpRoot,
      force: true,
    });
    expect(safeExistsSync(forced.customerDir)).toBe(true);
  });
});
