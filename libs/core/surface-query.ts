import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import type { SurfaceIntentResolutionOptions } from './router-contract.js';
import {
  listSurfaceQueryOverlayCatalogEntries,
  loadSurfaceQueryOverlayCatalog,
} from './surface-query-overlay-catalog.js';
import { assertScopeContext, scopeContextKey, type ScopeContext } from './scope-context.js';

export interface SurfaceQueryProviderConfig {
  web_search?: {
    enabled?: boolean;
    provider?: string;
    maxResults?: number;
    timeoutMs?: number;
  };
  weather?: {
    enabled?: boolean;
    provider?: string;
    geocodingUrl?: string;
    forecastUrl?: string;
    timeoutMs?: number;
  };
  location?: {
    enabled?: boolean;
    provider?: string;
    providers?: Array<{
      id?: string;
      provider?: string;
      url?: string;
    }>;
  };
  knowledge?: {
    enabled?: boolean;
    provider?: string;
    limit?: number;
    scope?: string;
    phase?: string;
    role?: string;
  };
}

export interface SurfaceQueryProviderContext {
  role?: string;
  phase?: string;
  scope?: ScopeContext;
}

export type SurfaceQueryIntent = 'weather' | 'location' | 'web_search' | 'knowledge_search' | null;

const DEFAULT_CONFIG_PATH = pathResolver.knowledge('product/presence/surface-query-providers.json');
const DEFAULT_PERSONAL_OVERLAY_PATH = pathResolver.knowledge(
  'personal/presence/surface-query-providers.json'
);
const CONFIG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/surface-query-providers.schema.json'
);

const providerConfigCatalogs = new Map<string, GovernedCatalog<SurfaceQueryProviderConfig>>();
let cachedConfig: SurfaceQueryProviderConfig | null = null;
let cachedConfigPath: string | null = null;

function providerConfigCatalog(filePath: string): GovernedCatalog<SurfaceQueryProviderConfig> {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const cached = providerConfigCatalogs.get(safeFilePath);
  if (cached) return cached;
  const catalog = defineCatalog<SurfaceQueryProviderConfig>({
    id: 'surface-query-providers',
    path: safeFilePath,
    schema: CONFIG_SCHEMA_PATH,
    fallback: {},
    fallbackOnInvalid: true,
  });
  providerConfigCatalogs.set(safeFilePath, catalog);
  return catalog;
}

function safeProviderConfigPath(filePath: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(filePath), {
    allowMissingLeaf: true,
  });
}

function mergeSection<T extends Record<string, unknown> | undefined>(base: T, overlay: T): T {
  if (!base) return overlay;
  if (!overlay) return base;
  return { ...(base as Record<string, unknown>), ...(overlay as Record<string, unknown>) } as T;
}

function mergeConfigs(
  base: SurfaceQueryProviderConfig,
  overlay: SurfaceQueryProviderConfig
): SurfaceQueryProviderConfig {
  return {
    web_search: mergeSection(base.web_search, overlay.web_search),
    weather: mergeSection(base.weather, overlay.weather),
    location: mergeSection(base.location, overlay.location),
    knowledge: mergeSection(base.knowledge, overlay.knowledge),
  };
}

function normalizeQuery(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function stripLeadingPhrases(text: string, patterns: RegExp[]): string {
  let current = normalizeQuery(text);
  for (const pattern of patterns) {
    current = current.replace(pattern, '').trim();
  }
  return current;
}

function getRoleOverlayPathForRole(role?: string): string | null {
  const normalized = role?.trim();
  if (!normalized) return null;
  const catalogEntry = listSurfaceQueryOverlayCatalogEntries().find(
    (entry) => entry.kind === 'role' && entry.role === normalized
  );
  return catalogEntry ? safeProviderConfigPath(pathResolver.knowledge(catalogEntry.path)) : null;
}

function getPhaseOverlayPathForPhase(phase?: string): string | null {
  const normalized = phase?.trim();
  if (!normalized) return null;
  const catalogEntry = listSurfaceQueryOverlayCatalogEntries().find(
    (entry) => entry.kind === 'phase' && entry.phase === normalized
  );
  return catalogEntry ? safeProviderConfigPath(pathResolver.knowledge(catalogEntry.path)) : null;
}

function getPersonalOverlayPath(): string | null {
  const catalog = loadSurfaceQueryOverlayCatalog();
  return safeProviderConfigPath(
    getRegisteredEnvText('KYBERION_PERSONAL_SURFACE_QUERY_CONFIG_PATH')?.trim() ||
      (catalog?.personal_overlay_path
        ? pathResolver.knowledge(catalog.personal_overlay_path)
        : DEFAULT_PERSONAL_OVERLAY_PATH)
  );
}

function getTenantOverlayPath(scope?: ScopeContext): string | null {
  const tenant = scope?.tenant_slug?.trim();
  if (!tenant) return null;
  const normalizedScope = assertScopeContext(scope!, { requireTenant: true });
  const normalizedTenant = normalizedScope.tenant_slug!;
  const catalogEntry = listSurfaceQueryOverlayCatalogEntries().find(
    (entry) => entry.kind === 'tenant' && entry.tenant === normalizedTenant
  );
  if (catalogEntry) return safeProviderConfigPath(pathResolver.knowledge(catalogEntry.path));
  return safeProviderConfigPath(
    pathResolver.knowledge(`confidential/${normalizedTenant}/presence/surface-query-providers.json`)
  );
}

function getEntityOverlayPath(scope?: ScopeContext): string[] {
  if (!scope?.tenant_slug) return [];
  const normalizedScope = assertScopeContext(scope, { requireTenant: true });
  const tenant = normalizedScope.tenant_slug!;
  const paths: string[] = [];
  if (normalizedScope.organization_id) {
    paths.push(
      safeProviderConfigPath(
        pathResolver.knowledge(
          `confidential/${tenant}/organizations/${normalizedScope.organization_id}/presence/surface-query-providers.json`
        )
      )
    );
  }
  if (normalizedScope.project_id) {
    paths.push(
      safeProviderConfigPath(
        pathResolver.knowledge(
          `confidential/${tenant}/organizations/${normalizedScope.organization_id || '_'}/projects/${normalizedScope.project_id}/presence/surface-query-providers.json`
        )
      )
    );
  }
  return paths;
}

function getRequestedRole(context: SurfaceQueryProviderContext): string | undefined {
  return (
    context.role?.trim() || getRegisteredEnvText('KYBERION_SURFACE_QUERY_ROLE')?.trim() || undefined
  );
}

function getRequestedPhase(context: SurfaceQueryProviderContext): string | undefined {
  return (
    context.phase?.trim() ||
    getRegisteredEnvText('KYBERION_SURFACE_QUERY_PHASE')?.trim() ||
    undefined
  );
}

export function getSurfaceQueryProviderConfig(
  context: SurfaceQueryProviderContext = {}
): SurfaceQueryProviderConfig {
  let configPath: string;
  let overlayPaths: string[];
  try {
    configPath = safeProviderConfigPath(
      getRegisteredEnvText('KYBERION_SURFACE_QUERY_CONFIG_PATH') || DEFAULT_CONFIG_PATH
    );
    loadSurfaceQueryOverlayCatalog();
    overlayPaths = [
      getTenantOverlayPath(context.scope),
      ...getEntityOverlayPath(context.scope),
      getPhaseOverlayPathForPhase(getRequestedPhase(context)),
      getRoleOverlayPathForRole(getRequestedRole(context)),
      getPersonalOverlayPath(),
    ]
      .filter((path): path is string => Boolean(path))
      .filter((path, index, self) => self.indexOf(path) === index);
  } catch (error) {
    if (!String(error).includes('RESOURCE_PATH_SCOPE')) throw error;
    cachedConfigPath = '__unsafe_surface_query_config__';
    cachedConfig = {};
    return cachedConfig;
  }
  const cacheKey = [
    configPath,
    scopeContextKey(context.scope || { tier: 'public' }),
    ...overlayPaths,
  ].join('::');
  if (cachedConfig && cachedConfigPath === cacheKey) return cachedConfig;

  if (!safeExistsSync(configPath)) {
    cachedConfigPath = cacheKey;
    cachedConfig = {};
    return cachedConfig;
  }

  try {
    let config = providerConfigCatalog(configPath).load();
    for (const overlayPath of overlayPaths) {
      if (!safeExistsSync(overlayPath)) continue;
      const overlay = providerConfigCatalog(overlayPath).load();
      config = mergeConfigs(config, overlay);
    }
    cachedConfig = config;
  } catch {
    cachedConfig = {};
  }
  cachedConfigPath = cacheKey;
  return cachedConfig;
}

export function _resetSurfaceQueryProviderConfigCacheForTests(): void {
  cachedConfig = null;
  cachedConfigPath = null;
  for (const catalog of providerConfigCatalogs.values()) catalog.reset();
}

export function isSurfaceLocationQuery(text: string): boolean {
  return /(今の場所|現在地|いまどこ|どこにいる|ここはどこ|where am i|my location|current location)/i.test(
    text.trim()
  );
}

export function isSurfaceWeatherQuery(text: string): boolean {
  return /(今日の天気|天気教えて|weather|forecast|気温|降水確率|雨降る|晴れ|天候)/i.test(
    text.trim()
  );
}

export function extractSurfaceWebSearchQuery(text: string): string | null {
  const trimmed = normalizeQuery(text);
  if (!/(検索|調べて|ググって|web|search|look up|find on the web)/i.test(trimmed)) return null;
  const stripped = stripLeadingPhrases(trimmed, [
    /^(web|ウェブ)\s*(で)?\s*/i,
    /^(検索|search)(して|してください|してくれる|して)?\s*/i,
    /^(調べて|調べると|look up|find)\s*/i,
    /^(web\s*search|internet\s*search)\s*/i,
  ])
    .replace(/\s*(を)?(検索|search|調べて|調べる|look up|find)(して|してください)?\s*$/i, '')
    .trim();
  return stripped || null;
}

export function extractSurfaceKnowledgeQuery(text: string): string | null {
  const trimmed = normalizeQuery(text);
  if (
    !/(ナレッジ|knowledge|docs?|ドキュメント|仕様|手順|context[_ -]?ranker|knowledge base)/i.test(
      trimmed
    )
  )
    return null;
  const stripped = stripLeadingPhrases(trimmed, [
    /^(ナレッジ|knowledge|knowledge base)(で|から|を)?\s*/i,
    /^(docs?|ドキュメント|仕様|手順)(で|から|を)?\s*/i,
    /^(調べて|検索して|search|look up)\s*/i,
  ])
    .replace(/\s*(を)?(調べて|検索して|search|look up)\s*$/i, '')
    .trim();
  return stripped || trimmed;
}

export function classifySurfaceQueryIntent(
  text: string,
  options: SurfaceIntentResolutionOptions = {}
): SurfaceQueryIntent {
  const packet =
    options.packet ||
    resolveIntentResolutionPacket(text, {
      tier: options.tier,
      tenantId: options.tenantId,
    });
  if (
    packet.selected_intent_id === 'knowledge-query' ||
    packet.selected_intent_id === 'query-knowledge'
  )
    return 'knowledge_search';
  if (packet.selected_intent_id === 'live-query') {
    if (isSurfaceLocationQuery(text)) return 'location';
    if (isSurfaceWeatherQuery(text)) return 'weather';
    if (extractSurfaceWebSearchQuery(text)) return 'web_search';
  }
  if (isSurfaceLocationQuery(text)) return 'location';
  if (isSurfaceWeatherQuery(text)) return 'weather';
  if (extractSurfaceKnowledgeQuery(text)) return 'knowledge_search';
  if (extractSurfaceWebSearchQuery(text)) return 'web_search';
  return null;
}
