/**
 * Run scope of a pipeline file, derived from where the file lives
 * (pipeline-run-manifest-model §2 "どこで").
 *
 * The tenant that owns a run is decided by the pipeline's location and the
 * tenant registry — never by `KYBERION_TENANT`. The ambient selected tenant
 * may only confirm the derived one: unset or equal passes, anything else is a
 * mismatch. Repository-owned pipelines (`pipelines/`, `knowledge/product/…`)
 * derive no tenant and keep today's ambient behaviour.
 */
import { withStoreGrant } from '../authority.js';
import {
  PathAttributionError,
  tenantOfPath,
  tierOfPath,
  type PathDataTier,
} from '../governance/path-tenant-attribution.js';
import {
  assertTenantOperational,
  readTenantProfile,
  type TenantRegistryPathOptions,
} from '../organization/tenant-registry.js';
import * as pathResolver from '../path-resolver.js';
import { resolveScopeContext } from '../scope-context.js';
import { mintScopeEnvelope, narrowScopeEnvelope, type ScopeEnvelope } from '../scope-envelope.js';

export interface RunScope {
  /** Repo-relative pipeline path the scope was derived from. */
  input_path: string;
  /** Data tier implied by the file location. */
  tier: PathDataTier;
  /** Owning tenant derived from the file location; absent for tenant-less locations. */
  tenant_slug?: string;
  /** `location` when the tenant comes from the file; `ambient` when the run keeps the process scope. */
  source: 'location' | 'ambient';
  /** The ambient selected tenant that was compared (diagnostics only — never authority). */
  ambient_tenant_slug?: string;
}

export interface DeriveRunScopeOptions {
  /** Process env used for the ambient tenant comparison (tests). */
  env?: NodeJS.ProcessEnv;
  /** Tenant registry location (tests). */
  registry?: TenantRegistryPathOptions;
}

function runScopeError(code: string, what: string, why: string, next: string): Error {
  return new Error(`[${code}] ${what} — ${why} | next: ${next}`);
}

function locationTenant(inputPath: string, rel: string, tier: PathDataTier): string | undefined {
  try {
    return tenantOfPath(inputPath);
  } catch (error) {
    // The personal tier belongs to the sovereign and has no tenant partition;
    // a tenant-less personal pipeline keeps the ambient scope.
    if (
      error instanceof PathAttributionError &&
      error.code === 'TENANT_UNRESOLVED' &&
      tier === 'personal'
    )
      return undefined;
    const detail = error instanceof PathAttributionError ? error.detail : String(error);
    throw runScopeError(
      'RUN_SCOPE_UNRESOLVED',
      `cannot derive the run tenant of ${rel}`,
      detail,
      'move the pipeline under knowledge/confidential/<tenant>/ or a tenant project tree'
    );
  }
}

function assertRegisteredTenant(
  slug: string,
  rel: string,
  registry: TenantRegistryPathOptions
): void {
  const profile = withStoreGrant(
    'workspace_tenant_registry_reader',
    () => readTenantProfile(slug, registry),
    { tenantSlug: slug }
  );
  if (!profile)
    throw runScopeError(
      'RUN_SCOPE_TENANT_UNKNOWN',
      `tenant '${slug}' derived from ${rel} is not registered`,
      'a run scope must name a tenant in the tenant registry',
      'KYBERION_BASE_ROLE=sovereign pnpm tenant list, then register the tenant or move the pipeline'
    );
  try {
    assertTenantOperational(profile, 'pipeline run');
  } catch (error) {
    throw runScopeError(
      'RUN_SCOPE_TENANT_INACTIVE',
      `tenant '${slug}' derived from ${rel} is ${profile.status}`,
      error instanceof Error ? error.message : String(error),
      `reactivate tenant '${slug}' before running its pipelines`
    );
  }
}

/**
 * Derive the run scope from the pipeline file location. Fails closed: an
 * unattributable confidential location, an unregistered or inactive tenant,
 * and a contradicting ambient tenant all throw a `[RUN_SCOPE_*]` diagnostic.
 */
export function deriveRunScope(inputPath: string, options: DeriveRunScopeOptions = {}): RunScope {
  const rel = pathResolver.toRepoRelative(pathResolver.rootResolve(inputPath));
  const tier = tierOfPath(inputPath);
  const tenant = locationTenant(inputPath, rel, tier);
  // Registered scope env only (resolveScopeContext defaults to the process env).
  const ambient = resolveScopeContext({}, options.env).tenant_slug || undefined;
  if (!tenant) {
    return {
      input_path: rel,
      tier,
      source: 'ambient',
      ...(ambient ? { ambient_tenant_slug: ambient } : {}),
    };
  }
  if (ambient && ambient !== tenant)
    throw runScopeError(
      'RUN_SCOPE_MISMATCH',
      `pipeline ${rel} belongs to tenant '${tenant}' but the selected tenant is '${ambient}'`,
      'the file location decides the run tenant; KYBERION_TENANT may only confirm it',
      'unset KYBERION_TENANT or move the pipeline'
    );
  assertRegisteredTenant(tenant, rel, options.registry ?? {});
  return {
    input_path: rel,
    tier,
    tenant_slug: tenant,
    source: 'location',
    ...(ambient ? { ambient_tenant_slug: ambient } : {}),
  };
}

/**
 * A nested run (`core:run_pipeline`) may only narrow its parent: a child file
 * that derives a different tenant than the active envelope fails.
 */
export function assertRunScopeNarrows(
  scope: RunScope,
  parent: Pick<ScopeEnvelope, 'identity'> | undefined
): void {
  const parentTenant = parent?.identity.tenant_slug;
  if (scope.tenant_slug && parentTenant && parentTenant !== scope.tenant_slug)
    throw runScopeError(
      'RUN_SCOPE_MISMATCH',
      `nested pipeline ${scope.input_path} belongs to tenant '${scope.tenant_slug}' but the running scope is tenant '${parentTenant}'`,
      'a nested run may only narrow its parent scope',
      'run the nested pipeline from its own tenant or move it'
    );
}

export interface RunScopeEnvelopeInput {
  /** Envelope already active in this async context (nested runs, Dot / task callers). */
  parent?: ScopeEnvelope;
  /** Session the mission-less envelope is bound to, e.g. `pipeline:<run id>`. */
  session_id: string;
  purpose: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The envelope a run executes under, or undefined to keep the current one
 * (tenant-less locations, or a parent already bound to the same tenant).
 * A top-level run with a derived tenant mints a session-bound envelope; a
 * nested run narrows its parent and never switches or adds a tenant the
 * parent's mission record does not anchor.
 */
export function runScopeEnvelope(
  scope: RunScope,
  input: RunScopeEnvelopeInput
): ScopeEnvelope | undefined {
  assertRunScopeNarrows(scope, input.parent);
  if (!scope.tenant_slug) return undefined;
  if (input.parent) {
    if (input.parent.identity.tenant_slug === scope.tenant_slug) return undefined;
    if (!input.parent.identity.tenant_slug && !input.parent.identity.mission_id) {
      // A tenant-less, mission-less parent (a resident daemon or Dot session)
      // has no tenant to contradict: binding the registered tenant the file
      // location derives is narrowing. The child keeps the parent's egress
      // and backend limits and gets the same session-bound envelope a
      // top-level run of this file would.
      return mintScopeEnvelope({
        identity: {
          tier: scope.tier,
          tenant_slug: scope.tenant_slug,
          session_id: input.session_id,
        },
        policy: {
          purpose: input.purpose,
          ...(input.parent.policy.external_egress !== undefined
            ? { external_egress: input.parent.policy.external_egress }
            : {}),
          ...(input.parent.policy.allowed_reasoning_backends
            ? { allowed_reasoning_backends: [...input.parent.policy.allowed_reasoning_backends] }
            : {}),
        },
        ...(input.env ? { env: input.env } : {}),
      });
    }
    // A mission anchors the parent's tenant (or its absence): only narrowing
    // the mission record allows is accepted.
    try {
      return narrowScopeEnvelope(input.parent, { identity: { tenant_slug: scope.tenant_slug } });
    } catch (error) {
      throw runScopeError(
        'RUN_SCOPE_MISMATCH',
        `nested pipeline ${scope.input_path} belongs to tenant '${scope.tenant_slug}' but the running scope has no tenant`,
        error instanceof Error ? error.message : String(error),
        'run the tenant pipeline as its own top-level run'
      );
    }
  }
  return mintScopeEnvelope({
    identity: { tier: scope.tier, tenant_slug: scope.tenant_slug, session_id: input.session_id },
    policy: { purpose: input.purpose },
    ...(input.env ? { env: input.env } : {}),
  });
}
