import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { readTenantSemanticTokens } from './creative-design-resolver.js';
import {
  SEMANTIC_TOKEN_FALLBACKS,
  type SemanticEngine,
} from './semantic-design-token-fallbacks.js';

export type { SemanticEngine } from './semantic-design-token-fallbacks.js';

/**
 * Semantic design tokens for artifact engines (status.*, video.palette.*,
 * diagram.*, ...). Layering, lowest to highest precedence:
 *   last-resort fallback map (semantic-design-token-fallbacks.ts)
 *   → knowledge/public/design-patterns/semantic-design-tokens.json (defaults)
 *   → tenant overlay `theme.semantic_tokens.<engine>` via the design resolver.
 * Engines must read colours through here instead of inline hex literals.
 */

interface SemanticDesignTokensFile {
  version: string;
  engines: Partial<Record<SemanticEngine, Record<string, string>>>;
}

const DEFAULTS_PATH = pathResolver.rootResolve(
  'knowledge/public/design-patterns/semantic-design-tokens.json'
);
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/semantic-design-tokens.schema.json');

let defaultsCache: SemanticDesignTokensFile | null | undefined;
const resolvedCache = new Map<string, Record<string, string>>();

function loadDefaults(): SemanticDesignTokensFile | null {
  if (defaultsCache !== undefined) return defaultsCache;
  try {
    defaultsCache = defineCatalog<SemanticDesignTokensFile>({
      id: 'semantic-design-tokens',
      path: DEFAULTS_PATH,
      schema: SCHEMA_PATH,
    }).load();
  } catch {
    // Missing or invalid defaults file: the fallback map keeps engines working.
    defaultsCache = null;
  }
  return defaultsCache;
}

export interface ResolveSemanticTokensOptions {
  /** Defaults to the process tenant (KYBERION_TENANT). */
  tenantSlug?: string;
}

function activeTenant(options?: ResolveSemanticTokensOptions): string | undefined {
  const slug = options?.tenantSlug ?? getRegisteredEnvText('KYBERION_TENANT')?.trim();
  return slug || undefined;
}

export function resolveSemanticTokens(
  engine: SemanticEngine,
  options?: ResolveSemanticTokensOptions
): Record<string, string> {
  const tenant = activeTenant(options);
  const cacheKey = `${engine}\u0000${tenant ?? ''}`;
  const cached = resolvedCache.get(cacheKey);
  if (cached) return cached;
  const merged = {
    ...SEMANTIC_TOKEN_FALLBACKS[engine],
    ...(loadDefaults()?.engines?.[engine] ?? {}),
    ...readTenantSemanticTokens(tenant, engine),
  };
  resolvedCache.set(cacheKey, merged);
  return merged;
}

/** Read one semantic token; unknown names fail closed (a token typo must not render silently). */
export function semanticToken(
  engine: SemanticEngine,
  name: string,
  options?: ResolveSemanticTokensOptions
): string {
  const value = resolveSemanticTokens(engine, options)[name];
  if (value === undefined) {
    throw new Error(`Unknown semantic design token "${name}" for engine "${engine}"`);
  }
  return value;
}

export function resetSemanticTokenCache(): void {
  defaultsCache = undefined;
  resolvedCache.clear();
}
