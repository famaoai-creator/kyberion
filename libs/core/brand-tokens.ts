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

export type BrandUiStatusName = 'success' | 'warning' | 'danger' | 'info';
export type BrandUiRoleName =
  'concierge' | 'presence-studio' | 'chronos-mirror-v2' | 'operator-surface' | 'computer-surface';
export type BrandUiFontSizeStep = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

/** Per-theme UI palette (UI-02). Keys map 1:1 onto `--kb-ui-<key>` CSS variables. */
export interface BrandUiPalette {
  canvas: string;
  surface: string;
  'surface-raised': string;
  'surface-sunken': string;
  border: string;
  'border-strong': string;
  text: string;
  'text-muted': string;
  'text-subtle': string;
  'text-on-accent': string;
  accent: string;
  'accent-hover': string;
  'accent-soft': string;
  'accent-text': string;
  'focus-ring': string;
  status: Record<BrandUiStatusName, { fg: string; bg: string; border: string }>;
  role: Record<BrandUiRoleName, string>;
  shadow: { sm: string; md: string };
}

/** Web UI semantic token layer (`tokens.ui`), separate from the media palette. */
export interface BrandUiTokens {
  _meta?: string;
  light: BrandUiPalette;
  dark: BrandUiPalette;
  radius: { sm: string; md: string; lg: string };
  space: Record<string, string>;
  font_size: {
    comfortable: Record<BrandUiFontSizeStep, string>;
    compact: Record<BrandUiFontSizeStep, string>;
  };
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
    ui?: BrandUiTokens;
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
