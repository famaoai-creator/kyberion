/**
 * Saved seam defaults — "when nobody says otherwise, use provider X for this
 * seam", set by a human and layered by scope.
 *
 * Layers, most specific first (the first layer that names the seam wins):
 *   1. env          — `KYBERION_SEAM_DEFAULTS="seam=provider;seam2=provider"`
 *                     (process-level override for direct runs and CI);
 *   2. project      — scope partition file, `projects[<project_id>]`;
 *   3. organization — scope partition file, `organizations[<organization_id>]`;
 *   4. tenant       — scope partition file, `defaults`;
 *   5. operator     — `active/shared/runtime/seam-selection/defaults.json`.
 *
 * The scope partition file lives at
 * `active/shared/runtime/seam-selection-defaults/<tier>/<tenant|shared>/defaults.json`
 * (`confidential/<tenant>` for a tenant, `public/shared` without one), so a
 * tenant's choices never sit in a shared file and tier-guard applies the
 * tenant's read/write permissions.
 *
 * A saved default is a *soft* default. It applies only when the caller gave
 * no explicit provider and no purpose; mission pins and operator rules
 * (seam-selection-rules.ts) still take precedence, and the seam's hard
 * eligibility filter always decides whether it can run. An unreadable layer
 * (missing permission, invalid file) is skipped with a one-time warning —
 * selection must not break because one overlay is unavailable.
 *
 * `seam-provider-selection.ts` reads this module, so every seam that selects
 * through the shared path honours saved defaults without its own store.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { auditChain } from './governance/audit-chain.js';
import { logger } from './core.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { withLockSync } from './foundation/lock-utils.js';
import { isValidTenantSlug } from './foundation/scope.js';
import { nowIso } from './foundation/time.js';
import type { ScopeContext } from './foundation/scope-context-validation.js';
import {
  PARTITIONED_RUNTIME_STATE_ROOTS,
  RUNTIME_STATE_PATHS,
} from './foundation/runtime-state-roots.js';
import { writeJson } from './foundation/json.js';
import { readConfiguredActorIdentity } from './identity-context-bridge.js';
import { pathResolver } from './path-resolver.js';
import { currentScope } from './scope-context.js';
import { storagePartitionSegments } from './storage-layout.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeMkdir } from './secure-io.js';

export type SeamDefaultLayer = 'env' | 'project' | 'organization' | 'tenant' | 'operator';

/** Writable layers (env is set by the process, never saved). */
export type SeamDefaultSavedLayer = Exclude<SeamDefaultLayer, 'env'>;

export const SEAM_DEFAULT_LAYERS: readonly SeamDefaultLayer[] = [
  'env',
  'project',
  'organization',
  'tenant',
  'operator',
] as const;

export interface SeamDefaultEntry {
  provider: string;
  note?: string;
  set_by: string;
  set_at: string;
}

export interface SeamDefaultsFile {
  version: '1.0.0';
  defaults?: Record<string, SeamDefaultEntry>;
  organizations?: Record<string, Record<string, SeamDefaultEntry>>;
  projects?: Record<string, Record<string, SeamDefaultEntry>>;
  updated_at?: string;
}

export interface SavedSeamDefault {
  seam: string;
  provider: string;
  layer: SeamDefaultLayer;
  /** Repo-relative file (or `env:KYBERION_SEAM_DEFAULTS`) the value came from. */
  source: string;
  set_by?: string;
  set_at?: string;
  note?: string;
}

/** Scope facts that select the tenant / organization / project layers. */
export type SeamDefaultScope = Pick<ScopeContext, 'tenant_slug' | 'organization_id' | 'project_id'>;

export interface SeamDefaultTarget {
  layer: SeamDefaultSavedLayer;
  /** Tenant partition for tenant/organization/project layers (omit = untenanted). */
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
}

const SCHEMA_PATH = pathResolver.knowledge('product/schemas/seam-selection-defaults.schema.json');
const ENV_NAME = 'KYBERION_SEAM_DEFAULTS';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SCOPED_ROOT = PARTITIONED_RUNTIME_STATE_ROOTS.seam_selection_defaults;
const OPERATOR_RELATIVE = RUNTIME_STATE_PATHS['seamSelection.operatorDefaults'];

const catalogs = new Map<string, ReturnType<typeof defineCatalog<SeamDefaultsFile>>>();
function catalogAt(filePath: string) {
  let catalog = catalogs.get(filePath);
  if (!catalog) {
    catalog = defineCatalog<SeamDefaultsFile>({
      id: 'seam-selection-defaults',
      path: filePath,
      schema: SCHEMA_PATH,
    });
    catalogs.set(filePath, catalog);
  }
  return catalog;
}

/** Operator layer file. */
export function seamDefaultsOperatorPath(): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(OPERATOR_RELATIVE), {
    allowMissingLeaf: true,
  });
}

/** Scope partition file holding the tenant, organization and project layers. */
export function seamDefaultsScopePath(tenantSlug?: string): string {
  const tenant = tenantSlug?.trim().toLowerCase() || undefined;
  if (tenant && !isValidTenantSlug(tenant)) {
    throw new Error(`[SEAM_DEFAULT_INVALID] invalid tenant slug '${tenantSlug}'`);
  }
  const partition = tenant
    ? storagePartitionSegments({ kind: 'tier', tier: 'confidential', tenant })
    : storagePartitionSegments({ kind: 'tier', tier: 'public' });
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(path.posix.join(SCOPED_ROOT, ...partition, 'defaults.json')),
    { allowMissingLeaf: true }
  );
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

/** Test hook: forget one-time warnings. */
export function resetSeamDefaultWarnings(): void {
  warned.clear();
}

function emptyFile(): SeamDefaultsFile {
  return { version: '1.0.0' };
}

/** Load one layer file; missing → empty; unreadable/invalid → empty + one warning. */
function loadFile(filePath: string, strict = false): SeamDefaultsFile {
  try {
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return emptyFile();
    return catalogAt(filePath).load();
  } catch (error: unknown) {
    if (strict) throw error;
    warnOnce(
      `load:${filePath}`,
      `[seam-selection-defaults] skipping saved seam defaults — the layer file could not be read | ` +
        `next: check permissions/validity of ${pathResolver.toRepoRelative(filePath)} | ` +
        `evidence: ${error instanceof Error ? error.message : String(error)}`
    );
    return emptyFile();
  }
}

/** Parse `seam=provider;seam2=provider` (`,` also separates). Invalid pairs are warned and dropped. */
export function parseSeamDefaultsEnv(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (raw ?? '').split(/[;,]/u)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const seam = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    const provider = eq > 0 ? trimmed.slice(eq + 1).trim() : '';
    if (!SEAM_PATTERN.test(seam) || !provider) {
      warnOnce(
        `env:${trimmed}`,
        `[seam-selection-defaults] ignoring malformed ${ENV_NAME} entry '${trimmed}' | next: use seam=provider;seam2=provider`
      );
      continue;
    }
    result[seam] = provider;
  }
  return result;
}

function resolveScope(scope?: SeamDefaultScope): SeamDefaultScope {
  if (scope) return scope;
  try {
    const current = currentScope();
    return {
      ...(current.tenant_slug ? { tenant_slug: current.tenant_slug } : {}),
      ...(current.organization_id ? { organization_id: current.organization_id } : {}),
      ...(current.project_id ? { project_id: current.project_id } : {}),
    };
  } catch (error: unknown) {
    warnOnce(
      'scope',
      `[seam-selection-defaults] scope could not be resolved; only env/operator defaults apply | ` +
        `next: check KYBERION_TENANT / scope env | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
}

function fromEntry(
  seam: string,
  layer: SeamDefaultLayer,
  filePath: string,
  entry: SeamDefaultEntry | undefined
): SavedSeamDefault | null {
  if (!entry?.provider?.trim()) return null;
  return {
    seam,
    provider: entry.provider.trim(),
    layer,
    source: pathResolver.toRepoRelative(filePath),
    set_by: entry.set_by,
    set_at: entry.set_at,
    ...(entry.note ? { note: entry.note } : {}),
  };
}

/**
 * Every layer's saved default for a seam, most specific first (the first
 * element is the effective one). Layers without a value are omitted.
 */
export function listSavedSeamDefaultLayers(
  seam: string,
  scope?: SeamDefaultScope
): SavedSeamDefault[] {
  const found: SavedSeamDefault[] = [];
  const envProvider = parseSeamDefaultsEnv(getRegisteredEnvText(ENV_NAME))[seam];
  if (envProvider) {
    found.push({ seam, provider: envProvider, layer: 'env', source: `env:${ENV_NAME}` });
  }
  const resolved = resolveScope(scope);
  let scopePath: string | undefined;
  try {
    scopePath = seamDefaultsScopePath(resolved.tenant_slug);
  } catch (error: unknown) {
    warnOnce(
      `scope-path:${resolved.tenant_slug}`,
      `[seam-selection-defaults] skipping scoped defaults | next: fix the tenant slug | evidence: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (scopePath) {
    const file = loadFile(scopePath);
    const project = resolved.project_id
      ? fromEntry(seam, 'project', scopePath, file.projects?.[resolved.project_id]?.[seam])
      : null;
    const organization = resolved.organization_id
      ? fromEntry(
          seam,
          'organization',
          scopePath,
          file.organizations?.[resolved.organization_id]?.[seam]
        )
      : null;
    // The untenanted partition's `defaults` is not a tenant layer.
    const tenant = resolved.tenant_slug
      ? fromEntry(seam, 'tenant', scopePath, file.defaults?.[seam])
      : null;
    for (const layer of [project, organization, tenant]) if (layer) found.push(layer);
  }
  const operatorPath = seamDefaultsOperatorPath();
  const operator = fromEntry(
    seam,
    'operator',
    operatorPath,
    loadFile(operatorPath).defaults?.[seam]
  );
  if (operator) found.push(operator);
  return found;
}

/** The effective saved default for a seam in this scope, or null. */
export function resolveSavedSeamDefault(
  seam: string,
  scope?: SeamDefaultScope
): SavedSeamDefault | null {
  return listSavedSeamDefaultLayers(seam, scope)[0] ?? null;
}

function actor(): string {
  const { persona, role } = readConfiguredActorIdentity();
  return persona || role || 'operator';
}

function targetPath(target: SeamDefaultTarget): string {
  if (target.layer === 'operator') return seamDefaultsOperatorPath();
  if (target.layer === 'tenant' && !target.tenant_slug?.trim()) {
    throw new Error('[SEAM_DEFAULT_INVALID] the tenant layer needs a tenant slug');
  }
  return seamDefaultsScopePath(target.tenant_slug);
}

function targetMap(
  file: SeamDefaultsFile,
  target: SeamDefaultTarget
): { get(): Record<string, SeamDefaultEntry>; set(next: Record<string, SeamDefaultEntry>): void } {
  if (target.layer === 'operator' || target.layer === 'tenant') {
    return {
      get: () => ({ ...(file.defaults ?? {}) }),
      set: (next) => {
        file.defaults = next;
      },
    };
  }
  const key = target.layer === 'organization' ? 'organizations' : 'projects';
  const id = (target.layer === 'organization' ? target.organization_id : target.project_id)?.trim();
  if (!id || !ID_PATTERN.test(id)) {
    throw new Error(
      `[SEAM_DEFAULT_INVALID] the ${target.layer} layer needs a valid ${target.layer} id`
    );
  }
  return {
    get: () => ({ ...(file[key]?.[id] ?? {}) }),
    set: (next) => {
      const all = { ...(file[key] ?? {}) };
      if (Object.keys(next).length) all[id] = next;
      else delete all[id];
      file[key] = all;
    },
  };
}

function updateLayer(
  target: SeamDefaultTarget,
  mutate: (seams: Record<string, SeamDefaultEntry>) => Record<string, SeamDefaultEntry> | null
): { path: string; changed: boolean } {
  const filePath = targetPath(target);
  const lockId = `seam-selection-defaults-${createHash('sha256').update(filePath, 'utf8').digest('hex')}`;
  return withLockSync(lockId, () => {
    const file = loadFile(filePath, true);
    const map = targetMap(file, target);
    const next = mutate(map.get());
    if (!next) return { path: filePath, changed: false };
    map.set(next);
    const out: SeamDefaultsFile = { ...file, version: '1.0.0', updated_at: nowIso() };
    catalogAt(filePath).validate(out, filePath);
    const dir = path.dirname(filePath);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    writeJson(filePath, out);
    return { path: filePath, changed: true };
  });
}

function recordChange(operation: string, detail: Record<string, unknown>): void {
  auditChain.record({
    agentId: actor(),
    action: 'seam_selection_default_change',
    operation,
    result: 'completed',
    metadata: detail,
  });
}

function describeTarget(target: SeamDefaultTarget): Record<string, string> {
  return {
    layer: target.layer,
    ...(target.tenant_slug ? { tenant_slug: target.tenant_slug } : {}),
    ...(target.organization_id ? { organization_id: target.organization_id } : {}),
    ...(target.project_id ? { project_id: target.project_id } : {}),
  };
}

/** Save a default. Callers validate the provider id against the seam first. */
export function setSeamDefault(
  input: SeamDefaultTarget & { seam: string; provider: string; note?: string; set_by?: string }
): { entry: SeamDefaultEntry; path: string } {
  if (!SEAM_PATTERN.test(input.seam)) {
    throw new Error(`[SEAM_DEFAULT_INVALID] invalid seam id '${input.seam}'`);
  }
  const provider = input.provider.trim();
  if (!provider) throw new Error('[SEAM_DEFAULT_INVALID] provider must be non-empty');
  const entry: SeamDefaultEntry = {
    provider,
    ...(input.note ? { note: input.note } : {}),
    set_by: input.set_by || actor(),
    set_at: nowIso(),
  };
  const result = updateLayer(input, (seams) => ({ ...seams, [input.seam]: entry }));
  recordChange(`set:${input.seam}`, { seam: input.seam, ...describeTarget(input), entry });
  return { entry, path: result.path };
}

/** Remove a saved default; false when the layer had none for the seam. */
export function unsetSeamDefault(input: SeamDefaultTarget & { seam: string }): boolean {
  const result = updateLayer(input, (seams) => {
    if (!seams[input.seam]) return null;
    const next = { ...seams };
    delete next[input.seam];
    return next;
  });
  if (result.changed)
    recordChange(`unset:${input.seam}`, { seam: input.seam, ...describeTarget(input) });
  return result.changed;
}

/** Raw contents of one saved layer (for listing). */
export function readSeamDefaultLayer(target: SeamDefaultTarget): Record<string, SeamDefaultEntry> {
  return targetMap(loadFile(targetPath(target), true), target).get();
}
