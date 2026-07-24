/**
 * libs/core/skill-plugin-loader.ts
 *
 * KD-06 wiring: enforces provenance trust + managed-copy isolation at the
 * point skill plugins (`.kyberion-plugins.json`) are actually loaded.
 *
 * Before this module existed, `runSkillAsync` had no plugin-loading path at
 * all — `plugins/README.md` documented a "loaded automatically during
 * runSkill()" contract that the runtime never implemented. This module is
 * that loading path, built gated from the start: a configured plugin path is
 * only ever executed if it is either
 *
 *   1. `official` — resolves (symlinks followed) inside this repo's own
 *      `plugins/` tree, exactly like today's in-tree plugins, or
 *   2. a **managed-copy install** (`installPluginManaged` /
 *      `libs/core/plugin-managed-install.ts`) whose activation status is
 *      `activatable` (official-by-provenance, or third-party with a human
 *      `approved` decision already applied via `refreshManagedPluginActivation`).
 *
 * Everything else — an arbitrary path dropped into `.kyberion-plugins.json`,
 * a managed install still `pending_approval`, a `blocked_broken_manifest`
 * entry — is skipped with a diagnostic and its file is never `import()`-ed.
 * This is a fail-open *display* (a skipped plugin never blocks the skill
 * run) but a fail-closed *execution* contract: "fail-open" here never means
 * "execute anyway".
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from './core.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import {
  derivePluginTrustLabel,
  isPathContainedIn,
  type PluginTrustLabel,
} from './plugin-source-trust.js';
import {
  isManagedPluginActivationAllowed,
  listManagedPlugins,
  type ManagedPluginRecord,
} from './plugin-managed-install.js';

export const SKILL_PLUGINS_CONFIG_FILENAME = '.kyberion-plugins.json';

export interface SkillPluginHookModule {
  beforeSkill?: (skillName: string, args: unknown) => unknown;
  afterSkill?: (skillName: string, output: unknown) => unknown;
  [exportName: string]: unknown;
}

export interface SkillPluginAuthorization {
  /** Exactly as written in .kyberion-plugins.json (before any resolution). */
  configuredPath: string;
  /** Fully resolved (symlinks followed) absolute path. */
  resolvedPath: string;
  trust: PluginTrustLabel;
  allowed: boolean;
  /** Set only when `allowed` is backed by a managed-copy install. */
  managedPluginId?: string;
  reason: string;
}

export interface LoadedSkillPlugin {
  configuredPath: string;
  resolvedPath: string;
  module: SkillPluginHookModule;
}

export interface SkillPluginLoadResult {
  loaded: LoadedSkillPlugin[];
  /** Every configured path that was NOT loaded, with the reason why. */
  diagnostics: SkillPluginAuthorization[];
}

/**
 * Reads `.kyberion-plugins.json` from `cwd` (never throws — a missing or
 * malformed config degrades to "no plugins configured", matching the
 * existing fail-open contract for the rest of the plugin surface).
 */
export function readSkillPluginsConfig(cwd: string): string[] {
  const configPath = path.join(cwd, SKILL_PLUGINS_CONFIG_FILENAME);
  if (!safeExistsSync(configPath)) return [];
  try {
    const raw = safeReadFile(configPath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as { plugins?: unknown };
    if (!parsed || !Array.isArray(parsed.plugins)) return [];
    return parsed.plugins.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
    );
  } catch (err) {
    logger.warn(
      `[skill-plugin-loader] Failed to read ${SKILL_PLUGINS_CONFIG_FILENAME}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

function findManagedRecordFor(
  resolvedPath: string,
  managedRoot?: string
): ManagedPluginRecord | undefined {
  return listManagedPlugins(managedRoot).find((record) =>
    isPathContainedIn(record.managedPath, resolvedPath)
  );
}

/**
 * Derives whether a single configured plugin path may be loaded, per KD-06:
 * provenance trust is derived from the resolved filesystem location alone —
 * never from a manifest, never from the config entry itself. Never throws;
 * a trust-derivation failure is treated as untrusted (deny by default).
 *
 * `managedRoot` defaults to the real managed-plugins directory
 * (`plugin-managed-install.ts`'s own default); it is overridable only so
 * tests can point at an isolated scratch root without touching shared state.
 */
export function authorizeSkillPlugin(
  configuredPath: string,
  cwd: string,
  managedRoot?: string
): SkillPluginAuthorization {
  const resolvedPathGuess = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(cwd, configuredPath);

  try {
    const trust = derivePluginTrustLabel(resolvedPathGuess);

    if (trust.label === 'official') {
      return {
        configuredPath,
        resolvedPath: trust.resolvedSourcePath,
        trust: trust.label,
        allowed: true,
        reason: trust.reason,
      };
    }

    // Anything other than official must be a managed-copy install whose
    // activation status is already approved (or would-be-official within
    // the managed tree). Never fall back to executing the raw path.
    const managed = findManagedRecordFor(trust.resolvedSourcePath, managedRoot);
    if (managed && isManagedPluginActivationAllowed(managed)) {
      return {
        configuredPath,
        resolvedPath: trust.resolvedSourcePath,
        trust: trust.label,
        allowed: true,
        managedPluginId: managed.pluginId,
        reason: `Managed-copy install '${managed.pluginId}' is activatable (trust=${managed.trust}).`,
      };
    }

    const reason = managed
      ? `Managed-copy install '${managed.pluginId}' found but not activatable (status=${managed.activationStatus}); skipping rather than executing an unapproved plugin.`
      : `Path is not inside this repository's plugins/ tree and is not a managed-copy install (${trust.reason}); skipping rather than executing untrusted code.`;
    return {
      configuredPath,
      resolvedPath: trust.resolvedSourcePath,
      trust: trust.label,
      allowed: false,
      managedPluginId: managed?.pluginId,
      reason,
    };
  } catch (err) {
    return {
      configuredPath,
      resolvedPath: resolvedPathGuess,
      trust: 'third-party',
      allowed: false,
      reason: `Trust could not be derived, treated as untrusted: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Authorizes every plugin path configured in `.kyberion-plugins.json` under
 * `cwd`, WITHOUT importing/executing any of them. Pure decision function —
 * kept separate from `loadAuthorizedSkillPlugins` so the gate itself is
 * testable without needing a real ESM module on disk.
 */
export function authorizeConfiguredSkillPlugins(
  cwd: string = process.cwd(),
  managedRoot?: string
): SkillPluginAuthorization[] {
  return readSkillPluginsConfig(cwd).map((configuredPath) =>
    authorizeSkillPlugin(configuredPath, cwd, managedRoot)
  );
}

/**
 * Loads (via dynamic `import()`) every configured plugin that passed
 * `authorizeSkillPlugin`, and logs+returns a diagnostic for every one that
 * didn't. A denied/unmanaged plugin's file is never `import()`-ed — the
 * authorization check runs strictly before any module resolution.
 */
export async function loadAuthorizedSkillPlugins(
  cwd: string = process.cwd(),
  managedRoot?: string
): Promise<SkillPluginLoadResult> {
  const authorizations = authorizeConfiguredSkillPlugins(cwd, managedRoot);
  const loaded: LoadedSkillPlugin[] = [];
  const diagnostics: SkillPluginAuthorization[] = [];

  for (const authorization of authorizations) {
    if (!authorization.allowed) {
      diagnostics.push(authorization);
      logger.warn(
        `[skill-plugin-loader] Skipped plugin '${authorization.configuredPath}' (trust=${authorization.trust}): ${authorization.reason}`
      );
      continue;
    }
    try {
      const mod = (await import(
        pathToFileURL(authorization.resolvedPath).href
      )) as SkillPluginHookModule;
      loaded.push({
        configuredPath: authorization.configuredPath,
        resolvedPath: authorization.resolvedPath,
        module: mod,
      });
    } catch (err) {
      const diagnostic: SkillPluginAuthorization = {
        ...authorization,
        allowed: false,
        reason: `Authorized but failed to load: ${err instanceof Error ? err.message : String(err)}`,
      };
      diagnostics.push(diagnostic);
      logger.warn(
        `[skill-plugin-loader] Failed to load authorized plugin '${authorization.configuredPath}': ${diagnostic.reason}`
      );
    }
  }

  return { loaded, diagnostics };
}

/**
 * Fires a `beforeSkill`/`afterSkill` hook across every loaded plugin. Never
 * throws — a plugin hook that throws is logged and skipped, matching the
 * existing plugin contract ("Plugins MUST NOT throw errors that break skill
 * execution", plugins/README.md) and the fail-open display / fail-closed
 * execution split this module exists to enforce.
 */
export async function fireSkillPluginHook(
  hook: 'beforeSkill' | 'afterSkill',
  plugins: LoadedSkillPlugin[],
  skillName: string,
  payload: unknown
): Promise<void> {
  for (const plugin of plugins) {
    const fn = plugin.module[hook];
    if (typeof fn !== 'function') continue;
    try {
      await fn(skillName, payload);
    } catch (err) {
      logger.warn(
        `[skill-plugin-loader] Plugin '${plugin.configuredPath}' ${hook} hook threw (ignored, fail-open): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
