/**
 * Layer 2 of the authorization registry (see
 * docs/UNIFIED_AUTHORIZATION_POLICY_DESIGN.ja.md): managed plugins declare
 * operation authorizations in a top-level `authorizations` manifest block —
 * same `{operations, prefixes}` shape as the file overlay, validated by the
 * same schema.
 *
 * Only plugins that pass `isManagedPluginActivationAllowed` contribute, and
 * the manifest is read from the managed copy — so these declarations are
 * bound to the install-time approval by the content digest (EP-01/EP-02).
 * A plugin that is not activated cannot smuggle in authority requirements.
 *
 * Registration: this module pushes a loader into
 * `governance/authorization-overlay.ts` at import (inbound edge — the overlay
 * never imports plugin machinery). It is wired from the skill plugin loader,
 * the single entry through which managed plugins activate; plugin operation
 * ids can only reach an admission boundary while the plugin machinery is
 * loaded, which is exactly when these declarations are registered.
 */
import * as path from 'node:path';

import { safeExistsSync, safeLstat } from '../secure-io.js';
import { readJsonIfPresent } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import {
  codeOperationPatterns,
  type AuthorizationOverlay,
  type AuthorizationSource,
} from '../foundation/authorization-registry.js';
import {
  authorizationOverlayCatalog,
  dropCodeCollisions,
  registerPluginAuthorizationLoader,
} from '../governance/authorization-overlay.js';
import { isManagedPluginActivationAllowed, listManagedPlugins } from './plugin-managed-install.js';
import { PLUGIN_MANIFEST_CANDIDATES } from './plugin-manifest-candidates.js';

const logger = createLogger('plugin-authorization-overlay');

type ManifestScan =
  | { kind: 'none' } // plugin has no authorizations block
  | { kind: 'ok'; overlay: AuthorizationOverlay }
  | { kind: 'error' }; // unreadable/invalid — must not be cached as "no declarations"

function manifestAuthorizations(managedPath: string, pluginId: string): ManifestScan {
  for (const candidate of PLUGIN_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(managedPath, candidate);
    if (!safeExistsSync(manifestPath) || !safeLstat(manifestPath).isFile()) continue;
    let parsed: unknown;
    try {
      parsed = readJsonIfPresent<unknown>(manifestPath);
    } catch (error) {
      logger.warn(
        `[AUTHZ_PLUGIN_MANIFEST_INVALID] ${pluginId}: unreadable manifest — ${error instanceof Error ? error.message : String(error)} | next: fix the manifest`
      );
      return { kind: 'error' };
    }
    const block =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).authorizations
        : undefined;
    if (block === undefined) return { kind: 'none' };
    const source: AuthorizationSource = `plugin:${pluginId}`;
    try {
      const validated = authorizationOverlayCatalog.validate(block, manifestPath);
      const code = codeOperationPatterns();
      return {
        kind: 'ok',
        overlay: {
          source,
          operations: dropCodeCollisions(validated.operations, new Set(code.operations), source),
          prefixes: dropCodeCollisions(validated.prefixes, new Set(code.prefixes), source),
        },
      };
    } catch (error) {
      logger.warn(
        `[AUTHZ_PLUGIN_AUTHORIZATIONS_INVALID] ${pluginId}: authorizations block rejected — ${error instanceof Error ? error.message : String(error)} | next: fix the manifest block`
      );
      return { kind: 'error' };
    }
  }
  return { kind: 'none' };
}

/** Manifest parses cached by the managed copy's content digest AND activation
 * status — a reinstall or approval-state change produces a different key, so
 * stale entries can never outlive the managed copy they describe. Error
 * results are deliberately not cached: a transient read failure must not
 * masquerade as "no declarations" until the next digest bump. */
const pluginOverlayCache = new Map<
  string,
  { digest: string; overlay: AuthorizationOverlay | undefined }
>();

export function scanPluginAuthorizations(): AuthorizationOverlay[] {
  let records;
  try {
    records = listManagedPlugins();
  } catch (error) {
    logger.warn(
      `[AUTHZ_PLUGIN_SCAN_FAILED] managed plugin scan failed — ${error instanceof Error ? error.message : String(error)} | next: check managed plugin root`
    );
    return [];
  }
  const overlays: AuthorizationOverlay[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!isManagedPluginActivationAllowed(record)) continue;
    seen.add(record.pluginId);
    const digest = `${record.contentDigest ?? record.managedPath}:${record.activationStatus}`;
    const cached = pluginOverlayCache.get(record.pluginId);
    if (cached?.digest === digest) {
      if (cached.overlay) overlays.push(cached.overlay);
      continue;
    }
    const scan = manifestAuthorizations(record.managedPath, record.pluginId);
    if (scan.kind === 'error') continue; // never persist an error as "no declarations"
    const overlay = scan.kind === 'ok' ? scan.overlay : undefined;
    pluginOverlayCache.set(record.pluginId, { digest, overlay });
    if (overlay) overlays.push(overlay);
  }
  for (const id of pluginOverlayCache.keys()) {
    if (!seen.has(id)) pluginOverlayCache.delete(id);
  }
  return overlays;
}

registerPluginAuthorizationLoader(scanPluginAuthorizations);
