import path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadTenantDesignOverrideIndex, resolveTenantDesign } from './tenant-design-resolver.js';

describe('tenant-design-resolver', () => {
  const rootDir = pathResolver.shared('tmp/tenant-design-resolver-fixture');

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('loads the confidential design override index through its dedicated schema', () => {
    const indexPath = path.join(rootDir, 'knowledge/confidential/tenants/index.json');
    safeMkdir(path.dirname(indexPath), { recursive: true });
    safeWriteFile(
      indexPath,
      JSON.stringify({
        tenants: [
          {
            id: 'tenant-a',
            override_path: 'knowledge/confidential/tenant-a/design/tenant-override.json',
          },
        ],
      })
    );

    expect(loadTenantDesignOverrideIndex(rootDir)).toEqual({
      tenants: [
        {
          id: 'tenant-a',
          override_path: 'knowledge/confidential/tenant-a/design/tenant-override.json',
        },
      ],
    });
  });

  it('resolves tenant branding from confidential override files', () => {
    const designDir = path.join(rootDir, 'knowledge/confidential/client-a/design');
    safeMkdir(path.join(designDir, 'assets'), { recursive: true });
    safeWriteFile(
      path.join(designDir, 'tenant-override.json'),
      JSON.stringify(
        {
          tenant_id: 'client-a',
          brand_name: 'Aster Bank',
          matchers: ['aster bank', 'client-a'],
          design_system_id: 'client-a',
          layout_template_catalog: 'knowledge/confidential/client-a/design/layout-templates.json',
          branding: {
            brand_name: 'Aster Bank',
            logo_url: 'knowledge/confidential/client-a/design/assets/logo.png',
          },
          theme_pack_path: 'knowledge/confidential/client-a/design/theme.json',
        },
        null,
        2
      )
    );
    safeWriteFile(
      path.join(designDir, 'layout-templates.json'),
      JSON.stringify(
        { default: 'executive-neutral', templates: { 'executive-neutral': {} } },
        null,
        2
      )
    );
    safeWriteFile(
      path.join(designDir, 'theme.json'),
      JSON.stringify(
        {
          kind: 'web-theme-pack',
          version: '1.0.0',
          theme_id: 'client-a',
          brand_name: 'Aster Bank',
          tenant_slug: 'client-a',
          design_system_id: 'client-a',
          theme: {
            name: 'Aster Bank',
            colors: {
              primary: '#10203A',
              secondary: '#31415B',
              accent: '#D97706',
              background: '#F8FAFC',
              text: '#0F172A',
            },
            fonts: {
              heading: 'Aptos Display, sans-serif',
              body: 'Aptos, sans-serif',
            },
            assets: {
              logo_url: 'knowledge/confidential/client-a/design/assets/logo.png',
            },
          },
          layout_templates: {
            version: '1.0.0',
            default: 'executive-neutral',
            templates: {
              'executive-neutral': {},
            },
          },
        },
        null,
        2
      )
    );

    const result = resolveTenantDesign({
      rootDir,
      brandName: 'Aster Bank',
      designSystemId: 'client-a',
    });

    expect(result.source).toBe('tenant');
    expect(result.matchedPath).toBe(path.join(designDir, 'tenant-override.json'));
    expect(result.tokens).toEqual(
      expect.objectContaining({
        brand_name: 'Aster Bank',
        design_system_id: 'client-a',
        theme_name: 'Aster Bank',
        theme_primary: '#10203A',
      })
    );
    expect(result.layoutCatalog).toBe(
      'knowledge/confidential/client-a/design/layout-templates.json'
    );
    expect(result.logoPath).toBe(
      path.join(rootDir, 'knowledge/confidential/client-a/design/assets/logo.png')
    );
    expect(result.themePack).toEqual(expect.objectContaining({ theme_id: 'client-a' }));
  });

  it('falls back to default when no tenant override matches', () => {
    const result = resolveTenantDesign({
      rootDir,
      brandName: 'Unknown Brand',
      designSystemId: 'missing',
    });

    expect(result.source).toBe('default');
    expect(result.tokens).toEqual({});
    expect(result.layoutCatalog).toBeNull();
    expect(result.logoPath).toBeNull();
  });

  it('does not read a theme pack from another tenant directory', () => {
    const tenantDir = path.join(rootDir, 'knowledge/confidential/tenant-a/design');
    const otherDir = path.join(rootDir, 'knowledge/confidential/tenant-b/design');
    safeMkdir(tenantDir, { recursive: true });
    safeMkdir(otherDir, { recursive: true });
    safeWriteFile(
      path.join(otherDir, 'theme.json'),
      JSON.stringify({ brand_name: 'Other Corp', theme: { colors: { primary: '#bad' } } })
    );
    safeWriteFile(
      path.join(tenantDir, 'tenant-override.json'),
      JSON.stringify({
        brand_name: 'Tenant A',
        matchers: ['tenant a'],
        theme_pack_path: 'knowledge/confidential/tenant-b/design/theme.json',
      })
    );

    const result = resolveTenantDesign({ rootDir, brandName: 'Tenant A' });
    expect(result.source).toBe('tenant');
    expect(result.themePack).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Other Corp');
  });

  it('keeps an explicit tenant context from resolving another tenant design', () => {
    for (const [tenantId, brandName] of [
      ['tenant-a', 'Tenant A'],
      ['tenant-b', 'Tenant B'],
    ]) {
      const designDir = path.join(rootDir, 'knowledge/confidential', tenantId, 'design');
      safeMkdir(designDir, { recursive: true });
      safeWriteFile(
        path.join(designDir, 'tenant-override.json'),
        JSON.stringify({ brand_name: brandName, matchers: [brandName.toLowerCase()] })
      );
    }

    const result = resolveTenantDesign({
      rootDir,
      customerId: 'tenant-a',
      brandName: 'Tenant B',
    });

    expect(result.source).toBe('default');
    expect(result.tenantOverride).toBeNull();
  });

  it('does not follow a registry override into a lower tier', () => {
    const indexPath = path.join(rootDir, 'knowledge/confidential/tenants/index.json');
    const personalDesignDir = path.join(rootDir, 'knowledge/personal/secret/design');
    safeMkdir(path.dirname(indexPath), { recursive: true });
    safeMkdir(personalDesignDir, { recursive: true });
    safeWriteFile(
      indexPath,
      JSON.stringify({
        tenants: [
          {
            id: 'secret',
            override_path: 'knowledge/personal/secret/design/tenant-override.json',
          },
        ],
      })
    );
    safeWriteFile(
      path.join(personalDesignDir, 'tenant-override.json'),
      JSON.stringify({ brand_name: 'Personal Leak', matchers: ['personal leak'] })
    );

    const result = resolveTenantDesign({ rootDir, brandName: 'Personal Leak' });

    expect(result.source).toBe('default');
    expect(result.tenantOverride).toBeNull();
  });
});

// DS-02 acceptance 4: tier isolation — confidential branding must never
// resolve without an explicit tenant context, and non-matching contexts
// must not fall through to another tenant's confidential values.
describe('tenant-design-resolver tier isolation (DS-02)', () => {
  const rootDir = pathResolver.shared('tmp/tenant-design-isolation-fixture');

  const seedConfidentialTenant = () => {
    const designDir = path.join(rootDir, 'knowledge/confidential/secret-corp/design');
    safeMkdir(designDir, { recursive: true });
    safeWriteFile(
      path.join(designDir, 'tenant-override.json'),
      JSON.stringify({
        tenant_id: 'secret-corp',
        brand_name: 'Secret Corp',
        matchers: ['secret corp'],
        design_system_id: 'secret-corp',
        branding: { brand_name: 'Secret Corp' },
      })
    );
    safeWriteFile(
      path.join(designDir, 'theme.json'),
      JSON.stringify({
        brand_name: 'Secret Corp',
        theme: { name: 'secret', colors: { primary: '#c0ffee' } },
      })
    );
  };

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('returns default (no confidential values) when no tenant context is given', () => {
    seedConfidentialTenant();
    const resolution = resolveTenantDesign({ rootDir });
    expect(resolution.source).toBe('default');
    expect(resolution.tenantOverride).toBeNull();
    expect(resolution.themePack).toBeNull();
    expect(JSON.stringify(resolution)).not.toContain('Secret Corp');
    expect(JSON.stringify(resolution)).not.toContain('#c0ffee');
  });

  it('does not leak one tenant into a different tenant context', () => {
    seedConfidentialTenant();
    const resolution = resolveTenantDesign({ rootDir, brandName: 'Some Other Brand' });
    expect(resolution.source).toBe('default');
    expect(JSON.stringify(resolution)).not.toContain('Secret Corp');
  });

  it('does not resolve a tenant override through a symlinked tenant directory', () => {
    const targetDir = path.join(rootDir, 'active/shared/escaped-design');
    const linkedDir = path.join(rootDir, 'knowledge/confidential/linked-corp');
    safeMkdir(targetDir, { recursive: true });
    safeMkdir(path.dirname(linkedDir), { recursive: true });
    safeWriteFile(
      path.join(targetDir, 'design/tenant-override.json'),
      JSON.stringify({ brand_name: 'Escaped Corp', matchers: ['escaped corp'] })
    );
    fs.symlinkSync(targetDir, linkedDir, 'dir');
    try {
      const resolution = resolveTenantDesign({ rootDir, brandName: 'Escaped Corp' });
      expect(resolution.source).toBe('default');
      expect(resolution.tenantOverride).toBeNull();
    } finally {
      fs.unlinkSync(linkedDir);
    }
  });

  it('serves confidential branding only inside the matching tenant context', () => {
    seedConfidentialTenant();
    const resolution = resolveTenantDesign({ rootDir, brandName: 'Secret Corp' });
    expect(resolution.source).toBe('tenant');
    expect(resolution.tokens.brand_name).toBe('Secret Corp');
    expect(resolution.tokens.theme_primary).toBe('#c0ffee');
  });
});
