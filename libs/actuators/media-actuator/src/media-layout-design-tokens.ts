import {
  resolveThemeColorRole as resolveThemeColorRolePolicy,
  resolveThemeHexRole as resolveThemeHexRolePolicy,
} from '@agent/core/media-theme-role-policy';
import { defineCatalog } from '@agent/core/foundation';
import * as path from 'node:path';
import {
  cloneJsonValue,
  deepMergeCatalog,
  loadMediaDesignSystemsCatalog,
  readJsonFilesRecursively,
} from './media-catalog-loaders.js';

export interface SemanticRenderTokenCatalog {
  version: string;
  defaults: Record<string, Record<string, unknown>>;
  semantics: Record<string, Record<string, unknown>>;
  signal_tones: Record<string, number>;
}

export function loadSemanticRenderTokenCatalog(rootDir: string): SemanticRenderTokenCatalog {
  const fallback = {
    version: '1.0.0',
    defaults: { content: {} },
    semantics: {},
    signal_tones: {},
  };
  const catalog = defineCatalog<SemanticRenderTokenCatalog>({
    id: 'semantic-render-tokens',
    path: path.resolve(
      rootDir,
      'knowledge/public/design-patterns/media-templates/semantic-render-tokens.json'
    ),
    schema: path.resolve(rootDir, 'knowledge/product/schemas/semantic-render-tokens.schema.json'),
    fallback,
    fallbackOnInvalid: true,
  });
  const directoryPath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/semantic-render-tokens'
  );
  const docs = readJsonFilesRecursively(directoryPath);
  if (docs.length === 0) return catalog.load();
  const merged = docs.reduce((acc, doc) => deepMergeCatalog(acc, doc), cloneJsonValue(fallback));
  return catalog.validate(merged, directoryPath);
}

export function resolveSemanticRenderTokens(
  rootDir: string,
  semanticType?: string,
  designSystemId?: string
): any {
  const catalog = loadSemanticRenderTokenCatalog(rootDir);
  const key = String(semanticType || 'content').trim() || 'content';
  const designSystems = loadMediaDesignSystemsCatalog(rootDir);
  const systemOverrides = designSystemId
    ? designSystems.systems?.[designSystemId]?.semantic_overrides?.[key] || {}
    : {};
  return {
    ...(catalog.defaults?.content || {}),
    ...(catalog.semantics?.[key] || {}),
    ...systemOverrides,
  };
}

export function resolveThemeColorRole(palette: any, accentHex: string, role?: string): string {
  const resolvedRole = resolveThemeColorRolePolicy(role, 'secondary');
  switch (resolvedRole) {
    case 'accent':
      return accentHex || palette.accent1 || '2563EB';
    case 'primary':
      return palette.dk1 || '111827';
    default:
      return palette.dk2 || palette.dk1 || accentHex || '334155';
  }
}

export function resolveThemeHexColor(
  themeColors: any,
  role?: string,
  fallback = '#334155'
): string {
  const resolvedRole = resolveThemeHexRolePolicy(role, 'secondary');
  switch (resolvedRole) {
    case 'accent':
      return String(themeColors.accent || fallback);
    case 'primary':
      return String(themeColors.primary || fallback);
    case 'background':
      return String(themeColors.background || '#F8FAFC');
    case 'success':
      return String(themeColors.success || '#DCFCE7');
    case 'warning':
      return String(themeColors.warning || '#FEF3C7');
    case 'info':
      return String(themeColors.info || '#DBEAFE');
    case 'muted':
      return String(themeColors.muted || '#F1F5F9');
    case 'surface':
      return String(themeColors.surface || themeColors.background_card || '#E9EDF4');
    default:
      return String(themeColors.text || fallback);
  }
}
