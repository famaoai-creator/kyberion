import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
// Identity resolution must not depend on policy-enforced IO: secure-io's
// guards consult the identity this module computes, so importing secure-io
// here created a cycle (secure-io → tier-guard/policy-engine → authority →
// secure-io) that hit TDZ errors during module evaluation and silently broke
// resolveIdentityContext. Read-only bootstrap IO goes through fs-primitives.
import { rawExistsSync, rawLstatSync, rawReaddir, rawReadTextFile } from './fs-primitives.js';
import { isValidTenantSlug } from './entity-scope.js';
import * as pathResolver from './path-resolver.js';
import { getRegisteredEnvText, setRegisteredEnv } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { Persona, Authority, ExecutionMode, IdentityContext } from './types.js';
import { getServiceAuthorities } from './service-authority-map.js';
import { createLogger } from './logger.js';
import { registerIdentityContextResolver } from './identity-context-bridge.js';
const logger = createLogger('authority');

type RolePersonaIndex = {
  authority_roles?: Record<string, { default_persona?: Persona }>;
};

const LEGACY_ROLE_PERSONA_DEFAULTS: Record<string, Persona> = {
  // system roles
  ecosystem_architect: 'ecosystem_architect',
  knowledge_steward: 'analyst',
  solution_architect: 'ecosystem_architect',
  integration_steward: 'ecosystem_architect',
  reliability_engineer: 'worker',
  infrastructure_sentinel: 'worker',
  // mission roles
  sovereign_concierge: 'sovereign',
  mission_controller: 'worker',
  software_developer: 'worker',
  incident_commander: 'worker',
  performance_engineer: 'worker',
  // surface/infra authority roles
  slack_bridge: 'worker',
  chronos_gateway: 'worker',
  chronos_operator: 'worker',
  chronos_localadmin: 'worker',
  service_actuator: 'worker',
  surface_runtime: 'worker',
  // context roles
  ceo: 'analyst',
  business_owner: 'analyst',
  product_manager: 'analyst',
  strategic_sales: 'analyst',
  marketing_growth: 'analyst',
  customer_success: 'worker',
  pmo_governance: 'analyst',
  qa_lead: 'analyst',
  legal_strategist: 'analyst',
  cyber_security: 'analyst',
  ruthless_auditor: 'analyst',
  designer: 'worker',
  executive_assistant: 'worker',
  finance_controller: 'analyst',
  talent_culture: 'worker',
  line_manager: 'worker',
};

let cachedRolePersonaIndex: RolePersonaIndex | null = null;

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(raw: string): JsonRecord | null {
  try {
    const value: unknown = parseSafeJsonInput(raw, 'authority JSON');
    return isJsonRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalStringFieldIsValid(record: JsonRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

let cachedRoleAuthorityMap: Record<string, Persona> | null = null;
const executionScopeStorage = new AsyncLocalStorage<{
  tenantBound: boolean;
  tenantSlug?: string;
}>();

function loadRoleAuthorityMapPersonas(): Record<string, Persona> {
  if (cachedRoleAuthorityMap) return cachedRoleAuthorityMap;
  const filePath = pathResolver.knowledge('product/governance/role-authority-map.json');
  try {
    if (!rawExistsSync(filePath)) {
      cachedRoleAuthorityMap = {};
      return cachedRoleAuthorityMap;
    }
    const raw = parseJsonRecord(rawReadTextFile(filePath));
    if (!raw) {
      cachedRoleAuthorityMap = {};
      return cachedRoleAuthorityMap;
    }
    const result: Record<string, Persona> = {};
    for (const group of ['system_roles', 'mission_roles', 'context_roles']) {
      const entries = raw[group];
      if (!Array.isArray(entries)) continue;
      for (const value of entries) {
        if (!isJsonRecord(value)) continue;
        const role = stringField(value, 'role')?.trim();
        const persona = normalizePersona(stringField(value, 'persona'));
        if (role && persona !== 'unknown') result[role] = persona;
      }
    }
    cachedRoleAuthorityMap = result;
  } catch {
    cachedRoleAuthorityMap = {};
  }
  return cachedRoleAuthorityMap;
}

function loadRolePersonaIndexDirectory(): RolePersonaIndex | null {
  const directoryPath = pathResolver.knowledge('product/governance/authority-roles');
  if (!rawExistsSync(directoryPath)) {
    return null;
  }

  const files = rawReaddir(directoryPath)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    return null;
  }

  const authority_roles: Record<string, { default_persona?: Persona }> = {};
  for (const file of files) {
    const filePath = pathResolver.knowledge(`product/governance/authority-roles/${file}`);
    const payload = parseJsonRecord(rawReadTextFile(filePath));
    if (!payload) {
      throw new Error(`Authority role file ${file} must contain a JSON object`);
    }
    const role = stringField(payload, 'role')?.trim() || '';
    if (!role) {
      throw new Error(`Authority role file ${file} must declare a role id`);
    }
    if (file.replace(/\.json$/i, '') !== role) {
      throw new Error(`Authority role file ${file} must match its role id (${role})`);
    }
    const defaultPersona = normalizePersona(stringField(payload, 'default_persona'));
    authority_roles[role] = defaultPersona === 'unknown' ? {} : { default_persona: defaultPersona };
  }

  return { authority_roles };
}

function loadRolePersonaIndex(): RolePersonaIndex {
  if (cachedRolePersonaIndex) return cachedRolePersonaIndex;
  const directoryIndex = loadRolePersonaIndexDirectory();
  if (directoryIndex) {
    cachedRolePersonaIndex = directoryIndex;
    return cachedRolePersonaIndex;
  }

  const indexPath = pathResolver.knowledge('product/governance/authority-role-index.json');
  try {
    const raw = parseJsonRecord(rawReadTextFile(indexPath));
    const roles = raw?.authority_roles;
    if (!isJsonRecord(roles)) {
      cachedRolePersonaIndex = {};
      return cachedRolePersonaIndex;
    }
    const authority_roles: RolePersonaIndex['authority_roles'] = {};
    for (const [role, value] of Object.entries(roles)) {
      if (!isJsonRecord(value)) continue;
      const defaultPersona = normalizePersona(stringField(value, 'default_persona'));
      authority_roles[role] =
        defaultPersona === 'unknown' ? {} : { default_persona: defaultPersona };
    }
    cachedRolePersonaIndex = { authority_roles };
  } catch {
    cachedRolePersonaIndex = {};
  }
  return cachedRolePersonaIndex;
}

/**
 * Authority Manager v1.0
 * Resolves logical identity and temporal authorities for the current execution.
 */

function normalizePersona(value: unknown): Persona {
  if (typeof value !== 'string' || !value) return 'unknown';
  const normalized = value.toLowerCase().replace(/\s+/g, '_');
  if (
    normalized === 'sovereign' ||
    normalized === 'ecosystem_architect' ||
    normalized === 'mission_owner' ||
    normalized === 'worker' ||
    normalized === 'analyst'
  ) {
    return normalized;
  }
  return 'unknown';
}

function isAuthority(value: string): value is Authority {
  return (
    value === 'SUDO' ||
    value === 'GIT_WRITE' ||
    value === 'SECRET_READ' ||
    value === 'NETWORK_FETCH' ||
    value === 'SYSTEM_EXEC' ||
    value === 'KNOWLEDGE_WRITE'
  );
}

export function resolveRole(): string | undefined {
  const envRole = getRegisteredEnvText('SYSTEM_ROLE') || getRegisteredEnvText('MISSION_ROLE');
  if (envRole) return envRole.toLowerCase().replace(/\s+/g, '_');

  const argv1 = process.argv[1] || '';
  const procName = path.basename(argv1, path.extname(argv1)).toLowerCase().replace(/[-]/g, '_');
  if (procName.includes('mission_controller') || procName === 'controller')
    return 'mission_controller';
  if (procName.includes('surface_runtime')) return 'surface_runtime';
  if (procName.includes('orchestrator')) return 'orchestrator';
  return procName || undefined;
}

export function inferPersonaFromRole(role?: string): Persona {
  if (!role) return 'unknown';
  const normalized = role.toLowerCase().replace(/\s+/g, '_');
  const fromIndex = normalizePersona(
    loadRolePersonaIndex().authority_roles?.[normalized]?.default_persona
  );
  if (fromIndex !== 'unknown') return fromIndex;
  const fromMap = loadRoleAuthorityMapPersonas()[normalized];
  return fromMap || LEGACY_ROLE_PERSONA_DEFAULTS[normalized] || 'unknown';
}

export function buildExecutionEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  role?: string,
  persona?: Persona
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  if (role) nextEnv.MISSION_ROLE = role;
  const resolvedPersona = persona || inferPersonaFromRole(role);
  if (resolvedPersona !== 'unknown') {
    nextEnv.KYBERION_PERSONA = resolvedPersona;
  } else if (!persona && !baseEnv.KYBERION_PERSONA) {
    delete nextEnv.KYBERION_PERSONA;
  }
  return nextEnv;
}

export function withExecutionContext<T>(
  role: string,
  fn: () => T,
  persona?: Persona,
  tenantSlug?: string
): T {
  const previousRole = process.env.MISSION_ROLE;
  const previousPersona = getRegisteredEnvText('KYBERION_PERSONA');
  process.env.MISSION_ROLE = role;
  const resolvedPersona = persona || inferPersonaFromRole(role);
  if (resolvedPersona !== 'unknown') {
    setRegisteredEnv('KYBERION_PERSONA', resolvedPersona);
  } else if (persona === undefined) {
    setRegisteredEnv('KYBERION_PERSONA', undefined);
  }
  try {
    return executionScopeStorage.run(
      { tenantBound: tenantSlug !== undefined, ...(tenantSlug ? { tenantSlug } : {}) },
      fn
    );
  } finally {
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
    setRegisteredEnv('KYBERION_PERSONA', previousPersona);
  }
}

/**
 * Async counterpart of withExecutionContext. The synchronous helper restores
 * process context as soon as an async callback returns its Promise, which is
 * too early for governed writes after the first await.
 */
export async function withExecutionContextAsync<T>(
  role: string,
  fn: () => Promise<T> | T,
  persona?: Persona,
  tenantSlug?: string
): Promise<T> {
  const previousRole = process.env.MISSION_ROLE;
  const previousPersona = getRegisteredEnvText('KYBERION_PERSONA');
  process.env.MISSION_ROLE = role;
  const resolvedPersona = persona || inferPersonaFromRole(role);
  if (resolvedPersona !== 'unknown') {
    setRegisteredEnv('KYBERION_PERSONA', resolvedPersona);
  } else if (persona === undefined) {
    setRegisteredEnv('KYBERION_PERSONA', undefined);
  }
  try {
    return await executionScopeStorage.run(
      { tenantBound: tenantSlug !== undefined, ...(tenantSlug ? { tenantSlug } : {}) },
      fn
    );
  } finally {
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
    setRegisteredEnv('KYBERION_PERSONA', previousPersona);
  }
}

function resolveSudoScope(): string[] | undefined {
  const raw = getRegisteredEnvText('KYBERION_SUDO_SCOPE');
  if (!raw) return undefined;
  const scopes = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

function normalizeTenantSlug(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  return isValidTenantSlug(trimmed) ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// NI-04 task-scoped grants — read-side (see libs/core/task-scoped-grants.ts)
//
// This module CANNOT import task-scoped-grants.ts: that module writes through
// secure-io, and secure-io's policy chain imports authority.ts (the exact TDZ
// cycle documented at the top of this file). The audience filter below is
// therefore a small, intentionally duplicated raw-read twin of that module's
// `resolveGrantsForActor`; both resolve the store through the same
// KYBERION_TASK_GRANTS_PATH-or-default rule so they always read the same file.
// ---------------------------------------------------------------------------

/** Mirrors NHI_ID_PATTERN in agent-identity.ts (not importable here — see above). */
const TASK_GRANT_NHI_ID_PATTERN = /^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const TASK_GRANT_NHI_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Authority names a task grant's `scope.capabilities` may confer. SUDO is
 * deliberately excluded: a task-scoped grant must never mint full system
 * access, whatever its capabilities claim.
 */
const TASK_GRANT_AUTHORITY_NAMES: ReadonlySet<string> = new Set([
  'GIT_WRITE',
  'SECRET_READ',
  'NETWORK_FETCH',
  'SYSTEM_EXEC',
  'KNOWLEDGE_WRITE',
]);

function resolveTaskGrantsReadPath(): string | undefined {
  const override = getRegisteredEnvText('KYBERION_TASK_GRANTS_PATH')?.trim();
  const candidate = override
    ? pathResolver.rootResolve(override)
    : pathResolver.shared('coordination/identity/task-grants.jsonl');
  const root = path.resolve(pathResolver.rootDir());
  const absolute = path.resolve(candidate);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    logger.debug(`task grant read path rejected outside repository: ${candidate}`);
    return undefined;
  }

  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (rawLstatSync(current).isSymbolicLink()) {
        logger.debug(`task grant read path rejected through symbolic link: ${candidate}`);
        return undefined;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      logger.debug(`task grant read path could not be inspected: ${candidate}: ${error}`);
      return undefined;
    }
  }
  return absolute;
}

/**
 * The current execution's actor identity for grant matching:
 * 1. `KYBERION_NHI_ID` env when it is a canonical nhi_id (the runtime
 *    supervisor / dispatch env stamps this for spawned workers);
 * 2. else, when the resolved role string is itself nhi-slug-shaped (an agent
 *    slug such as `implementation-architect`, not an underscore authority
 *    role like `mission_controller`), derive `kyberion://agent/<org>/<role>`
 *    with the org read raw from the organization profile ('default'
 *    fallback) — the same derivation as agent-identity.ts deriveAgentNhiId.
 * Fail-closed: no resolvable actor identity means no task grants are served.
 */
function resolveGrantActorNhiId(role: string | undefined): string | undefined {
  const explicit = getRegisteredEnvText('KYBERION_NHI_ID')?.trim();
  if (explicit) {
    return TASK_GRANT_NHI_ID_PATTERN.test(explicit) ? explicit : undefined;
  }
  if (!role || !TASK_GRANT_NHI_SLUG_PATTERN.test(role)) return undefined;
  let organizationId = 'default';
  try {
    const profilePath = pathResolver.knowledge('product/governance/organization-profile.json');
    if (rawExistsSync(profilePath)) {
      const profile = parseJsonRecord(rawReadTextFile(profilePath));
      const candidate = profile ? stringField(profile, 'organization_id') || '' : '';
      if (TASK_GRANT_NHI_SLUG_PATTERN.test(candidate)) organizationId = candidate;
    }
  } catch (err) {
    logger.debug(`task-grant actor org resolution fell back to 'default': ${err}`);
  }
  return `kyberion://agent/${organizationId}/${role}`;
}

export function resolveIdentityContext(tenantOverride?: string): IdentityContext {
  const missionId = getRegisteredEnvText('MISSION_ID');
  const envPersona = getRegisteredEnvText('KYBERION_PERSONA');
  const envRole = resolveRole();

  let persona: Persona = normalizePersona(envPersona);
  const authorities: Authority[] = [];
  const executionScope = executionScopeStorage.getStore();
  let tenantSlug: string | undefined = normalizeTenantSlug(
    tenantOverride ??
      (executionScope?.tenantBound
        ? executionScope.tenantSlug
        : getRegisteredEnvText('KYBERION_TENANT'))
  );
  let brokeredTenants: string[] | undefined;
  let brokerApproval:
    | {
        purpose?: string;
        approvedBy?: string;
        approvedAt?: string;
        expiresAt?: string;
      }
    | undefined;

  // 1. Resolve Persona (and tenantSlug / brokeredTenants) from Mission State.
  // Try the legacy no-tier path first, then fall back to tier-aware lookup
  // (covers active/missions/{personal,confidential,public}/{id}/...).
  if (missionId) {
    const candidates: string[] = [pathResolver.active(`missions/${missionId}/mission-state.json`)];
    const tierPath = pathResolver.findMissionPath(missionId);
    if (tierPath) candidates.push(`${tierPath}/mission-state.json`);
    for (const statePath of candidates) {
      try {
        if (rawExistsSync(statePath)) {
          const state = parseJsonRecord(rawReadTextFile(statePath));
          if (!state) continue;
          if (persona === 'unknown') persona = normalizePersona(state.assigned_persona);
          if (!tenantSlug) tenantSlug = normalizeTenantSlug(stringField(state, 'tenant_slug'));
          const brokerage = state.cross_tenant_brokerage;
          const brokered = isJsonRecord(brokerage) ? brokerage.source_tenants : undefined;
          if (Array.isArray(brokered) && brokered.length > 0) {
            const slugs = brokered
              .map((t: unknown) => normalizeTenantSlug(typeof t === 'string' ? t : undefined))
              .filter((t): t is string => !!t);
            if (slugs.length > 0) brokeredTenants = slugs;
          }
          if (isJsonRecord(brokerage)) {
            const cfg = brokerage;
            brokerApproval = {
              purpose: stringField(cfg, 'purpose'),
              approvedBy: stringField(cfg, 'approved_by'),
              approvedAt: stringField(cfg, 'approved_at'),
              expiresAt: stringField(cfg, 'expires_at'),
            };
          }
          break;
        }
      } catch (err) {
        logger.warn(`suppressed error in resolveIdentityContext: ${err}`);
      }
    }
  }

  // 2. A functional mission/system role outranks the operator's default
  // persona. This prevents a persisted sovereign profile from escalating a
  // worker/controller process that intentionally omitted KYBERION_PERSONA.
  if (persona === 'unknown' && envRole) {
    persona = inferPersonaFromRole(envRole);
  }

  // 3. Default Persona from process name if still unknown. The persisted
  // onboarding profile is intentionally not an execution authority source:
  // it is operator-editable data and must never grant SECRET_READ,
  // SYSTEM_EXEC, or other intrinsic authorities.
  if (persona === 'unknown') {
    const argv1 = process.argv[1] || '';
    const procName = path.basename(argv1, path.extname(argv1)).toLowerCase().replace(/[-]/g, '_');
    if (procName.includes('orchestrator') || procName.includes('controller'))
      persona = 'ecosystem_architect';
  }

  // 5. Resolve Authorities

  // A. Persona-based intrinsic authorities
  if (persona === 'sovereign' || persona === 'ecosystem_architect') {
    authorities.push('GIT_WRITE', 'SECRET_READ', 'NETWORK_FETCH', 'SYSTEM_EXEC', 'KNOWLEDGE_WRITE');
  }

  // B. Temporal Grants (Role-based)
  const grantsPath = pathResolver.active('shared/auth-grants.json');
  if (rawExistsSync(grantsPath) && missionId) {
    try {
      const grants: unknown = parseSafeJsonInput(rawReadTextFile(grantsPath), 'authority grants');
      const activeGrants = Array.isArray(grants)
        ? grants.filter((value): value is JsonRecord => {
            if (!isJsonRecord(value)) return false;
            const expiresAt = value.expiresAt;
            return (
              stringField(value, 'missionId') === missionId &&
              typeof expiresAt === 'number' &&
              Number.isFinite(expiresAt) &&
              expiresAt > Date.now()
            );
          })
        : [];

      for (const grant of activeGrants) {
        for (const authority of getServiceAuthorities(stringField(grant, 'serviceId') || '')) {
          if (isAuthority(authority)) authorities.push(authority);
        }
        const authority = stringField(grant, 'authority');
        if (authority && isAuthority(authority)) authorities.push(authority);
      }
    } catch (err) {
      logger.warn(`suppressed error in resolveIdentityContext: ${err}`);
    }
  }

  // B2. Task-scoped grants (NI-04) — the internal RFC 8707 audience check:
  // a grant contributes authorities ONLY when it names this actor
  // (grantee_nhi_id), its audience matches the requesting execution context
  // (mission_id must equal MISSION_ID; task_id, when the grant names one,
  // must equal the TASK_ID env), it has not expired (lazy expiry — no cron),
  // and it is not revoked. Anything else contributes NOTHING (fail-closed
  // silence + debug log). Legacy auth-grants.json handling above is
  // untouched. Last record per grant_id wins (revocations re-append).
  if (missionId) {
    try {
      const taskGrantsPath = resolveTaskGrantsReadPath();
      if (taskGrantsPath && rawExistsSync(taskGrantsPath)) {
        const actorNhiId = resolveGrantActorNhiId(envRole);
        if (actorNhiId) {
          const taskId = getRegisteredEnvText('TASK_ID')?.trim() || undefined;
          const latestGrants = new Map<string, JsonRecord>();
          for (const line of rawReadTextFile(taskGrantsPath).split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed: unknown = parseSafeJsonInput(trimmed, 'authority grant entry');
              if (isJsonRecord(parsed)) {
                const grantId = stringField(parsed, 'grant_id');
                if (grantId) latestGrants.set(grantId, parsed);
              }
            } catch {
              // torn/corrupt line — tolerated, like the store's own reader
            }
          }
          const now = Date.now();
          for (const grant of latestGrants.values()) {
            if (
              !stringField(grant, 'grantee_nhi_id') ||
              !stringField(grant, 'expires_at') ||
              !isJsonRecord(grant.audience) ||
              !isJsonRecord(grant.scope) ||
              !optionalStringFieldIsValid(grant, 'revoked_at') ||
              !optionalStringFieldIsValid(grant.audience, 'task_id') ||
              !optionalStringFieldIsValid(grant.scope, 'tenant_slug')
            ) {
              continue;
            }
            if (stringField(grant, 'grantee_nhi_id') !== actorNhiId) continue;
            if (stringField(grant, 'revoked_at')) {
              logger.debug(`task grant ${stringField(grant, 'grant_id')} skipped: revoked`);
              continue;
            }
            const expiresAt = stringField(grant, 'expires_at');
            const expiresMs = Date.parse(expiresAt || '');
            if (!Number.isFinite(expiresMs) || expiresMs <= now) {
              logger.debug(`task grant ${stringField(grant, 'grant_id')} skipped: expired`);
              continue;
            }
            const audience = grant.audience;
            const scope = grant.scope;
            const grantTenant = (stringField(scope, 'tenant_slug') || '').trim();
            const actorTenant = getRegisteredEnvText('KYBERION_TENANT')?.trim();
            if (!grantTenant || !actorTenant || grantTenant !== actorTenant) {
              logger.debug(
                `task grant ${stringField(grant, 'grant_id')} skipped: tenant scope ${grantTenant || '<missing>'} != ${actorTenant || '<missing>'}`
              );
              continue;
            }
            if (stringField(audience, 'mission_id') !== missionId) {
              logger.debug(
                `task grant ${stringField(grant, 'grant_id')} skipped: audience mission ${stringField(audience, 'mission_id')} != ${missionId}`
              );
              continue;
            }
            const audienceTaskId = stringField(audience, 'task_id');
            if (audienceTaskId !== undefined && audienceTaskId !== taskId) {
              logger.debug(
                `task grant ${stringField(grant, 'grant_id')} skipped: audience task ${audienceTaskId} != ${taskId ?? '<none>'}`
              );
              continue;
            }
            const capabilities = Array.isArray(scope.capabilities) ? scope.capabilities : [];
            for (const capability of capabilities) {
              if (
                typeof capability === 'string' &&
                TASK_GRANT_AUTHORITY_NAMES.has(capability) &&
                isAuthority(capability)
              ) {
                authorities.push(capability);
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`suppressed error in resolveIdentityContext: ${err}`);
    }
  }

  // C. Environment Sudo Overrides
  if (getRegisteredEnvText('KYBERION_SUDO') === 'true') {
    authorities.push('SUDO');
  }

  const executionMode: ExecutionMode =
    persona === 'sovereign'
      ? 'sovereign'
      : persona === 'ecosystem_architect'
        ? 'system'
        : 'mission';

  return {
    persona,
    executionMode,
    authorities: Array.from(new Set(authorities)),
    missionId,
    role: envRole,
    sudoScope: resolveSudoScope(),
    tenantSlug,
    ...(brokeredTenants ? { brokeredTenants } : {}),
    ...(brokerApproval ? { brokerApproval } : {}),
  };
}

registerIdentityContextResolver(resolveIdentityContext);

/**
 * Checks if the current context has a specific authority.
 */
export function hasAuthority(authority: Authority): boolean {
  const ctx = resolveIdentityContext();
  return ctx.authorities.includes('SUDO') || ctx.authorities.includes(authority);
}
