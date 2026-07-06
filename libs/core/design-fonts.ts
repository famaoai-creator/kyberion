import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeExistsSync, safeReadFile } from './secure-io.js';

type BrandTokens = {
  tokens?: {
    fonts?: {
      sans?: string;
      mono?: string;
    };
  };
};

type FontFamilyPair = {
  latin: string;
  eastAsian: string;
};

const BRAND_TOKENS_RELATIVE_PATH = 'knowledge/public/design-patterns/brand-tokens/kyberion.json';
const FALLBACK_SANS_STACK = "Inter, 'Noto Sans JP', sans-serif";
const FALLBACK_MONO_STACK = "'JetBrains Mono', monospace";

let cachedBrandTokens: BrandTokens | null = null;

function findExistingPath(relativePath: string): string {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  const visited = new Set<string>();

  for (const start of starts) {
    let current = path.resolve(start);
    while (!visited.has(current)) {
      visited.add(current);
      const candidate = path.join(current, relativePath);
      if (safeExistsSync(candidate)) return candidate;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  throw new Error(`Unable to locate ${relativePath} from cwd or module path`);
}

function loadBrandTokens(): BrandTokens {
  if (!cachedBrandTokens) {
    const raw = safeReadFile(findExistingPath(BRAND_TOKENS_RELATIVE_PATH), {
      encoding: 'utf8',
      label: 'brand tokens',
    }) as string;
    cachedBrandTokens = JSON.parse(raw) as BrandTokens;
  }
  return cachedBrandTokens;
}

function firstFontFamily(fontStack: string | undefined, fallback: string): string {
  const stack = String(fontStack || '').trim();
  if (!stack) return fallback;

  for (const rawFamily of stack.split(',')) {
    const family = rawFamily.trim().replace(/^['"]|['"]$/g, '');
    if (!family) continue;
    if (
      /^(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace)$/i.test(family)
    ) {
      continue;
    }
    return family;
  }

  return fallback;
}

export const KYBERION_BRAND_FONT_STACK =
  loadBrandTokens().tokens?.fonts?.sans ?? FALLBACK_SANS_STACK;
export const KYBERION_BRAND_MONO_STACK =
  loadBrandTokens().tokens?.fonts?.mono ?? FALLBACK_MONO_STACK;

export function resolveLatinFontFamily(fontStack?: string): string {
  return firstFontFamily(fontStack ?? KYBERION_BRAND_FONT_STACK, 'Inter');
}

export function resolveEastAsianFontFamily(fontStack?: string): string {
  const stack = fontStack ?? KYBERION_BRAND_FONT_STACK;
  const families = stack
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  for (const family of families) {
    if (
      /noto sans jp|hiragino|yu gothic|meiryo|ms gothic|source han sans|pingfang|apple sd gothic/i.test(
        family
      )
    ) {
      return family;
    }
  }

  return 'Noto Sans JP';
}

export function resolveFontFamilyPair(fontStack?: string): FontFamilyPair {
  return {
    latin: resolveLatinFontFamily(fontStack),
    eastAsian: resolveEastAsianFontFamily(fontStack),
  };
}
