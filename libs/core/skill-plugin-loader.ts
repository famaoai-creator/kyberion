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
import type { ValidateFunction } from 'ajv';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import { parseSafeJsonInput } from './foundation/json.js';
import { compileSchema } from './foundation/ajv.js';
import { isRecord } from './foundation/text.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
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
import type { ScopeContext } from './scope-context.js';
import { applyNarrowOnlyFilter } from './resource-provenance.js';
import {
  activatePluginContributions,
  type PluginContributionActivation,
  type PluginContributionDeclaration,
  type PluginContributionModule,
} from './plugin-contributions.js';

export const SKILL_PLUGINS_CONFIG_FILENAME = '.kyberion-plugins.json';

export interface SkillPluginHookModule {
  beforeSkill?: (skillName: string, args: unknown) => unknown;
  afterSkill?: (skillName: string, output: unknown) => unknown;
  registerKyberionContributions?: PluginContributionModule['registerKyberionContributions'];
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
  contributions?: PluginContributionActivation;
}

export interface SkillPluginLoadResult {
  loaded: LoadedSkillPlugin[];
  /** Every configured path that was NOT loaded, with the reason why. */
  diagnostics: SkillPluginAuthorization[];
}

export interface RestrictedSkillRecord {
  name?: string;
  status?: string;
  reason?: string;
  allow_override?: boolean;
}

interface RestrictedSkillsPolicy {
  version: string | number;
  last_updated: string;
  restrictions: RestrictedSkillRecord[];
  tenant_overrides: Record<string, { restrictions: RestrictedSkillRecord[] }>;
  organization_overrides: Record<string, { restrictions: RestrictedSkillRecord[] }>;
  project_overrides: Record<string, { restrictions: RestrictedSkillRecord[] }>;
}

const PLUGIN_CONTRIBUTION_KEYS = [
  'seams',
  'ops',
  'providers',
  'hooks',
  'prompt_sections',
  'facets',
] as const;

export function normalizePluginContributionDeclaration(
  value: unknown
): PluginContributionDeclaration | undefined {
  if (!isRecord(value)) return undefined;
  const declaration: PluginContributionDeclaration = {};
  for (const key of PLUGIN_CONTRIBUTION_KEYS) {
    const rawValues = value[key];
    if (rawValues === undefined) continue;
    if (
      !Array.isArray(rawValues) ||
      rawValues.some((entry) => typeof entry !== 'string' || !entry.trim())
    ) {
      throw new Error(`[PLUGIN_MANIFEST_INVALID] provides.${key} must be a non-empty string array`);
    }
    declaration[key] = rawValues.map((entry) => entry.trim());
  }
  return declaration;
}

const RESTRICTED_SKILLS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/restricted-skills.schema.json'
);
const SKILL_PLUGINS_CONFIG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/skill-plugins-config.schema.json'
);
const restrictedSkillsCatalogs = new Map<string, GovernedCatalog<RestrictedSkillsPolicy>>();
let skillPluginsConfigValidateFn: ValidateFunction | null = null;

interface SkillPluginsConfig {
  plugins?: string[];
  tenant_overrides?: Record<string, { plugins?: string[] }>;
  organization_overrides?: Record<string, { plugins?: string[] }>;
  project_overrides?: Record<string, { plugins?: string[] }>;
}

/**
 * Project/plugin configuration may live outside this repository, so the
 * repository-only assertion is not appropriate here. We still reject a
 * symlink at the trust-input itself before parsing it: configuration and
 * manifests must not silently redirect to another scope.
 */
function assertNoSymlinkTraversal(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    if (safeLstat(absolute).isSymbolicLink()) {
      throw new Error(
        `[PLUGIN_RESOURCE_SYMLINK] resource path cannot traverse a symbolic link: ${filePath}`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[PLUGIN_RESOURCE_SYMLINK]')) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return absolute;
}

function getRestrictedSkillsCatalog(rootDir?: string): GovernedCatalog<RestrictedSkillsPolicy> {
  const policyPath = rootDir
    ? path.join(rootDir, 'knowledge', 'product', 'governance', 'restricted-skills.json')
    : pathResolver.knowledge('product/governance/restricted-skills.json');
  let catalog = restrictedSkillsCatalogs.get(policyPath);
  if (!catalog) {
    catalog = defineCatalog<RestrictedSkillsPolicy>({
      id: 'restricted-skills',
      path: policyPath,
      schema: RESTRICTED_SKILLS_SCHEMA_PATH,
    });
    restrictedSkillsCatalogs.set(policyPath, catalog);
  }
  return catalog;
}

function ensureSkillPluginsConfigValidator(): ValidateFunction {
  if (skillPluginsConfigValidateFn) return skillPluginsConfigValidateFn;
  skillPluginsConfigValidateFn = compileSchema(SKILL_PLUGINS_CONFIG_SCHEMA_PATH);
  return skillPluginsConfigValidateFn;
}

/**
 * Load a project-owned plugin configuration without applying the
 * repository-only catalog boundary: project cwd may be outside this repo.
 * The resource itself remains symlink- and schema-gated before selectors are
 * interpreted.
 */
export function loadSkillPluginsConfigAtPath(filePath: string): SkillPluginsConfig {
  const safeFilePath = assertNoSymlinkTraversal(filePath);
  if (!safeExistsSync(safeFilePath)) {
    throw new Error(`[PLUGIN_CONFIG_MISSING] ${safeFilePath}`);
  }
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[PLUGIN_CONFIG_INVALID] config must be a regular file: ${filePath}`);
  }
  const parsed = parseSafeJsonInput(
    String(safeReadFile(safeFilePath, { encoding: 'utf8' })),
    `skill plugin config ${safeFilePath}`
  );
  const validate = ensureSkillPluginsConfigValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim())
      .join('; ');
    throw new Error(`[PLUGIN_CONFIG_INVALID] ${safeFilePath}: ${errors}`);
  }
  return parsed as SkillPluginsConfig;
}

/**
 * Overlay policy is narrow-only: a local record may restrict a skill, but it
 * cannot turn a globally restricted skill back on.  Human approval remains a
 * separate, explicit gate rather than an implicit manifest escape hatch.
 */
export function evaluateSkillRestrictionRecords(
  skillName: string,
  records: RestrictedSkillRecord[]
): { allowed: boolean; reason?: string } {
  const restricted = records.find(
    (record) => record.name === skillName && record.status === 'restricted'
  );
  if (!restricted) return { allowed: true };
  return {
    allowed: false,
    reason: `skill '${skillName}' is restricted by governed policy`,
  };
}

/** Consume the governed restricted-skills catalog at the skill execution gate. */
export function isSkillAllowed(
  skillName: string,
  scope?: ScopeContext,
  rootDir?: string
): { allowed: boolean; reason?: string } {
  const policyPath = getRestrictedSkillsCatalog(rootDir).path();
  if (!safeExistsSync(policyPath)) return { allowed: true };
  try {
    const parsed = getRestrictedSkillsCatalog(rootDir).load();
    const records = [
      ...parsed.restrictions,
      ...(scope?.tenant_slug ? parsed.tenant_overrides[scope.tenant_slug]?.restrictions || [] : []),
      ...(scope?.organization_id
        ? parsed.organization_overrides[scope.organization_id]?.restrictions || []
        : []),
      ...(scope?.project_id ? parsed.project_overrides[scope.project_id]?.restrictions || [] : []),
    ];
    return evaluateSkillRestrictionRecords(skillName, records);
  } catch {
    return { allowed: false, reason: 'restricted-skills policy is unreadable' };
  }
}

/**
 * Reads `.kyberion-plugins.json` from `cwd` (never throws — a missing or
 * malformed config degrades to "no plugins configured", matching the
 * existing fail-open contract for the rest of the plugin surface).
 */
export function readSkillPluginsConfig(cwd: string, scope?: ScopeContext): string[] {
  try {
    const configPath = assertNoSymlinkTraversal(path.join(cwd, SKILL_PLUGINS_CONFIG_FILENAME));
    if (!safeExistsSync(configPath)) return [];
    const parsed = loadSkillPluginsConfigAtPath(configPath);
    const base = (Array.isArray(parsed.plugins) ? parsed.plugins : []).filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
    );
    const overlays = [
      scope?.tenant_slug ? parsed.tenant_overrides?.[scope.tenant_slug] : undefined,
      scope?.organization_id ? parsed.organization_overrides?.[scope.organization_id] : undefined,
      scope?.project_id ? parsed.project_overrides?.[scope.project_id] : undefined,
    ];
    let selected = base;
    for (const overlay of overlays) {
      if (!Array.isArray(overlay?.plugins)) continue;
      const selectors = overlay.plugins.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
      );
      if (selectors.length === 0) continue;
      selected = applyNarrowOnlyFilter(selected, selectors).values;
    }
    return selected;
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

function readPluginManifestProvides(resolvedPath: string): {
  pluginId?: string;
  provides?: PluginContributionDeclaration;
} {
  let cursor = path.dirname(resolvedPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidates = [
      path.join(cursor, 'plugin-manifest.json'),
      path.join(cursor, 'plugin.json'),
      path.join(cursor, '.claude-plugin', 'plugin.json'),
    ];
    const manifestPath = candidates
      .map((candidate) => assertNoSymlinkTraversal(candidate))
      .find((candidate) => safeExistsSync(candidate));
    if (manifestPath) {
      try {
        const parsed = parseSafeJsonInput(
          String(safeReadFile(manifestPath, { encoding: 'utf8' })),
          `plugin manifest ${manifestPath}`
        );
        if (!isRecord(parsed)) throw new Error('plugin manifest root must be a JSON object');
        const provides = normalizePluginContributionDeclaration(parsed.provides);
        return {
          pluginId:
            typeof parsed.plugin_id === 'string'
              ? parsed.plugin_id
              : typeof parsed.name === 'string'
                ? parsed.name
                : undefined,
          provides,
        };
      } catch (error) {
        throw new Error(
          `[PLUGIN_MANIFEST_INVALID] ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return {};
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
  managedRoot?: string,
  scope?: ScopeContext
): SkillPluginAuthorization[] {
  return readSkillPluginsConfig(cwd, scope).map((configuredPath) =>
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
  managedRoot?: string,
  scope?: ScopeContext,
  options: { trustResolved?: boolean } = { trustResolved: false }
): Promise<SkillPluginLoadResult> {
  // PI-03: `.kyberion-plugins.json` is itself a trust-sensitive project
  // resource. A pre-trust caller may observe that the resource exists for
  // diagnostics, but must not parse selectors or import any configured code.
  const configPath = path.join(cwd, SKILL_PLUGINS_CONFIG_FILENAME);
  if (options.trustResolved !== true && safeExistsSync(configPath)) {
    return {
      loaded: [],
      diagnostics: [
        {
          configuredPath: configPath,
          resolvedPath: configPath,
          trust: 'third-party',
          allowed: false,
          reason: 'project trust is unresolved; plugin configuration was not consumed',
        },
      ],
    };
  }
  const authorizations = authorizeConfiguredSkillPlugins(cwd, managedRoot, scope);
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
        /* webpackIgnore: true */
        pathToFileURL(authorization.resolvedPath).href
      )) as SkillPluginHookModule;
      let contributions: PluginContributionActivation | undefined;
      if (typeof mod.registerKyberionContributions === 'function') {
        const manifest = readPluginManifestProvides(authorization.resolvedPath);
        if (!manifest.provides) {
          throw new Error(
            '[PLUGIN_CONTRIBUTION_DENIED] registerKyberionContributions requires manifest provides declaration'
          );
        }
        contributions = await activatePluginContributions(
          manifest.provides,
          {
            pluginId:
              authorization.managedPluginId ||
              manifest.pluginId ||
              path.basename(authorization.resolvedPath),
            sourcePath: authorization.resolvedPath,
            trust: authorization.trust === 'official' ? 'official' : 'third-party',
          },
          mod
        );
      }
      loaded.push({
        configuredPath: authorization.configuredPath,
        resolvedPath: authorization.resolvedPath,
        module: mod,
        ...(contributions ? { contributions } : {}),
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

/** Dispose dynamic contributions after a skill so one invocation cannot widen the next. */
export function disposeSkillPluginContributions(plugins: LoadedSkillPlugin[]): void {
  for (const plugin of [...plugins].reverse()) {
    try {
      plugin.contributions?.dispose();
    } catch (err) {
      logger.warn(
        `[skill-plugin-loader] Failed to dispose contributions for '${plugin.configuredPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
