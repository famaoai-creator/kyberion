import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { GET } from './route.js';

describe('tenant-design route', () => {
  const rootDir = path.join(process.cwd(), 'active/shared/tmp/tenant-design-route-fixture');

  beforeEach(() => {
    process.env.KYBERION_TENANT_DESIGN_ROOT = rootDir;
  });

  afterEach(() => {
    delete process.env.KYBERION_TENANT_DESIGN_ROOT;
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('returns request-scoped tenant css vars from the resolved design pack', async () => {
    const tenantDesignDir = path.join(rootDir, 'knowledge/confidential/tenant-a/design');
    safeMkdir(path.join(tenantDesignDir, 'assets'), { recursive: true });
    safeWriteFile(
      path.join(tenantDesignDir, 'tenant-override.json'),
      JSON.stringify(
        {
          tenant_id: 'tenant-a',
          brand_name: 'Tenant A',
          matchers: ['tenant a'],
          design_system_id: 'tenant-a',
          branding: {
            brand_name: 'Tenant A',
            logo_url: 'knowledge/confidential/tenant-a/design/assets/logo.png',
          },
          theme_pack_path: 'knowledge/confidential/tenant-a/design/theme.json',
        },
        null,
        2
      )
    );
    safeWriteFile(
      path.join(tenantDesignDir, 'theme.json'),
      JSON.stringify(
        {
          kind: 'web-theme-pack',
          version: '1.0.0',
          theme_id: 'tenant-a',
          brand_name: 'Tenant A',
          tenant_slug: 'tenant-a',
          design_system_id: 'tenant-a',
          theme: {
            name: 'Tenant A',
            colors: {
              primary: '#101010',
              secondary: '#202020',
              accent: '#0EA5E9',
              background: '#F0F9FF',
              text: '#0F172A',
            },
            fonts: {
              heading: 'Tenant A Display',
              body: 'Tenant A Body',
            },
          },
        },
        null,
        2
      )
    );

    const response = await GET(
      new Request(
        'http://localhost/api/tenant-design?customerId=tenant-a&brandName=Tenant%20A&designSystemId=tenant-a'
      )
    );
    const payload = (await response.json()) as {
      source: string;
      brand_name: string | null;
      css_vars: Record<string, string>;
    };

    expect(payload.source).toBe('tenant');
    expect(payload.brand_name).toBe('Tenant A');
    expect(payload.css_vars['--kb-bg-main']).toBe('#F0F9FF');
    expect(payload.css_vars['--kb-accent']).toBe('#0EA5E9');
  });

  it('returns defaults when no tenant is specified', async () => {
    const response = await GET(new Request('http://localhost/api/tenant-design'));
    const payload = (await response.json()) as {
      source: string;
      brand_name: string | null;
      css_vars: Record<string, string>;
    };

    expect(payload.source).toBe('default');
    expect(payload.brand_name).toBeNull();
    expect(payload.css_vars).toEqual({});
  });
});
