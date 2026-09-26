/**
 * EP-04: ownership-tracked plugin lifecycle for long-running hosts.
 *
 * `activatePlugin` / `deactivatePlugin` / `reloadPlugin` manage one live
 * activation per plugin id on top of the DH-08 contribution API (which
 * records ownership of every registration and wraps executable
 * contributions with the EP-03 grant). The per-invocation skill path
 * (`skill-wrapper` -> `loadAuthorizedSkillPlugins`) does not use this module.
 *
 * `applyPluginChange` classifies a change onto the least disruptive rung:
 *   config_apply     permissions narrowed in place, or a views-only change
 *   plugin_reload    ops / hooks / prompt_sections / facets / code changed,
 *                    or permissions widened / newly wrapped
 *   restart_required seams or providers changed (consumers may hold references)
 *
 * Reload re-imports the entry with a `?digest=<contentDigest>` query to
 * bypass the ESM module cache. Node never evicts the previous module
 * instance: every reload of a changed plugin retains the old module (and
 * whatever its top-level scope references) in memory until process exit.
 * Hosts that reload often should restart periodically.
 *
 * Only already-authorized plugins are activated: a managed record must be
 * `activatable` and its content digest is re-verified immediately before
 * import; non-managed paths must be `official` by provenance.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeExistsSync, safeLstat } from './secure-io.js';
import { isRecord } from './foundation/text.js';
import { derivePluginTrustLabel, isPathContainedIn } from './plugin-source-trust.js';
import {
  computePluginContentDigest,
  isManagedPluginActivationAllowed,
  listManagedPlugins,
  type ManagedPluginRecord,
} from './plugin-managed-install.js';
import type { PluginPermissionGrant } from './plugin-permissions.js';
import { loadApprovalRequest } from './approval-store.js';
import {
  activatePluginContributions,
  disposeOwnedContribution,
  listOwnedContributions,
  ownerOfContribution,
  type PluginContributionActivation,
  type PluginContributionCategory,
  type PluginContributionDeclaration,
  type PluginContributionModule,
  type PluginContributionProvenance,
} from './plugin-contributions.js';
import {
  findPluginManifestFor,
  isPluginGrantWithin,
  resolveManagedRecordExecutionGrant,
  resolvePluginExecutionGrant,
  runWithPluginGrant,
} from './plugin-grant-runtime.js';
import {
  normalizePluginContributionDeclaration,
  type SkillPluginAuthorization,
} from './skill-plugin-loader.js';

export type PluginApplyMode = 'config_apply' | 'plugin_reload' | 'restart_required';

export interface PluginApplyResult {
  mode: PluginApplyMode;
  reason: string;
  rolledBack?: boolean;
}

export interface PluginLifecycleResult extends PluginApplyResult {
  pluginId: string;
  ok: boolean;
  contentDigest?: string;
}

export interface PluginChangeSnapshot {
  contentDigest?: string;
  provides: PluginContributionDeclaration & { views?: string[] };
  /** null = legacy official plugin (unwrapped). */
  grant: PluginPermissionGrant | null;
}

export interface PluginChange {
  pluginId?: string;
  before: PluginChangeSnapshot;
  after: PluginChangeSnapshot;
  /**
   * Plugin-relative paths that changed, when the caller knows them. A content
   * change confined to `views/` counts as views-only; without this list any
   * content change is treated as a code change.
   */
  changedPaths?: string[];
}

export type ActivatePluginInput =
  { record: ManagedPluginRecord; entry?: string } | { authorization: SkillPluginAuthorization };

export interface PluginLifecycleOptions {
  /** Managed-plugins root override (tests). */
  managedRoot?: string;
}

// ---------------------------------------------------------------------------
// Ownership (recorded by activatePluginContributions)
// ---------------------------------------------------------------------------

export function ownerOf(category: PluginContributionCategory, name: string): string | undefined {
  return ownerOfContribution(category, name);
}

export function listOwned(
  pluginId: string
): Array<{ category: PluginContributionCategory; name: string }> {
  return listOwnedContributions(pluginId);
}

/** Refuses (`[PLUGIN_OWNERSHIP_DENIED]`) when `requesterPluginId` does not own it. */
export function disposeContribution(
  requesterPluginId: string,
  category: PluginContributionCategory,
  name: string
): void {
  disposeOwnedContribution(requesterPluginId, category, name);
}

// ---------------------------------------------------------------------------
// Change classification
// ---------------------------------------------------------------------------

const MODE_RANK: Record<PluginApplyMode, number> = {
  config_apply: 0,
  plugin_reload: 1,
  restart_required: 2,
};

function sameSet(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = [...new Set(left ?? [])].sort();
  const b = [...new Set(right ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function grantsEqual(left: PluginPermissionGrant | null, right: PluginPermissionGrant | null) {
  if (left === null || right === null) return left === right;
  return isPluginGrantWithin(left, right) && isPluginGrantWithin(right, left);
}

/** Pure ladder classification of a plugin change (never executes anything). */
export function applyPluginChange(change: PluginChange): PluginApplyResult {
  const { before, after } = change;
  const reasons: Array<{ mode: PluginApplyMode; reason: string }> = [];
  const add = (mode: PluginApplyMode, reason: string) => reasons.push({ mode, reason });

  for (const category of ['seams', 'providers'] as const) {
    if (!sameSet(before.provides[category], after.provides[category])) {
      add('restart_required', `${category} changed`);
    }
  }
  for (const category of ['ops', 'hooks', 'prompt_sections', 'facets'] as const) {
    if (!sameSet(before.provides[category], after.provides[category])) {
      add('plugin_reload', `${category} changed`);
    }
  }
  if (!sameSet(before.provides.views, after.provides.views)) {
    add('config_apply', 'views changed (declarative)');
  }

  if (before.contentDigest !== after.contentDigest) {
    const viewsOnly =
      change.changedPaths !== undefined &&
      change.changedPaths.length > 0 &&
      change.changedPaths.every((entry) => entry.replaceAll('\\', '/').startsWith('views/'));
    const hasSeamsOrProviders = [before, after].some(
      (snapshot) =>
        (snapshot.provides.seams ?? []).length > 0 || (snapshot.provides.providers ?? []).length > 0
    );
    if (viewsOnly) add('config_apply', 'view documents changed');
    else if (hasSeamsOrProviders) add('restart_required', 'code of a seam/provider plugin changed');
    else add('plugin_reload', 'plugin code changed');
  }

  if (!grantsEqual(before.grant, after.grant)) {
    if (before.grant === null) add('plugin_reload', 'grant newly applied to a legacy plugin');
    else if (isPluginGrantWithin(after.grant, before.grant)) {
      add('config_apply', 'permissions narrowed');
    } else add('plugin_reload', 'permissions widened');
  }

  if (reasons.length === 0) return { mode: 'config_apply', reason: 'no change' };
  const mode = reasons.reduce<PluginApplyMode>(
    (worst, entry) => (MODE_RANK[entry.mode] > MODE_RANK[worst] ? entry.mode : worst),
    'config_apply'
  );
  return {
    mode,
    reason: reasons
      .filter((entry) => entry.mode === mode)
      .map((entry) => entry.reason)
      .join('; '),
  };
}

// ---------------------------------------------------------------------------
// Activation targets
// ---------------------------------------------------------------------------

interface ActivationTarget {
  pluginId: string;
  trust: 'official' | 'third-party';
  entryPath: string;
  contentDigest?: string;
  declaration: PluginContributionDeclaration & { views?: string[] };
  /** Passed as provenance.grant (null = legacy official). */
  grant: PluginPermissionGrant | null;
  source: ActivatePluginInput;
}

interface ActivePluginState extends ActivationTarget {
  module: PluginContributionModule;
  activation: PluginContributionActivation;
  managedRoot?: string;
}

const activePlugins = new Map<string, ActivePluginState>();

function denied(message: string): Error {
  return new Error(`[PLUGIN_LIFECYCLE_DENIED] ${message}`);
}

function viewNames(provides: unknown): string[] {
  if (!isRecord(provides) || !Array.isArray(provides.views)) return [];
  return provides.views
    .map((view) =>
      typeof view === 'string'
        ? view
        : isRecord(view) && typeof view.id === 'string'
          ? view.id
          : isRecord(view) && typeof view.name === 'string'
            ? view.name
            : ''
    )
    .filter((name) => name.length > 0);
}

function declarationFrom(raw: Record<string, unknown> | undefined) {
  return {
    ...(normalizePluginContributionDeclaration(raw?.provides) ?? {}),
    views: viewNames(raw?.provides),
  };
}

function resolveManagedEntry(record: ManagedPluginRecord, entry?: string): string {
  const raw = record.manifest?.raw ?? {};
  const candidates = entry
    ? [entry]
    : typeof raw.main === 'string'
      ? [raw.main]
      : ['index.mjs', 'index.js'];
  for (const candidate of candidates) {
    const resolved = path.resolve(record.managedPath, candidate);
    if (!isPathContainedIn(record.managedPath, resolved) || resolved === record.managedPath) {
      throw denied(`entry '${candidate}' escapes the managed copy of '${record.pluginId}'`);
    }
    if (safeExistsSync(resolved) && safeLstat(resolved).isFile()) return resolved;
  }
  throw denied(`no entry module found for '${record.pluginId}' (${candidates.join(', ')})`);
}

function targetFromRecord(
  record: ManagedPluginRecord,
  source: ActivatePluginInput,
  entry?: string
): ActivationTarget {
  if (!isManagedPluginActivationAllowed(record)) {
    throw denied(`'${record.pluginId}' is not activatable (status=${record.activationStatus})`);
  }
  if (!record.manifest) throw denied(`'${record.pluginId}' has no readable manifest`);
  if (!record.contentDigest && record.trust !== 'official') {
    throw denied(`'${record.pluginId}' has no approved content digest`);
  }
  const contentDigest = computePluginContentDigest(record.managedPath);
  if (record.contentDigest && contentDigest !== record.contentDigest) {
    throw denied(`'${record.pluginId}' content digest changed since approval`);
  }
  const raw = record.manifest.raw;
  const trust = record.trust === 'official' ? 'official' : 'third-party';
  const { grant } = resolveManagedRecordExecutionGrant(record);
  return {
    pluginId: record.pluginId,
    trust,
    entryPath: resolveManagedEntry(record, entry),
    contentDigest,
    declaration: declarationFrom(raw),
    grant,
    source,
  };
}

function resolveTarget(
  input: ActivatePluginInput,
  options: PluginLifecycleOptions
): ActivationTarget {
  if ('record' in input) {
    // Always re-read the record: activation status and digests are verified on read.
    const fresh = listManagedPlugins(options.managedRoot).find(
      (record) => record.pluginId === input.record.pluginId
    );
    if (!fresh) throw denied(`managed plugin '${input.record.pluginId}' is not installed`);
    return targetFromRecord(fresh, input, input.entry);
  }
  const authorization = input.authorization;
  if (!authorization.allowed) throw denied(`'${authorization.configuredPath}' is not authorized`);
  if (authorization.managedPluginId) {
    const record = listManagedPlugins(options.managedRoot).find(
      (candidate) => candidate.pluginId === authorization.managedPluginId
    );
    if (!record) throw denied(`managed plugin '${authorization.managedPluginId}' is not installed`);
    return targetFromRecord(
      record,
      input,
      path.relative(record.managedPath, authorization.resolvedPath)
    );
  }
  // Non-managed paths are only ever official by provenance (re-derived here).
  if (derivePluginTrustLabel(authorization.resolvedPath).label !== 'official') {
    throw denied(`'${authorization.configuredPath}' is neither managed nor official`);
  }
  const manifest = findPluginManifestFor(authorization.resolvedPath);
  const pluginId =
    (typeof manifest?.raw.plugin_id === 'string' && manifest.raw.plugin_id) ||
    (typeof manifest?.raw.name === 'string' && manifest.raw.name) ||
    path.basename(authorization.resolvedPath);
  const resolved = resolvePluginExecutionGrant({
    pluginId,
    sourcePath: authorization.resolvedPath,
    trust: 'official',
  });
  return {
    pluginId,
    trust: 'official',
    entryPath: authorization.resolvedPath,
    contentDigest: manifest ? computePluginContentDigest(path.dirname(manifest.path)) : undefined,
    declaration: declarationFrom(manifest?.raw),
    grant: resolved.grant,
    source: input,
  };
}

async function importTarget(target: ActivationTarget): Promise<PluginContributionModule> {
  const url = pathToFileURL(target.entryPath);
  if (target.contentDigest) url.searchParams.set('digest', target.contentDigest);
  const load = () =>
    import(/* webpackIgnore: true */ url.href) as Promise<PluginContributionModule>;
  // Best effort: top-level module code usually inherits this async context.
  return target.grant === null ? load() : runWithPluginGrant(target.grant, target.pluginId, load);
}

function provenanceOf(target: ActivationTarget): PluginContributionProvenance {
  return {
    pluginId: target.pluginId,
    sourcePath: target.entryPath,
    trust: target.trust,
    grant: target.grant,
  };
}

async function activateTarget(
  target: ActivationTarget,
  module: PluginContributionModule,
  options: PluginLifecycleOptions
): Promise<ActivePluginState> {
  const activation = await activatePluginContributions(
    target.declaration,
    provenanceOf(target),
    module,
    options
  );
  return { ...target, module, activation, managedRoot: options.managedRoot };
}

/**
 * Grant for re-activating the previous module after a failed reload: the
 * narrower of the previous and the new grant (null = unwrapped legacy).
 * Undefined when neither contains the other (no representable intersection).
 */
function rollbackGrant(
  previous: PluginPermissionGrant | null,
  next: PluginPermissionGrant | null
): { grant: PluginPermissionGrant | null } | undefined {
  if (isPluginGrantWithin(next, previous)) return { grant: next };
  if (isPluginGrantWithin(previous, next)) return { grant: previous };
  return undefined;
}

function snapshotOf(target: ActivationTarget, grant: PluginPermissionGrant | null) {
  return { contentDigest: target.contentDigest, provides: target.declaration, grant };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Lifecycle operations
// ---------------------------------------------------------------------------

export function isPluginActive(pluginId: string): boolean {
  return activePlugins.has(pluginId);
}

/** Content digest of the module currently activated for `pluginId` (undefined when inactive or legacy). */
export function getActivePluginContentDigest(pluginId: string): string | undefined {
  return activePlugins.get(pluginId)?.contentDigest;
}

export function listActivePlugins(): string[] {
  return [...activePlugins.keys()].sort();
}

export async function activatePlugin(
  input: ActivatePluginInput,
  options: PluginLifecycleOptions = {}
): Promise<PluginLifecycleResult> {
  const target = resolveTarget(input, options);
  if (activePlugins.has(target.pluginId)) {
    return {
      pluginId: target.pluginId,
      ok: false,
      mode: 'plugin_reload',
      reason: `plugin '${target.pluginId}' is already active; use reloadPlugin`,
    };
  }
  const module = await importTarget(target);
  const state = await activateTarget(target, module, options);
  activePlugins.set(target.pluginId, state);
  return {
    pluginId: target.pluginId,
    ok: true,
    mode: 'plugin_reload',
    reason: 'activated',
    ...(target.contentDigest ? { contentDigest: target.contentDigest } : {}),
  };
}

export function deactivatePlugin(pluginId: string): PluginLifecycleResult {
  const state = activePlugins.get(pluginId);
  if (!state) {
    return {
      pluginId,
      ok: true,
      mode: 'config_apply',
      reason: `plugin '${pluginId}' is not active in this process; nothing to dispose`,
    };
  }
  activePlugins.delete(pluginId);
  state.activation.dispose();
  const heldByConsumers =
    (state.activation.registered.seams ?? []).length > 0 ||
    (state.activation.registered.providers ?? []).length > 0;
  return {
    pluginId,
    ok: true,
    mode: heldByConsumers ? 'restart_required' : 'plugin_reload',
    reason: heldByConsumers
      ? 'deactivated; seam/provider consumers may still hold references until restart'
      : 'deactivated',
  };
}

/**
 * Why a managed plugin that failed to re-resolve must not keep running: it
 * was removed, its content no longer matches the approval, its approval was
 * rejected / expired / cancelled, or a new version awaits approval. The
 * install replaces the managed copy in place, so the previous module could
 * lazily load the unapproved files — fail closed. Only non-managed
 * resolution failures return undefined.
 */
function revocationReason(
  source: ActivatePluginInput,
  options: PluginLifecycleOptions
): string | undefined {
  const managedId =
    'record' in source ? source.record.pluginId : source.authorization.managedPluginId;
  if (!managedId) return undefined;
  try {
    const record = listManagedPlugins(options.managedRoot).find(
      (candidate) => candidate.pluginId === managedId
    );
    if (!record) return 'managed install was removed';
    if (record.activationStatus === 'pending_approval') {
      const approval =
        record.approvalChannel && record.approvalRequestId
          ? loadApprovalRequest(record.approvalChannel, record.approvalRequestId)
          : null;
      return approval?.status === 'pending'
        ? 'new version awaits approval; its files replaced the approved copy'
        : `approval ${approval?.status ?? 'missing'}`;
    }
    if (record.activationStatus !== 'activatable') return `status=${record.activationStatus}`;
    if (
      record.contentDigest &&
      computePluginContentDigest(record.managedPath) !== record.contentDigest
    ) {
      return 'content digest changed since approval';
    }
    return undefined;
  } catch (error) {
    return `activation state could not be verified (${errorText(error)})`;
  }
}

/**
 * Re-resolves the plugin from its original source, classifies the change and
 * applies the least disruptive rung. A failing new module rolls back to the
 * previous module under the narrower of the old and new grant; if that is
 * not representable or also fails, the plugin stays inactive and the result
 * is `restart_required`. A managed plugin that is no longer activatable
 * (removed, tampered, approval rejected, or a new version awaiting approval)
 * is deactivated. A plugin not active in this process is activated.
 */
export async function reloadPlugin(
  pluginId: string,
  options: PluginLifecycleOptions & { source?: ActivatePluginInput } = {}
): Promise<PluginLifecycleResult> {
  const state = activePlugins.get(pluginId);
  const effectiveOptions: PluginLifecycleOptions = {
    managedRoot: options.managedRoot ?? state?.managedRoot,
  };
  const source = options.source ??
    state?.source ?? {
      record: { pluginId } as ManagedPluginRecord,
    };
  if (!state) {
    const activated = await activatePlugin(source, effectiveOptions);
    return activated.ok
      ? { ...activated, reason: 'was not active in this process; activated' }
      : activated;
  }

  let target: ActivationTarget;
  try {
    target = resolveTarget(source, effectiveOptions);
  } catch (error) {
    const revoked = revocationReason(source, effectiveOptions);
    if (revoked) {
      const deactivated = deactivatePlugin(pluginId);
      return {
        ...deactivated,
        ok: false,
        rolledBack: false,
        reason: `plugin is no longer activatable (${revoked}); previous activation deactivated (${deactivated.reason})`,
      };
    }
    return {
      pluginId,
      ok: false,
      mode: 'plugin_reload',
      rolledBack: false,
      reason: `new version is not activatable (${errorText(error)}); previous activation kept`,
    };
  }

  const decision = applyPluginChange({
    pluginId,
    before: snapshotOf(state, state.activation.grant.grant),
    after: snapshotOf(target, target.grant),
  });
  const base = {
    pluginId,
    ...(target.contentDigest ? { contentDigest: target.contentDigest } : {}),
  };

  if (decision.mode === 'restart_required') {
    return { ...base, ok: false, ...decision };
  }
  if (decision.mode === 'config_apply') {
    if (target.grant !== null) state.activation.grant.narrow(target.grant);
    activePlugins.set(pluginId, {
      ...state,
      contentDigest: target.contentDigest,
      declaration: target.declaration,
      grant: target.grant,
      source: target.source,
    });
    return { ...base, ok: true, ...decision };
  }

  activePlugins.delete(pluginId);
  state.activation.dispose();
  try {
    const module = await importTarget(target);
    activePlugins.set(pluginId, await activateTarget(target, module, effectiveOptions));
    return { ...base, ok: true, ...decision };
  } catch (error) {
    const failure = errorText(error);
    // The previous module never regains a grant wider than the new approval.
    const rollback = rollbackGrant(state.activation.grant.grant, target.grant);
    if (!rollback) {
      return {
        ...base,
        ok: false,
        mode: 'restart_required',
        rolledBack: false,
        reason: `reload failed (${failure}); the previous grant is not within the new grant, so the previous module was not re-activated; plugin is inactive until restart`,
      };
    }
    try {
      activePlugins.set(
        pluginId,
        await activateTarget({ ...state, grant: rollback.grant }, state.module, effectiveOptions)
      );
      return {
        ...base,
        ok: false,
        mode: 'plugin_reload',
        rolledBack: true,
        reason: `reload failed (${failure}); previous module re-activated`,
      };
    } catch (rollbackError) {
      return {
        ...base,
        ok: false,
        mode: 'restart_required',
        rolledBack: false,
        reason: `reload failed (${failure}) and rollback failed (${errorText(rollbackError)}); plugin is inactive until restart`,
      };
    }
  }
}

/** Test/worker teardown: dispose every live activation. */
export function resetPluginLifecycleForTests(): void {
  for (const pluginId of listActivePlugins()) deactivatePlugin(pluginId);
}
