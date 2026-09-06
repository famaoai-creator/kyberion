import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export interface BrandTokenColors {
  [key: string]: string | undefined;
  bg_main: string;
  panel_bg: string;
  primary: string;
  secondary: string;
  accent: string;
  warning: string;
  text_primary: string;
  text_secondary: string;
  accent_text?: string;
  surface?: string;
  muted_text?: string;
  border?: string;
  success?: string;
  danger?: string;
}

export interface BrandTokenFonts {
  sans: string;
  mono: string;
}

export interface BrandTokens {
  version: string;
  brand_name: string;
  tokens: {
    colors: {
      light: BrandTokenColors;
      dark: BrandTokenColors;
    };
    fonts: BrandTokenFonts;
  };
}

const DEFAULT_BRAND_TOKENS_PATH = pathResolver.rootResolve(
  'knowledge/public/design-patterns/brand-tokens/kyberion.json'
);
const BRAND_TOKENS_SCHEMA_PATH = pathResolver.knowledge('product/schemas/brand-tokens.schema.json');

export function loadBrandTokensAtPath(filePath = DEFAULT_BRAND_TOKENS_PATH): BrandTokens {
  return defineCatalog<BrandTokens>({
    id: 'brand-tokens',
    path: filePath,
    schema: BRAND_TOKENS_SCHEMA_PATH,
  }).load();
}
