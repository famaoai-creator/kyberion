import { resolveCreativeDesign } from '@agent/core/creative-design-resolver';
import { findDesignStyle } from '@agent/core/design-foundation';
import type { MediaDesignSystemDefinition } from './media-catalog-loaders.js';
import type { MediaTheme } from './media-document-helpers.js';

/**
 * KDS v2 (kyberion-foundation.json) → media actuator adapter.
 *
 *  - theme `kds:<style>`          → a MediaTheme projected by resolveCreativeDesign
 *  - design system `kds-<style>`  → implicit system: that theme + a body-zone map
 *  - body zone `kds-<composition>` → synthesized region zone (media-layout-catalog)
 */
export const KDS_THEME_PREFIX = 'kds:';
export const KDS_SYSTEM_PREFIX = 'kds-';

/**
 * Semantic types a KDS style re-lays out. Specialised zones (architecture,
 * timeline, decision_cta, hero, contents) keep their own geometry; the generic
 * ones take a composition. `pref` = the style's own first preferred composition.
 */
const KDS_SEMANTIC_COMPOSITION: Record<string, string | 'pref'> = {
  content: 'pref',
  summary: 'pref',
  overview: 'bento-4',
  solution: 'bento-4',
  problem: 'sidebar-detail',
  comparison: 'three-up',
  metrics: 'stat-rail',
  roi: 'stat-rail',
};

/** Compositions that carry only text (no image slot), safe for automatic mapping. */
const KDS_PROSE_COMPOSITIONS = new Set(['spotlight', 'sidebar-detail', 'three-up']);

export function buildKdsDesignSystem(styleId: string): MediaDesignSystemDefinition | null {
  const style = findDesignStyle(styleId);
  if (!style) return null;
  const bodyZoneMap: Record<string, string> = {};
  for (const [semantic, target] of Object.entries(KDS_SEMANTIC_COMPOSITION)) {
    const compositionId =
      target === 'pref'
        ? (style.preferred_compositions.find((id) => KDS_PROSE_COMPOSITIONS.has(id)) ??
          'sidebar-detail')
        : target;
    if (compositionId) bodyZoneMap[semantic] = `kds-${compositionId}`;
  }
  return {
    theme: `${KDS_THEME_PREFIX}${style.id}`,
    body_zone_map: bodyZoneMap,
    metadata: { source_type: 'kds', description: style.description },
  };
}

export function resolveKdsTheme(themeName: string): MediaTheme | null {
  if (!themeName.startsWith(KDS_THEME_PREFIX)) return null;
  const styleId = themeName.slice(KDS_THEME_PREFIX.length);
  if (!findDesignStyle(styleId)) return null;
  const resolved = resolveCreativeDesign({ surface: 'pptx', style: styleId });
  return resolved.projection.surface === 'pptx'
    ? (resolved.projection.theme as unknown as MediaTheme)
    : null;
}
