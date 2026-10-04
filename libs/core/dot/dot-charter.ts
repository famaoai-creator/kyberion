/**
 * Dot charter — loader and validation for resident-agent ('dot') charters.
 *
 * A dot is a resident agent that holds a standing responsibility across
 * sessions: it wakes on declared triggers, works toward a durable goal via the
 * worker-goal-driver, delegates substantive work as WorkItems, and reaches the
 * accountable human through the notification surface. The charter is the
 * declarative contract — it never grants authority, it references an existing
 * authority role from security-policy.json.
 *
 * Layout mirrors the pipeline convention: repo-level charters live in `dots/`,
 * tenant-scoped charters in `knowledge/confidential/{tenant}/dots/` (scanned
 * and executed by the tenant-bound runner, same as scheduled pipelines).
 */

import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeReadFile,
} from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { listTenantProfileSlugs, resolveTenant } from '../organization/tenant-registry.js';
import { createLogger } from '../logger.js';
import type { KeyResultSpec, ObjectiveRef } from '../key-result-spec.js';
import { compileSchema } from '../foundation/ajv.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import type { ValidateFunction } from 'ajv';

export const DOT_CHARTER_SCHEMA_PATH = 'knowledge/product/schemas/dot-charter.schema.json';
export const DOT_CHARTER_DIR = 'dots';
/** Same tenant-bound runner role chronos uses to scan tenant pipelines. */
const DOT_TENANT_SCAN_ROLE = 'chronos_tenant_runner';

const logger = createLogger('dot-charter');

export type DotCharterStatus = 'draft' | 'active' | 'paused' | 'retired';
export type DotTrigger =
  | { kind: 'cron'; cron: string; timezone?: string }
  | { kind: 'watch'; paths: string[] }
  | { kind: 'wake'; channels: string[] }
  | {
      kind: 'event';
      /** Intake source ids (event-intake-policy). */
      sources: string[];
      types?: string[];
      match?: { json_path: string; equals?: unknown; in?: unknown[] };
    }
  | {
      kind: 'probe';
      /** Declarative external-state spec; evaluated by libs/core/state-probe. */
      probe: import('../state-probe.js').StateProbeSpec;
      /** Minimum seconds between evaluations (default: one per sweep). */
      every_s?: number;
    };

export interface DotCharter {
  kind: 'dot-charter';
  dot_id: string;
  version: string;
  title: string;
  purpose: string;
  status: DotCharterStatus;
  scope: {
    tier: 'public' | 'confidential' | 'personal';
    tenant_slug?: string;
    organization_id?: string;
    project_id?: string;
  };
  goal: {
    statement: string;
    success_signals?: string[];
    /** Measurable form of success_signals: a signal is healthy while its probe matches. */
    signal_probes?: Array<{
      signal: string;
      probe: import('../state-probe.js').StateProbeSpec;
      every_s?: number;
    }>;
    budget?: {
      max_turns_per_wake?: number;
      wall_clock_ms_per_wake?: number;
      token_cap_per_day?: number;
    };
    /** Quantified key results (max 10). */
    key_results?: KeyResultSpec[];
    /** Default minutes before a completed action's outcome is measured (default 60). */
    outcome_settle_minutes?: number;
  };
  attention: { triggers: DotTrigger[] };
  authority: {
    authority_role: string;
    accountability_charter_ref?: string;
    allowed_work_shapes?: Array<'mission' | 'task_session' | 'pipeline' | 'direct_reply'>;
    max_concurrent_delegations?: number;
    /** Repo-relative pipelines the executor may run for pipeline-shaped work. */
    allowed_pipelines?: string[];
  };
  decisions?: {
    default_decision?: 'auto' | 'notify' | 'approve';
    veto_window_minutes?: number;
    decision_expiry_minutes?: number;
    escalate_channel?: 'slack' | 'telegram' | 'discord' | 'imessage' | 'surface';
  };
  notification: {
    deliver_to: {
      surface: 'slack' | 'telegram' | 'discord' | 'imessage' | 'surface';
      channel: string;
      thread_ts?: string;
      template?: string;
    };
    digest_cron?: string;
    quiet_hours?: { start?: string; end?: string; timezone?: string };
    /** `inbox` (default) keeps every send in the local inbox; `live` uses deliver_to. */
    delivery_mode?: 'inbox' | 'live';
  };
  team?: {
    /** Exclusive responsibility keys; two active dots may not hold the same key. */
    responsibilities?: string[];
    /** Dots allowed to hand work to this one through the dot inbox. */
    accepts_handoffs_from?: string[];
    /** Organization-level goal this dot contributes to: free-text label or an objective reference. */
    goal_ref?: string | ObjectiveRef;
    /** Target patterns this dot owns (sole owner wins arbitration). */
    owns?: string[];
    /** Arbitration priority 0-100 (default 50). */
    priority?: number;
  };
  memory?: { enabled?: boolean; max_bytes?: number };
  followups?: { max_pending?: number };
  autonomy?: {
    initial_level?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
    max_level?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
    min_level?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  };
  runtime: {
    heartbeat_id: string;
    reasoning_backend?: string;
    max_idle_wake_ms?: number;
    /** Hours of missed cron runs coalesced into one catch-up wake (1-24, default 6). */
    cron_catch_up_hours?: number;
  };
}

/** Display label for `team.goal_ref` (string form, or `org/objective` for a reference). */
export function dotGoalRefLabel(charter: DotCharter): string | undefined {
  const ref = charter.team?.goal_ref;
  if (!ref) return undefined;
  if (typeof ref === 'string') return ref;
  return ref.organization_id ? `${ref.organization_id}/${ref.objective_id}` : ref.objective_id;
}

let validator: ValidateFunction<DotCharter> | undefined;
let validatorSchemaMtimeMs: number | undefined;

/** Recompiles when the schema file changes, so a long-lived daemon never validates against a stale schema. */
function charterValidator(): ValidateFunction<DotCharter> {
  const schemaPath = pathResolver.rootResolve(DOT_CHARTER_SCHEMA_PATH);
  let mtimeMs: number | undefined;
  try {
    mtimeMs = safeLstat(schemaPath).mtimeMs;
  } catch {
    mtimeMs = undefined;
  }
  if (!validator || validatorSchemaMtimeMs !== mtimeMs) {
    validator = compileSchema<DotCharter>(schemaPath);
    validatorSchemaMtimeMs = mtimeMs;
  }
  return validator;
}

export function validateDotCharter(value: unknown, sourcePath = '<inline>'): DotCharter {
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value) && '$schema' in value
      ? Object.fromEntries(Object.entries(value as object).filter(([key]) => key !== '$schema'))
      : value;
  const validate = charterValidator();
  if (!validate(candidate)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim())
      .join('; ');
    throw new Error(`Invalid dot charter at ${sourcePath}: ${errors}`);
  }
  return candidate as DotCharter;
}

export function loadDotCharter(filePath: string): DotCharter {
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = parseSafeJsonObjectInput(raw, `dot charter ${filePath}`);
  return validateDotCharter(parsed, filePath);
}

/** Repo-level charter dir; tenant charters live under knowledge/confidential/<slug>/dots. */
export function dotCharterDir(rootDir = pathResolver.rootDir()): string {
  return path.join(rootDir, DOT_CHARTER_DIR);
}

function jsonChildren(dir: string): string[] {
  const found: string[] = [];
  for (const name of safeReaddir(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    const stat = safeLstat(full);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    found.push(full);
  }
  return found;
}

/** Where a charter file was found; tenant charters carry their directory slug. */
export interface DotCharterSource {
  path: string;
  /** Set for `knowledge/confidential/<slug>/dots/*.json`; absent for repo-level `dots/`. */
  tenant_slug?: string;
}

/**
 * Charters of registered, operational tenants: direct `*.json` children of
 * `knowledge/confidential/<slug>/dots/`. Same deny-by-default rule as chronos
 * tenant pipelines: symlink-free path, tenant listed under its own binding.
 */
function listTenantDotCharterSources(rootDir: string): DotCharterSource[] {
  // The repository path boundary resolves against an absolute root; a relative
  // root (tests, CLI --root) would otherwise fail the boundary and list nothing.
  const registryRoot = path.resolve(rootDir);
  let slugs: string[];
  try {
    slugs = withExecutionContext(DOT_TENANT_SCAN_ROLE, () =>
      listTenantProfileSlugs({ rootDir: registryRoot })
    );
  } catch {
    return [];
  }
  const found: DotCharterSource[] = [];
  for (const slug of slugs) {
    try {
      withExecutionContext(
        DOT_TENANT_SCAN_ROLE,
        () => {
          const knowledgeRoot = resolveTenant(slug, { rootDir: registryRoot }).knowledge_root;
          if (knowledgeRoot !== `knowledge/confidential/${slug}`) return;
          const relativeDir = `${knowledgeRoot}/${DOT_CHARTER_DIR}`;
          const dir = path.join(rootDir, relativeDir);
          if (!safeExistsSync(dir)) return;
          assertSafeRepositoryPath(dir, { rootDir: path.resolve(rootDir), allowMissingLeaf: true });
          for (const filePath of jsonChildren(dir))
            found.push({ path: filePath, tenant_slug: slug });
        },
        undefined,
        slug
      );
    } catch (error) {
      logger.debug(
        `tenant ${slug} dot charters not scanned — ${error instanceof Error ? error.message : error}`
      );
    }
  }
  return found;
}

/** Every charter file with the tenant its directory binds it to (path-sorted). */
export function listDotCharterSources(rootDir = pathResolver.rootDir()): DotCharterSource[] {
  const dir = dotCharterDir(rootDir);
  const repoLevel: DotCharterSource[] = safeExistsSync(dir)
    ? jsonChildren(dir).map((filePath) => ({ path: filePath }))
    : [];
  return [...repoLevel, ...listTenantDotCharterSources(rootDir)].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}

export function listDotCharterPaths(rootDir = pathResolver.rootDir()): string[] {
  return listDotCharterSources(rootDir).map((source) => source.path);
}

/**
 * Load a charter from where it was found. A tenant charter is read inside the
 * same tenant-bound runner context it was listed under (tier-guard denies the
 * confidential path in any other context) and must declare the tenant its
 * directory binds it to — a charter under `knowledge/confidential/<slug>/dots`
 * claiming another tenant (or a non-confidential tier) is rejected. Repo-level
 * `dots/` charters keep their declared scope (e.g. an org dot bound to the
 * operator's own tenant).
 */
export function loadDotCharterSource(source: DotCharterSource): DotCharter {
  const slug = source.tenant_slug;
  if (!slug) return loadDotCharter(source.path);
  const charter = withExecutionContext(
    DOT_TENANT_SCAN_ROLE,
    () => loadDotCharter(source.path),
    undefined,
    slug
  );
  if (charter.scope.tenant_slug !== slug || charter.scope.tier !== 'confidential') {
    throw new Error(
      `Dot charter at ${source.path} is not bound to its tenant directory: scope must be { tier: 'confidential', tenant_slug: '${slug}' }`
    );
  }
  return charter;
}

export interface LoadedDotCharter extends DotCharterSource {
  charter: DotCharter;
}

export interface DotCharterLoadError {
  path: string;
  error: string;
  /** Present for a successfully parsed identity rejected because it collides. */
  dot_id?: string;
}

/**
 * List repo and tenant charters. By default a malformed file throws (the CLI
 * uses that for `dot validate`/`dot list` reporting). Pass `options.errors`
 * to collect parse failures instead — resident consumers (the supervisor
 * sweep, the watchdog union) must never let one bad charter starve the rest.
 * Dot IDs key shared runtime stores, so every successfully loaded charter
 * with a colliding ID is rejected, across scopes and before status filtering.
 */
export function listDotCharters(
  rootDir = pathResolver.rootDir(),
  options: { status?: DotCharterStatus; errors?: DotCharterLoadError[] } = {}
): LoadedDotCharter[] {
  const charters: LoadedDotCharter[] = [];
  const pathsById = new Map<string, string[]>();
  for (const source of listDotCharterSources(rootDir)) {
    const filePath = source.path;
    let charter: DotCharter;
    try {
      charter = loadDotCharterSource(source);
    } catch (error) {
      if (!options.errors) throw error;
      options.errors.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    charters.push({ ...source, charter });
    const paths = pathsById.get(charter.dot_id) ?? [];
    paths.push(filePath);
    pathsById.set(charter.dot_id, paths);
  }
  const collidingIds = new Set<string>();
  for (const [dotId, paths] of pathsById) {
    if (paths.length < 2) continue;
    const error = `Duplicate dot_id '${dotId}' across dot charters: ${paths.join(', ')}`;
    if (!options.errors) throw new Error(error);
    collidingIds.add(dotId);
    for (const filePath of paths) options.errors.push({ path: filePath, error, dot_id: dotId });
  }
  return charters.filter(
    ({ charter }) =>
      !collidingIds.has(charter.dot_id) && (!options.status || charter.status === options.status)
  );
}

/** Resolve one identity, rejecting ambiguity while isolating malformed or colliding siblings. */
export function findDotCharter(
  dotId: string,
  rootDir = pathResolver.rootDir()
): LoadedDotCharter | undefined {
  const errors: DotCharterLoadError[] = [];
  const loaded = listDotCharters(rootDir, { errors });
  const collision = errors.find((entry) => entry.dot_id === dotId);
  if (collision) throw new Error(collision.error);
  return loaded.find((entry) => entry.charter.dot_id === dotId);
}
