/**
 * Tool Context Resolver
 *
 * Reads tool-catalog.json (the single source of truth for ToolDefinition schemas)
 * and tool-context-registry.json (the mapping of context types to tool IDs)
 * to produce the appropriate ToolDefinition[] for a given reasoning context.
 *
 * Usage:
 *   const tools = resolveToolsForContext('task_session');
 *   const result = await backend.generateWithTools(prompt, tools);
 */

import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeExistsSync } from './secure-io.js';
import { safeJsonParse } from './validators.js';
import type { ToolDefinition } from './reasoning-backend.js';

const TOOL_CATALOG_PATH = pathResolver.knowledge('product/governance/tool-catalog.json');
const TOOL_CONTEXT_REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/tool-context-registry.json'
);

export type ToolContextType = 'ask' | 'task_session' | 'mission' | 'research' | 'analysis' | string;

interface ToolCatalog {
  version: string;
  tools: Record<string, ToolDefinition>;
}

interface ToolContextRegistry {
  version: string;
  contexts: Record<string, { description: string; tools: string[] }>;
}

let cachedCatalog: ToolCatalog | null = null;
let cachedRegistry: ToolContextRegistry | null = null;

function loadCatalog(): ToolCatalog {
  if (cachedCatalog) return cachedCatalog;
  if (!safeExistsSync(TOOL_CATALOG_PATH)) {
    logger.warn('[tool-context-resolver] tool-catalog.json not found; returning empty catalog.');
    cachedCatalog = { version: 'fallback', tools: {} };
    return cachedCatalog;
  }
  const raw = safeReadFile(TOOL_CATALOG_PATH, { encoding: 'utf8' }) as string;
  cachedCatalog = safeJsonParse<ToolCatalog>(raw, 'tool-catalog');
  return cachedCatalog;
}

function loadRegistry(): ToolContextRegistry {
  if (cachedRegistry) return cachedRegistry;
  if (!safeExistsSync(TOOL_CONTEXT_REGISTRY_PATH)) {
    logger.warn(
      '[tool-context-resolver] tool-context-registry.json not found; returning empty registry.'
    );
    cachedRegistry = { version: 'fallback', contexts: {} };
    return cachedRegistry;
  }
  const raw = safeReadFile(TOOL_CONTEXT_REGISTRY_PATH, { encoding: 'utf8' }) as string;
  cachedRegistry = safeJsonParse<ToolContextRegistry>(raw, 'tool-context-registry');
  return cachedRegistry;
}

/** Reset caches (useful in tests or after file edits). */
export function resetToolContextResolverCache(): void {
  cachedCatalog = null;
  cachedRegistry = null;
}

/**
 * Infer the context type from the execution context (`ctx`) of a pipeline step.
 * Priority: explicit `tool_context` param > `mission_id` in ctx > `task_id` in ctx > 'ask'.
 */
export function inferContextType(
  ctx: Record<string, any>,
  params?: Record<string, any>
): ToolContextType {
  // Explicit override from pipeline params takes highest priority
  const explicit = params?.tool_context ?? params?.context_type;
  if (typeof explicit === 'string' && explicit) return explicit;

  // task_session: has both mission_id and task_id (a specific task was delegated)
  if (ctx.mission_id && (ctx.task_id || ctx.task_session_id)) return 'task_session';

  // mission: has mission_id but no specific task
  if (ctx.mission_id) return 'mission';

  // research: has project_id only
  if (ctx.project_id) return 'research';

  // Default: plain ask
  return 'ask';
}

/**
 * Resolve the list of ToolDefinitions for a given context type.
 * Falls back to an empty list if the context is unknown or tools are disabled.
 */
export function resolveToolsForContext(contextType: ToolContextType): ToolDefinition[] {
  const catalog = loadCatalog();
  const registry = loadRegistry();

  const contextDef = registry.contexts[contextType];
  if (!contextDef) {
    logger.info(
      `[tool-context-resolver] Unknown context type "${contextType}"; no tools resolved.`
    );
    return [];
  }

  const toolIds = contextDef.tools ?? [];
  const resolved: ToolDefinition[] = [];

  for (const id of toolIds) {
    const def = catalog.tools[id];
    if (def) {
      resolved.push(def);
    } else {
      logger.warn(
        `[tool-context-resolver] Tool "${id}" referenced in context "${contextType}" not found in catalog.`
      );
    }
  }

  return resolved;
}
