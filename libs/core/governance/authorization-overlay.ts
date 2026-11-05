/**
 * Data-plane extension for the authorization registry (Layer 1 of the unified
 * authorization design — see docs/UNIFIED_AUTHORIZATION_POLICY_DESIGN.ja.md).
 *
 * The **file overlay** — `knowledge/product/governance/authorization-registry.json`
 * (or the active customer's `policy/authorization-registry.json` override) —
 * loads through the governed-catalog pipeline: schema-validated, signature
 * cached, fail-safe (`fallbackOnInvalid` — a broken overlay is ignored
 * entirely rather than partially applied).
 *
 * **Plugin declarations** (Layer 2) do not live here: the plugin subsystem
 * registers a loader via {@link registerPluginAuthorizationLoader} when it is
 * active (`plugin/plugin-authorization-overlay.ts`, wired from the skill
 * plugin loader). Keeping that edge inbound-only keeps this module — and
 * every `operationAuthorization` consumer — free of the managed-plugin
 * dependency graph.
 *
 * Ordering: the file overlay is supplied before plugin overlays; an exact id
 * always beats every prefix regardless of source order; among prefixes the
 * longest wins, ties go to the earlier overlay. Independently,
 * `operationAuthorization` always prefers a code declaration over every data
 * declaration — data can add coverage but can never weaken a reviewed entry.
 * The schema additionally forbids `local_only` and `authority.kind:'free'` in
 * every data entry, so bypassing admission always requires a reviewed code
 * declaration.
 *
 * Import this module once for its registration side effect (external-operation
 * boundary and target builder already do). Callers that skip it simply see
 * code declarations only — missing data resolves to the fail-safe default.
 */
import { pathResolver } from '../path-resolver.js';
import * as customerResolver from '../stance-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { createLogger } from '../logger.js';
import {
  codeOperationPatterns,
  setAuthorizationOverlayProvider,
  type AuthorizationOverlay,
  type AuthorizationRegistryEntry,
  type AuthorizationSource,
} from '../foundation/authorization-registry.js';

const logger = createLogger('authorization-overlay');

interface OverlayFile {
  version?: string;
  operations?: Record<string, AuthorizationRegistryEntry>;
  prefixes?: Record<string, AuthorizationRegistryEntry>;
}

export const authorizationOverlayCatalog = defineCatalog<OverlayFile>({
  id: 'authorization-registry',
  path: () => {
    const customerPath = customerResolver.stanceRoot('policy/authorization-registry.json');
    const fallbackPath = assertSafeRepositoryPath(
      pathResolver.knowledge('product/governance/authorization-registry.json')
    );
    if (!customerPath) return fallbackPath;
    const safeCustomerPath = assertSafeRepositoryPath(customerPath, { allowMissingLeaf: true });
    return safeExistsSync(safeCustomerPath) ? safeCustomerPath : fallbackPath;
  },
  schema: pathResolver.knowledge('product/schemas/authorization-registry.schema.json'),
  fallback: { operations: {}, prefixes: {} },
  fallbackOnInvalid: true,
  onFallback: (error) =>
    logger.warn(
      `[AUTHZ_OVERLAY_IGNORED] Overlay catalog unusable — ${error instanceof Error ? error.message : String(error)} | next: fix or remove the overlay file`
    ),
});

/** Drops entries that collide with code-owned keys — the lookup ignores them
 * anyway; the warn tells the author their declaration is inert. Exported so
 * plugin-declaration loaders apply the identical rule. */
export function dropCodeCollisions(
  table: Record<string, AuthorizationRegistryEntry> | undefined,
  codeKeys: ReadonlySet<string>,
  source: AuthorizationSource
): Record<string, AuthorizationRegistryEntry> {
  const kept: Record<string, AuthorizationRegistryEntry> = {};
  for (const [key, entry] of Object.entries(table ?? {})) {
    if (codeKeys.has(key)) {
      logger.warn(
        `[AUTHZ_OVERLAY_COLLISION] ${source} declares '${key}' which is already code-owned — ignored | next: rename or remove the data entry`
      );
      continue;
    }
    kept[key] = entry;
  }
  return kept;
}

function fileOverlay(): AuthorizationOverlay {
  const loaded = authorizationOverlayCatalog.load();
  const code = codeOperationPatterns();
  return {
    source: 'overlay',
    operations: dropCodeCollisions(loaded.operations, new Set(code.operations), 'overlay'),
    prefixes: dropCodeCollisions(loaded.prefixes, new Set(code.prefixes), 'overlay'),
  };
}

const pluginLoaders: Array<() => AuthorizationOverlay[]> = [];

/** Inbound-only edge: the plugin subsystem registers its declaration loader
 * here (see plugin/plugin-authorization-overlay.ts). Loaders run per lookup;
 * a throwing loader is skipped so a broken plugin cannot destabilize authz. */
export function registerPluginAuthorizationLoader(loader: () => AuthorizationOverlay[]): void {
  pluginLoaders.push(loader);
}

export function loadAuthorizationOverlays(): readonly AuthorizationOverlay[] {
  const overlays: AuthorizationOverlay[] = [fileOverlay()];
  for (const loader of pluginLoaders) {
    try {
      overlays.push(...loader());
    } catch (error) {
      logger.warn(
        `[AUTHZ_PLUGIN_LOADER_FAILED] plugin authorization loader threw — ${error instanceof Error ? error.message : String(error)} | next: fix the plugin loader`
      );
    }
  }
  return overlays;
}

setAuthorizationOverlayProvider(loadAuthorizationOverlays);
