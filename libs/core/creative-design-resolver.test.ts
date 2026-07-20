import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let rootDir: string;

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    knowledge: (sub = '') => path.join(rootDir, 'knowledge', sub),
    rootResolve: (sub = '') => path.join(rootDir, sub),
    rootDir: () => rootDir,
  },
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeExistsSync: (p: string) => actual.existsSync(p),
    safeReadFile: (p: string, opts: { encoding?: string }) =>
      actual.readFileSync(p, opts as { encoding: BufferEncoding }),
  };
});

import { resolveCreativeDesign, renderPromptStyleBlock } from './creative-design-resolver.js';

const BRAND_TOKENS = {
  brand_name: 'Kyberion',
  tokens: {
    colors: {
      light: {
        bg_main: '#ffffff',
        primary: '#0f172a',
        secondary: '#334155',
        accent: '#0066cc',
        warning: '#eab308',
        text_primary: '#0f172a',
      },
      dark: {
        bg_main: '#020617',
        primary: '#0A192F',
        secondary: '#31415B',
        accent: '#00F2FF',
        warning: '#f59e0b',
        text_primary: '#F8FAFC',
      },
    },
    fonts: { sans: "Inter, 'Noto Sans JP', sans-serif", mono: "'JetBrains Mono', monospace" },
  },
};

function write(rel: string, data: unknown): void {
  const target = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
}

describe('creative-design-resolver', () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-creative-design-'));
    write('knowledge/public/design-patterns/brand-tokens/kyberion.json', BRAND_TOKENS);
  });

  it('resolves brand defaults with light mode for pptx', () => {
    const resolved = resolveCreativeDesign({ surface: 'pptx' });

    expect(resolved.source).toBe('brand-default');
    expect(resolved.mode).toBe('light');
    expect(resolved.colors.accent).toBe('#0066cc');
    expect(resolved.projection.surface).toBe('pptx');
    if (resolved.projection.surface === 'pptx') {
      expect(resolved.projection.theme.name).toBe('kyberion-standard');
      expect(resolved.projection.theme.colors.primary).toBe('#0f172a');
      expect(resolved.projection.theme.fonts.body).toContain('Noto Sans JP');
    }
  });

  it('defaults video and prompt surfaces to dark mode', () => {
    const video = resolveCreativeDesign({ surface: 'video' });
    const prompt = resolveCreativeDesign({ surface: 'prompt' });

    expect(video.mode).toBe('dark');
    expect(prompt.mode).toBe('dark');
    if (video.projection.surface === 'video') {
      expect(video.projection.css_vars['--kb-accent']).toBe('#00F2FF');
      expect(video.projection.css_vars['--kb-bg-main']).toBe('#020617');
    }
    if (prompt.projection.surface === 'prompt') {
      expect(prompt.projection.style_pack.palette_hex).toContain('#00F2FF');
      expect(prompt.projection.style_pack.avoid.length).toBeGreaterThan(0);
    }
  });

  it('applies tenant overrides across all surfaces with the same hex (G1/G2 regression)', () => {
    write('knowledge/confidential/client-a/design/tenant-override.json', {
      tenant_id: 'client-a',
      brand_name: 'Aster Bank',
      branding: { brand_name: 'Aster Bank', logo_url: '/vault/tenants/client-a/logo.png' },
      theme: 'client-a',
    });
    write('knowledge/confidential/client-a/design/theme.json', {
      theme: {
        name: 'client-a',
        colors: { primary: '#123456', accent: '#abcdef' },
        fonts: { heading: 'Aster Serif', body: 'Aster Sans' },
      },
    });

    const surfaces = ['web', 'pptx', 'video', 'prompt'] as const;
    const primaries = surfaces.map((surface) => {
      const resolved = resolveCreativeDesign({ surface, tenantSlug: 'client-a', mode: 'light' });
      expect(resolved.source).toBe('tenant-override');
      return resolved.colors.primary;
    });

    expect(new Set(primaries).size).toBe(1);
    expect(primaries[0]).toBe('#123456');

    const web = resolveCreativeDesign({ surface: 'web', tenantSlug: 'client-a', mode: 'light' });
    if (web.projection.surface === 'web') {
      expect(web.projection.theme_pack.theme.colors.primary).toBe('#123456');
      expect(web.projection.theme_pack.brand_name).toBe('Aster Bank');
      expect(web.projection.theme_pack.theme.assets?.logo_url).toBe(
        '/vault/tenants/client-a/logo.png'
      );
    }
    const video = resolveCreativeDesign({
      surface: 'video',
      tenantSlug: 'client-a',
      mode: 'light',
    });
    if (video.projection.surface === 'video') {
      expect(video.projection.css_vars['--kb-primary']).toBe('#123456');
      expect(video.projection.css_vars['--kb-accent']).toBe('#abcdef');
    }
    const prompt = resolveCreativeDesign({
      surface: 'prompt',
      tenantSlug: 'client-a',
      mode: 'light',
    });
    if (prompt.projection.surface === 'prompt') {
      expect(prompt.projection.style_pack.palette_hex).toContain('#123456');
    }
  });

  it('falls back to brand defaults for unknown tenants', () => {
    const resolved = resolveCreativeDesign({ surface: 'doc', tenantSlug: 'nonexistent' });
    expect(resolved.source).toBe('brand-default');
    expect(resolved.colors.primary).toBe('#0f172a');
  });

  it('rejects tenant slugs that could escape the confidential tenant boundary', () => {
    expect(() => resolveCreativeDesign({ surface: 'pptx', tenantSlug: '../../etc' })).toThrow(
      /tenant slug/i
    );
  });

  it('drops unsafe tenant token values before projecting CSS', () => {
    write('knowledge/confidential/client-a/design/tenant-override.json', {
      tenant_id: 'client-a',
      theme: 'client-a',
      colors: { accent: '</style><script>alert(1)</script>' },
      fonts: { body: 'Aster; font-family: evil' },
    });
    write('knowledge/confidential/client-a/design/theme.json', {
      theme: {
        colors: { accent: '</style><script>alert(2)</script>' },
        fonts: { body: 'Aster; font-family: evil' },
        typography: {
          roles: { body: { size_pt: 9999, min_size_pt: -20 } },
        },
      },
    });

    const resolved = resolveCreativeDesign({ surface: 'video', tenantSlug: 'client-a' });
    expect(resolved.colors.accent).not.toContain('<');
    expect(resolved.projection.surface).toBe('video');
    if (resolved.projection.surface === 'video') {
      expect(resolved.projection.css_vars['--kb-accent']).not.toContain('<');
      expect(resolved.projection.css_vars['--kb-font-sans']).not.toContain(';');
    }
    expect(resolved.typography.roles.body.size_pt).toBeLessThan(200);
  });

  it('survives a missing brand tokens file with fallback palette', () => {
    fs.rmSync(path.join(rootDir, 'knowledge/public/design-patterns/brand-tokens/kyberion.json'));
    const resolved = resolveCreativeDesign({ surface: 'pptx' });
    expect(resolved.colors.accent).toBe('#0066cc');
  });

  it('renders a deterministic prompt style block', () => {
    const resolved = resolveCreativeDesign({ surface: 'prompt' });
    if (resolved.projection.surface !== 'prompt') throw new Error('unexpected projection');
    const block = renderPromptStyleBlock(resolved.projection.style_pack, { music: true });

    expect(block).toContain('Style: palette=');
    expect(block).toContain('#00F2FF');
    expect(block).toContain('Avoid:');
    expect(block).toContain('Music mood:');
  });
});
