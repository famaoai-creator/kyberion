import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { listSurfaceQueryOverlayCatalogEntries, loadSurfaceQueryOverlayCatalog } from './surface-query-overlay-catalog.js';

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
    timeoutMs?: number;
  };
  location?: {
    enabled?: boolean;
    provider?: string;
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
}

export type SurfaceQueryIntent = 'weather' | 'location' | 'web_search' | 'knowledge_search' | null;

const DEFAULT_CONFIG_PATH = pathResolver.knowledge('public/presence/surface-query-providers.json');
const DEFAULT_PERSONAL_OVERLAY_PATH = pathResolver.knowledge('personal/presence/surface-query-providers.json');
const CONFIG_SCHEMA_PATH = pathResolver.knowledge('public/schemas/surface-query-providers.schema.json');

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

let cachedConfig: SurfaceQueryProviderConfig | null = null;
let cachedConfigPath: string | null = null;
let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, CONFIG_SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateConfig(value: unknown, label: string): SurfaceQueryProviderConfig {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid surface query provider config at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as SurfaceQueryProviderConfig;
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
  return catalogEntry ? pathResolver.knowledge(catalogEntry.path) : null;
}

function getPhaseOverlayPathForPhase(phase?: string): string | null {
  const normalized = phase?.trim();
  if (!normalized) return null;
  const catalogEntry = listSurfaceQueryOverlayCatalogEntries().find(
    (entry) => entry.kind === 'phase' && entry.phase === normalized
  );
  return catalogEntry ? pathResolver.knowledge(catalogEntry.path) : null;
}

function getPersonalOverlayPath(): string | null {
  const catalog = loadSurfaceQueryOverlayCatalog();
  return (
    process.env.KYBERION_PERSONAL_SURFACE_QUERY_CONFIG_PATH?.trim() ||
    (catalog?.personal_overlay_path ? pathResolver.knowledge(catalog.personal_overlay_path) : DEFAULT_PERSONAL_OVERLAY_PATH)
  );
}

function getRequestedRole(context: SurfaceQueryProviderContext): string | undefined {
  return context.role?.trim() || process.env.KYBERION_SURFACE_QUERY_ROLE?.trim() || undefined;
}

function getRequestedPhase(context: SurfaceQueryProviderContext): string | undefined {
  return context.phase?.trim() || process.env.KYBERION_SURFACE_QUERY_PHASE?.trim() || undefined;
}

export function getSurfaceQueryProviderConfig(
  context: SurfaceQueryProviderContext = {}
): SurfaceQueryProviderConfig {
  const configPath = process.env.KYBERION_SURFACE_QUERY_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  loadSurfaceQueryOverlayCatalog();
  const overlayPaths = [
    getPhaseOverlayPathForPhase(getRequestedPhase(context)),
    getRoleOverlayPathForRole(getRequestedRole(context)),
    getPersonalOverlayPath(),
  ]
    .filter((path): path is string => Boolean(path))
    .filter((path, index, self) => self.indexOf(path) === index);
  const cacheKey = [configPath, ...overlayPaths].join('::');
  if (cachedConfig && cachedConfigPath === cacheKey) return cachedConfig;

  if (!safeExistsSync(configPath)) {
    cachedConfigPath = cacheKey;
    cachedConfig = {};
    return cachedConfig;
  }

  try {
    let config = validateConfig(
      JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string),
      configPath
    );
    for (const overlayPath of overlayPaths) {
      if (!safeExistsSync(overlayPath)) continue;
      const overlay = validateConfig(
        JSON.parse(safeReadFile(overlayPath, { encoding: 'utf8' }) as string),
        overlayPath
      );
      config = mergeConfigs(config, overlay);
    }
    cachedConfig = config;
  } catch {
    cachedConfig = {};
  }
  cachedConfigPath = cacheKey;
  return cachedConfig;
}

export function resetSurfaceQueryProviderConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
}

export function isSurfaceLocationQuery(text: string): boolean {
  return /(今の場所|現在地|いまどこ|どこにいる|ここはどこ|where am i|my location|current location)/i.test(text.trim());
}

export function isSurfaceWeatherQuery(text: string): boolean {
  return /(今日の天気|天気教えて|weather|forecast|気温|降水確率|雨降る|晴れ|天候)/i.test(text.trim());
}

export function extractSurfaceWebSearchQuery(text: string): string | null {
  const trimmed = normalizeQuery(text);
  if (!/(検索|調べて|ググって|web|search|look up|find on the web)/i.test(trimmed)) return null;
  const stripped = stripLeadingPhrases(trimmed, [
    /^(web|ウェブ)\s*(で)?\s*/i,
    /^(検索|search)(して|してください|してくれる|して)?\s*/i,
    /^(調べて|調べると|look up|find)\s*/i,
    /^(web\s*search|internet\s*search)\s*/i,
  ]).replace(/\s*(を)?(検索|search|調べて|調べる|look up|find)(して|してください)?\s*$/i, '').trim();
  return stripped || null;
}

export function extractSurfaceKnowledgeQuery(text: string): string | null {
  const trimmed = normalizeQuery(text);
  if (!/(ナレッジ|knowledge|docs?|ドキュメント|仕様|手順|context[_ -]?ranker|knowledge base)/i.test(trimmed)) return null;
  const stripped = stripLeadingPhrases(trimmed, [
    /^(ナレッジ|knowledge|knowledge base)(で|から|を)?\s*/i,
    /^(docs?|ドキュメント|仕様|手順)(で|から|を)?\s*/i,
    /^(調べて|検索して|search|look up)\s*/i,
  ]).replace(/\s*(を)?(調べて|検索して|search|look up)\s*$/i, '').trim();
  return stripped || trimmed;
}

export function classifySurfaceQueryIntent(text: string): SurfaceQueryIntent {
  const packet = resolveIntentResolutionPacket(text);
  if (packet.selected_intent_id === 'knowledge-query' || packet.selected_intent_id === 'query-knowledge') return 'knowledge_search';
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
