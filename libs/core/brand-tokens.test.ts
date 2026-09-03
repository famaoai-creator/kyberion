import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadBrandTokensAtPath } from './brand-tokens.js';

const testRoot = pathResolver.sharedTmp(`brand-tokens-loader-${process.pid}`);
const testPath = path.join(testRoot, 'tokens.json');

afterEach(() => {
  safeRmSync(testRoot, { recursive: true, force: true });
});

describe('brand token catalog', () => {
  it('loads the canonical Kyberion token artifact', () => {
    const tokens = loadBrandTokensAtPath();

    expect(tokens).toMatchObject({
      version: '1.1.0',
      brand_name: 'Kyberion',
      tokens: {
        fonts: {
          sans: expect.any(String),
          mono: expect.any(String),
        },
      },
    });
  });

  it('validates a token artifact supplied by the caller', () => {
    safeMkdir(testRoot, { recursive: true });
    safeWriteFile(
      testPath,
      JSON.stringify({
        version: '1.1.0',
        brand_name: 'Test brand',
        tokens: {
          colors: {
            light: {
              bg_main: '#fff',
              panel_bg: '#fff',
              primary: '#111',
              secondary: '#222',
              accent: '#333',
              warning: '#444',
              text_primary: '#000',
              text_secondary: '#555',
            },
            dark: {
              bg_main: '#000',
              panel_bg: '#111',
              primary: '#eee',
              secondary: '#ddd',
              accent: '#ccc',
              warning: '#bbb',
              text_primary: '#fff',
              text_secondary: '#aaa',
            },
          },
          fonts: { sans: 'Inter', mono: 'monospace' },
        },
      })
    );

    expect(loadBrandTokensAtPath(testPath).brand_name).toBe('Test brand');
  });

  it('rejects an artifact that does not satisfy the catalog schema', () => {
    safeMkdir(testRoot, { recursive: true });
    safeWriteFile(testPath, JSON.stringify({ version: '1.1.0', brand_name: 'Incomplete' }));

    expect(() => loadBrandTokensAtPath(testPath)).toThrow('Invalid catalog brand-tokens');
  });
});
