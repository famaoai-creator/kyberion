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
  /**
   * UI-01b data-viz palettes (`--kb-ui-viz-cat-1..8`, `-seq-1..5`, `-div-1..5`).
   * Categorical is a fixed order (never cycled); sequential low -> high;
   * diverging negative pole -> neutral midpoint -> positive pole.
   */
  viz: BrandUiVizPalette;
}

export interface BrandUiVizPalette {
  categorical: string[];
  sequential: string[];
  diverging: string[];
  /**
   * Text ink for a value label painted directly on a `sequential[N]` /
   * `diverging[N]` cell (e.g. `ui:heatmap`), one per step, >= 4.5:1 against
   * that step (`scripts/check_design_contrast.ts`). A ramp step's own
   * lightness varies too much for one ink (`text` or `text-on-accent`) to
   * clear 4.5:1 on every step, so each step gets its own.
   */
  sequential_ink: string[];
  diverging_ink: string[];
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
  /** Web UI font stacks; media surfaces keep `tokens.fonts`. */
  font_family?: { sans?: string; mono?: string };
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
