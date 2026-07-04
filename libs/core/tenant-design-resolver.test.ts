import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { resolveTenantDesign } from './tenant-design-resolver.js';

describe('tenant-design-resolver', () => {
  const rootDir = pathResolver.shared('tmp/tenant-design-resolver-fixture');

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
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
});
