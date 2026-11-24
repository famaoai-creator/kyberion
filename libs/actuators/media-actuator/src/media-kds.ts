import { KDS_THEME_PREFIX, resolveCreativeDesign } from '@agent/core/creative-design-resolver';
import { findDesignStyle } from '@agent/core/design-foundation';
import type { MediaTheme } from './media-document-helpers.js';

/**
 * KDS v2 (kyberion-foundation.json) → media actuator adapter.
 *
 *  - theme `kds:<style>`          → a MediaTheme projected by resolveCreativeDesign
 *  - design system `kds-<style>`  → implicit system: that theme + a body-zone map
 *  - body zone `kds-<composition>` → synthesized region zone (media-layout-catalog)
 */
export {
  KDS_THEME_PREFIX,
  KDS_SYSTEM_PREFIX,
  buildKdsDesignSystem,
} from '@agent/core/creative-design-resolver';

export function resolveKdsTheme(themeName: string): MediaTheme | null {
  if (!themeName.startsWith(KDS_THEME_PREFIX)) return null;
  const styleId = themeName.slice(KDS_THEME_PREFIX.length);
  if (!findDesignStyle(styleId)) return null;
  const resolved = resolveCreativeDesign({ surface: 'pptx', style: styleId });
  return resolved.projection.surface === 'pptx'
    ? (resolved.projection.theme as unknown as MediaTheme)
    : null;
}
