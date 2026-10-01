import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const rootDirRef = vi.hoisted(() => ({ value: process.cwd() }));
let rootDir = rootDirRef.value;

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    knowledge: (sub = '') => path.join(rootDirRef.value, 'knowledge', sub),
    rootResolve: (sub = '') =>
      sub.startsWith('knowledge/product/schemas/')
        ? path.join(process.cwd(), sub)
        : path.join(rootDirRef.value, sub),
    rootDir: () => rootDirRef.value,
  },
}));

const designWarnings = vi.hoisted(() => [] as string[]);

vi.mock('./logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger.js')>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      return {
        ...real,
        warn: (msg: string) => {
          designWarnings.push(msg);
        },
      };
    },
  };
});

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const foundation =
    await vi.importActual<typeof import('./foundation/io.js')>('./foundation/io.js');
  const assertSafeRepositoryPath = (
    filePath: string,
    options: { allowMissingLeaf?: boolean; rootDir?: string } = {}
  ): string => {
    const resolved = path.resolve(filePath);
    const root = path.resolve(options.rootDir ?? rootDirRef.value);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('[RESOURCE_PATH_SCOPE]');
    }
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (actual.lstatSync(current).isSymbolicLink()) {
          throw new Error('[RESOURCE_PATH_SYMLINK]');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    if (!options.allowMissingLeaf && !actual.existsSync(resolved)) {
      throw new Error('[RESOURCE_PATH_MISSING]');
    }
    return resolved;
  };
  foundation.registerFoundationIo({
    loadJson: <T>(p: string) => JSON.parse(actual.readFileSync(p, 'utf8')) as T,
    loadJsonIfPresent: <T>(p: string) => {
      if (!actual.existsSync(p)) return null;
      try {
        return JSON.parse(actual.readFileSync(p, 'utf8')) as T;
      } catch {
        return null;
      }
    },
    appendFile: (p: string, content: string) => actual.appendFileSync(p, content),
    exists: (p: string) => actual.existsSync(p),
    readFile: (p: string) => actual.readFileSync(p, 'utf8'),
    stat: (p: string) => actual.statSync(p),
    writeFile: (p: string, content: string) => actual.writeFileSync(p, content),
  });
  return {
    assertSafeRepositoryPath,
    safeLstat: (p: string) => actual.lstatSync(p),
    safeExistsSync: (p: string) => actual.existsSync(p),
    safeReadFile: (p: string, opts: { encoding?: string }) =>
      actual.readFileSync(p, opts as { encoding: BufferEncoding }),
    loadJsonIfPresent: <T>(p: string): T | null => {
      if (!actual.existsSync(p)) return null;
      try {
        return JSON.parse(actual.readFileSync(p, 'utf8')) as T;
      } catch {
        return null;
      }
    },
  };
});

import {
  resolveSemanticTokens,
  resetSemanticTokenCache,
  semanticToken,
} from './semantic-design-tokens.js';
import { SEMANTIC_TOKEN_FALLBACKS } from './semantic-design-token-fallbacks.js';
import { readTenantSemanticTokens } from './creative-design-resolver.js';
import { buildVideoDesignCssVars, resolveVideoModeDefaults } from './video/video-design-system.js';
import {
  PPTX_PALETTE,
  createPptxLayoutKit,
  footerElements,
  resolvePptxPalette,
  sectionHeaderElements,
} from './media/native-pptx-engine/layout-primitives.js';

const REAL_ROOT = process.cwd();
const DEFAULTS_REL = 'knowledge/public/design-patterns/semantic-design-tokens.json';

function write(rel: string, data: unknown): void {
  const target = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2));
}

function installDefaults(): void {
  fs.mkdirSync(path.join(rootDir, 'knowledge/product/schemas'), { recursive: true });
  fs.copyFileSync(
    path.join(REAL_ROOT, 'knowledge/product/schemas/semantic-design-tokens.schema.json'),
    path.join(rootDir, 'knowledge/product/schemas/semantic-design-tokens.schema.json')
  );
  fs.mkdirSync(path.dirname(path.join(rootDir, DEFAULTS_REL)), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, DEFAULTS_REL), path.join(rootDir, DEFAULTS_REL));
}

describe('semantic-design-tokens', () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-semantic-tokens-'));
    rootDirRef.value = rootDir;
    resetSemanticTokenCache();
  });

  it('keeps the knowledge defaults identical to the last-resort fallback map', () => {
    const file = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, DEFAULTS_REL), 'utf8'));
    expect(file.engines).toEqual(SEMANTIC_TOKEN_FALLBACKS);
  });

  it('falls back to the built-in map when the defaults file is absent', () => {
    expect(semanticToken('spreadsheet', 'status.danger.fill')).toBe('#FEE2E2');
  });

  it('fails closed on unknown token names', () => {
    expect(() => semanticToken('diagram', 'diagram.nope')).toThrow(/Unknown semantic design token/);
  });

  it('renders the default video palette byte-identically to the pre-token output', () => {
    installDefaults();
    const golden = JSON.parse(
      fs.readFileSync(
        path.join(REAL_ROOT, 'libs/core/video/video-design-system.golden.json'),
        'utf8'
      )
    );
    for (const mode of ['promo', 'vtuber', 'howto'] as const) {
      expect(resolveVideoModeDefaults(mode)).toEqual(golden.modes[mode]);
    }
    for (const [family, motion] of [
      ['promo-spot', 'energetic'],
      ['vtuber-stage', 'on-air'],
      ['process-flow', 'guided-step'],
    ]) {
      expect(
        buildVideoDesignCssVars({
          backgroundColor: '#000',
          layoutFamily: family,
          motionProfile: motion,
          designSystemRef: { css_vars: {} } as never,
        })
      ).toEqual(golden.css[family]);
    }
  });

  it('keeps the default pptx palette unchanged', () => {
    expect(PPTX_PALETTE).toEqual({
      navy: '#1E3A5F',
      navyDark: '#0F1F33',
      blue: '#3B82F6',
      blueLight: '#DBEAFE',
      green: '#10B981',
      greenLight: '#D1FAE5',
      orange: '#F59E0B',
      orangeLight: '#FEF3C7',
      purple: '#8B5CF6',
      purpleLight: '#EDE9FE',
      red: '#EF4444',
      redLight: '#FEE2E2',
      gray50: '#F9FAFB',
      gray100: '#F3F4F6',
      gray200: '#E5E7EB',
      gray400: '#9CA3AF',
      gray600: '#4B5563',
      gray700: '#374151',
      gray800: '#1F2937',
      white: '#FFFFFF',
      black: '#000000',
    });
  });

  it('lets a tenant overlay change a status colour (and only that engine/tenant)', () => {
    installDefaults();
    write('knowledge/confidential/client-a/design/tenant-override.json', {
      tenant_id: 'client-a',
      brand_name: 'Aster Bank',
      theme: 'client-a',
    });
    write('knowledge/confidential/client-a/design/theme.json', {
      theme: {
        name: 'client-a',
        semantic_tokens: {
          spreadsheet: {
            'status.success.fill': '#ABCDEF',
            'status.warning.fill': 'red; } body { x',
          },
        },
      },
    });
    const tenant = resolveSemanticTokens('spreadsheet', { tenantSlug: 'client-a' });
    expect(tenant['status.success.fill']).toBe('#ABCDEF');
    // unsafe values are dropped, defaults retained
    expect(tenant['status.warning.fill']).toBe('#FEF3C7');
    expect(
      resolveSemanticTokens('spreadsheet', { tenantSlug: 'other' })['status.success.fill']
    ).toBe('#DCFCE7');
    expect(resolveSemanticTokens('diagram', { tenantSlug: 'client-a' })).toEqual(
      SEMANTIC_TOKEN_FALLBACKS.diagram
    );
  });

  it('validates tenant overlay colours per engine and warns once per dropped set', () => {
    installDefaults();
    write('knowledge/confidential/client-v/design/tenant-override.json', {
      tenant_id: 'client-v',
      theme: 'client-v',
    });
    write('knowledge/confidential/client-v/design/theme.json', {
      theme: {
        name: 'client-v',
        semantic_tokens: {
          // OOXML engines: 6-digit hex only (# optional)
          spreadsheet: {
            'status.success.fill': '#ABCDEF',
            'status.success.text': '123456',
            'status.warning.fill': 'rgb(1,2,3)',
            'status.warning.text': '#FFF',
            'status.danger.fill': 'red',
          },
          // CSS engines: hex / rgb(a) / hsl(a) only
          diagram: {
            'diagram.background': '#fff',
            'diagram.stroke': 'rgba(15, 23, 42, 0.9)',
            'diagram.accent': 'hsl(210deg 40% 50% / 0.5)',
            'diagram.text': 'url(https://evil.example/x.png)',
            'diagram.grid': 'var(--brand)',
            'diagram.edge': 'expression(alert(1))',
            'diagram.label': 'rebeccapurple',
          },
        },
      },
    });
    designWarnings.length = 0;
    const sheet = readTenantSemanticTokens('client-v', 'spreadsheet');
    expect(sheet).toEqual({ 'status.success.fill': '#ABCDEF', 'status.success.text': '123456' });
    const diagram = readTenantSemanticTokens('client-v', 'diagram');
    expect(diagram).toEqual({
      'diagram.background': '#fff',
      'diagram.stroke': 'rgba(15, 23, 42, 0.9)',
      'diagram.accent': 'hsl(210deg 40% 50% / 0.5)',
    });
    expect(designWarnings).toHaveLength(2);
    expect(designWarnings[0]).toMatch(/spreadsheet.* — .+ \| .+ \| keys: /);
    // an engine with no declared colour format trusts nothing (fail closed)
    expect(readTenantSemanticTokens('client-v', 'not-an-engine')).toEqual({});
    // resolved tokens keep the defaults for dropped keys
    expect(
      resolveSemanticTokens('spreadsheet', { tenantSlug: 'client-v' })['status.danger.fill']
    ).toBe(SEMANTIC_TOKEN_FALLBACKS.spreadsheet['status.danger.fill']);
  });

  it('resolves the pptx palette per render for the tenant in scope (no first-tenant leak)', () => {
    installDefaults();
    for (const [slug, navy] of [
      ['tenant-a', '#AA0001'],
      ['tenant-b', '#BB0002'],
    ]) {
      write(`knowledge/confidential/${slug}/design/tenant-override.json`, {
        tenant_id: slug,
        theme: slug,
      });
      write(`knowledge/confidential/${slug}/design/theme.json`, {
        theme: { name: slug, semantic_tokens: { pptx: { 'pptx.navy': navy } } },
      });
    }
    const defaultNavy = resolvePptxPalette().navy;
    expect(defaultNavy).toBe('#1E3A5F');
    // Interleaved renders in one process: each tenant gets its own palette.
    const a = resolvePptxPalette({ tenantSlug: 'tenant-a' });
    const b = resolvePptxPalette({ tenantSlug: 'tenant-b' });
    expect(a.navy).toBe('#AA0001');
    expect(b.navy).toBe('#BB0002');
    expect(resolvePptxPalette().navy).toBe(defaultNavy);
    const header = (slug?: string) =>
      sectionHeaderElements('T', { tenantSlug: slug })[0].style?.fill;
    expect(header('tenant-a')).toBe('#AA0001');
    expect(header('tenant-b')).toBe('#BB0002');
    expect(header()).toBe(defaultNavy);
    const footerRule = footerElements({
      pageNum: 1,
      totalPages: 2,
      label: 'x',
      tenantSlug: 'tenant-b',
    })[0].style?.line;
    expect(footerRule).toBe('#BB0002');

    // A layout kit binds one render's tenant once: palette, header and footer agree.
    const kitB = createPptxLayoutKit({ tenantSlug: 'tenant-b' });
    const kitA = createPptxLayoutKit({ tenantSlug: 'tenant-a' });
    expect(kitB.palette.navy).toBe('#BB0002');
    expect(kitB.sectionHeader('T')[0].style?.fill).toBe('#BB0002');
    expect(kitB.footer({ pageNum: 1, totalPages: 2, label: 'x' })[0].style?.line).toBe('#BB0002');
    expect(kitA.sectionHeader('T')[0].style?.fill).toBe('#AA0001');
    expect(createPptxLayoutKit().sectionHeader('T')[0].style?.fill).toBe(defaultNavy);
  });
});
