import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrandTokensAtPath, type BrandTokens } from './brand-tokens.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';

type FontFamilyPair = {
  latin: string;
  eastAsian: string;
};

const BRAND_TOKENS_RELATIVE_PATH = 'knowledge/public/design-patterns/brand-tokens/kyberion.json';
const FALLBACK_SANS_STACK =
  "'Helvetica Neue', Arial, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', Meiryo, system-ui, sans-serif";
const FALLBACK_MONO_STACK = "'JetBrains Mono', monospace";
const FALLBACK_LATIN_FONT = 'Helvetica Neue';
const EAST_ASIAN_FONT_RE =
  /noto sans jp|hiragino|yu gothic|meiryo|ms gothic|source han sans|pingfang|apple sd gothic/i;

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

function resolveBrandTokensPath(): string {
  try {
    return findExistingPath(BRAND_TOKENS_RELATIVE_PATH);
  } catch {
    // Let the governed catalog surface its configured fallback when a fresh
    // checkout has not generated the optional design-token artifact yet.
    return pathResolver.rootResolve(BRAND_TOKENS_RELATIVE_PATH);
  }
}

function loadBrandTokens(): BrandTokens {
  if (!cachedBrandTokens) {
    cachedBrandTokens = loadBrandTokensAtPath(resolveBrandTokensPath());
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

// Module-init IO must never take the whole import graph down: on a fresh
// clone (tokens not generated yet) or under partial test mocks we fall back
// to the built-in stacks instead of throwing at import time.
function loadBrandTokensOrFallback(): BrandTokens {
  try {
    return loadBrandTokens();
  } catch {
    return {} as BrandTokens;
  }
}

export const KYBERION_BRAND_FONT_STACK =
  loadBrandTokensOrFallback().tokens?.fonts?.sans ?? FALLBACK_SANS_STACK;
export const KYBERION_BRAND_MONO_STACK =
  loadBrandTokensOrFallback().tokens?.fonts?.mono ?? FALLBACK_MONO_STACK;

export function resolveLatinFontFamily(fontStack?: string): string {
  const stack = fontStack ?? KYBERION_BRAND_FONT_STACK;
  const families = stack
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  for (const family of families) {
    if (
      /^(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace)$/i.test(family)
    ) {
      continue;
    }
    if (EAST_ASIAN_FONT_RE.test(family)) continue;
    return family;
  }

  return firstFontFamily(stack, FALLBACK_LATIN_FONT);
}

export function resolveEastAsianFontFamily(fontStack?: string): string {
  const stack = fontStack ?? KYBERION_BRAND_FONT_STACK;
  const families = stack
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  for (const family of families) {
    if (EAST_ASIAN_FONT_RE.test(family)) {
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
