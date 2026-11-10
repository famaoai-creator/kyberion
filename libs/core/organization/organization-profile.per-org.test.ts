import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  legacyOrganizationProfilePath,
  listTenantOrganizationProfileIds,
  loadOrganizationProfile,
  organizationProfilePath,
  resetLegacyOrganizationProfileWarningsForTests,
  resolveTenantOrganizationProfilePath,
} from './organization-profile.js';
import { resolveCompany } from './company.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';

/**
 * Concept model v2 D3 (Tenant 1:N Organization): organization profiles live
 * per organization, `knowledge/confidential/{tenant}/organizations/{org}/`.
 * The legacy tenant-root profile is read for one release with a warning.
 */
const root = pathResolver.sharedTmp(`organization-profile-per-org-${process.pid}`);
const home = `${root}/knowledge/confidential/acme`;

function profile(organizationId: string, name: string): string {
  return JSON.stringify({
    $schema: 'https://kyberion.local/schemas/organization-profile.schema.json',
    version: '1.0.0',
    organization_id: organizationId,
    name,
    mission_defaults: { default_team_template: 'default' },
    team_defaults: { default_team_template: 'default' },
    llm: { default_profile: 'standard' },
  });
}

function writeProfile(file: string, organizationId: string, name: string): void {
  safeMkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  safeWriteFile(file, profile(organizationId, name));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('KYBERION_ORGANIZATION_ID', '');
  resetLegacyOrganizationProfileWarningsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (safeExistsSync(root)) safeRmSync(root, { recursive: true, force: true });
});

describe('organization profile per organization', () => {
  it('locates a profile under the tenant home, per organization', () => {
    expect(organizationProfilePath('acme', 'sales', root)).toBe(
      `${home}/organizations/sales/organization-profile.json`
    );
    expect(legacyOrganizationProfilePath('acme', root)).toBe(`${home}/organization-profile.json`);
    expect(() => organizationProfilePath('acme', '../escape', root)).toThrow(
      /invalid organization id/
    );
  });

  it('reads the selected organization profile, else the tenant’s only one', () => {
    writeProfile(`${home}/organizations/sales/organization-profile.json`, 'sales', 'Sales');
    expect(listTenantOrganizationProfileIds('acme', root)).toEqual(['sales']);
    expect(loadOrganizationProfile(root, 'acme')?.name).toBe('Sales');

    writeProfile(`${home}/organizations/ops/organization-profile.json`, 'ops', 'Ops');
    expect(loadOrganizationProfile(root, 'acme', 'ops')?.name).toBe('Ops');
    vi.stubEnv('KYBERION_ORGANIZATION_ID', 'sales');
    expect(loadOrganizationProfile(root, 'acme')?.name).toBe('Sales');
  });

  it('prefers the new location over the legacy tenant-root profile', () => {
    writeProfile(`${home}/organization-profile.json`, 'acme', 'Legacy');
    writeProfile(`${home}/organizations/acme/organization-profile.json`, 'acme', 'Per org');
    const resolved = resolveTenantOrganizationProfilePath('acme', 'acme', root);
    expect(resolved).toMatchObject({ organizationId: 'acme', legacy: false });
    expect(loadOrganizationProfile(root, 'acme', 'acme')?.name).toBe('Per org');
  });

  it('falls back to the legacy tenant-root profile with one warning', () => {
    writeProfile(`${home}/organization-profile.json`, 'acme', 'Legacy');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(resolveTenantOrganizationProfilePath('acme', null, root)).toMatchObject({
      legacy: true,
      path: `${home}/organization-profile.json`,
    });
    expect(loadOrganizationProfile(root, 'acme')?.name).toBe('Legacy');
    expect(loadOrganizationProfile(root, 'acme')?.name).toBe('Legacy');
    const warnings = stderr.mock.calls.filter(([chunk]) =>
      String(chunk).includes('legacy tenant-root location')
    );
    expect(warnings).toHaveLength(1);
  });

  it('resolves the company (an alias of the tenant) through the same profile path', () => {
    writeProfile(`${home}/organizations/acme/organization-profile.json`, 'acme', 'ACME Org');
    const company = resolveCompany('acme', root);
    expect(company.company_id).toBe('acme');
    expect(company.tenant_slug).toBe('acme');
    expect(company.organization_profile_ref.path).toBe(
      `${home}/organizations/acme/organization-profile.json`
    );
    expect(company.organization_profile_ref.data?.name).toBe('ACME Org');
  });
});
