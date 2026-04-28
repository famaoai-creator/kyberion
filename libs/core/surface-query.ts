import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';

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

export type SurfaceQueryIntent = 'weather' | 'location' | 'web_search' | 'knowledge_search' | null;

const DEFAULT_CONFIG_PATH = pathResolver.knowledge('public/presence/surface-query-providers.json');

let cachedConfig: SurfaceQueryProviderConfig | null = null;
let cachedConfigPath: string | null = null;

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

export function getSurfaceQueryProviderConfig(): SurfaceQueryProviderConfig {
  const configPath = process.env.KYBERION_SURFACE_QUERY_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  if (cachedConfig && cachedConfigPath === configPath) return cachedConfig;

  if (!safeExistsSync(configPath)) {
    cachedConfigPath = configPath;
    cachedConfig = {};
    return cachedConfig;
  }

  try {
    cachedConfig = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string) as SurfaceQueryProviderConfig;
  } catch {
    cachedConfig = {};
  }
  cachedConfigPath = configPath;
  return cachedConfig;
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
