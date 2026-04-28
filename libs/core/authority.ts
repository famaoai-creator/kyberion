import * as path from 'node:path';
import { 
  safeExistsSync, 
  safeReadFile 
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import { 
  Persona, 
  Authority, 
  IdentityContext 
} from './types.js';

const ROLE_PERSONA_DEFAULTS: Record<string, Persona> = {
  ecosystem_architect: 'ecosystem_architect',
  sovereign_concierge: 'sovereign',
  mission_controller: 'worker',
  software_developer: 'worker',
  slack_bridge: 'worker',
  chronos_gateway: 'worker',
  chronos_operator: 'worker',
  chronos_localadmin: 'worker',
  surface_runtime: 'worker',
  infrastructure_sentinel: 'worker',
  ruthless_auditor: 'analyst',
  knowledge_steward: 'analyst',
  cyber_security: 'analyst',
};

/**
 * Authority Manager v1.0
 * Resolves logical identity and temporal authorities for the current execution.
 */

function normalizePersona(value: string | undefined): Persona {
  if (!value) return 'unknown';
  const normalized = value.toLowerCase().replace(/\s+/g, '_');
  if (normalized === 'sovereign' ||
      normalized === 'ecosystem_architect' ||
      normalized === 'mission_owner' ||
      normalized === 'worker' ||
      normalized === 'analyst') {
    return normalized;
  }
  return 'unknown';
}

function resolveRole(): string | undefined {
  const envRole = process.env.SYSTEM_ROLE || process.env.MISSION_ROLE;
  if (envRole) return envRole.toLowerCase().replace(/\s+/g, '_');

  const argv1 = process.argv[1] || '';
  const procName = path.basename(argv1, path.extname(argv1)).toLowerCase().replace(/[-]/g, '_');
  if (procName.includes('mission_controller') || procName === 'controller') return 'mission_controller';
  if (procName.includes('surface_runtime')) return 'surface_runtime';
  if (procName.includes('orchestrator')) return 'orchestrator';
  return procName || undefined;
}

export function inferPersonaFromRole(role?: string): Persona {
  if (!role) return 'unknown';
  return ROLE_PERSONA_DEFAULTS[role.toLowerCase().replace(/\s+/g, '_')] || 'unknown';
}

export function buildExecutionEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  role?: string,
  persona?: Persona,
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

export function withExecutionContext<T>(role: string, fn: () => T, persona?: Persona): T {
  const previousRole = process.env.MISSION_ROLE;
  const previousPersona = process.env.KYBERION_PERSONA;
  process.env.MISSION_ROLE = role;
  const resolvedPersona = persona || inferPersonaFromRole(role);
  if (resolvedPersona !== 'unknown') {
    process.env.KYBERION_PERSONA = resolvedPersona;
  } else if (persona === undefined) {
    delete process.env.KYBERION_PERSONA;
  }
  try {
    return fn();
  } finally {
    if (previousRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousRole;
    if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = previousPersona;
  }
}

function resolveSudoScope(): string[] | undefined {
  const raw = process.env.KYBERION_SUDO_SCOPE;
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
  return /^[a-z][a-z0-9-]{1,30}$/.test(trimmed) ? trimmed : undefined;
}

export function resolveIdentityContext(): IdentityContext {
  const missionId = process.env.MISSION_ID;
  const envPersona = process.env.KYBERION_PERSONA;
  const envRole = resolveRole();

  let persona: Persona = normalizePersona(envPersona);
  const authorities: Authority[] = [];
  let tenantSlug: string | undefined = normalizeTenantSlug(process.env.KYBERION_TENANT);
  let brokeredTenants: string[] | undefined;

  // 1. Resolve Persona (and tenantSlug / brokeredTenants) from Mission State.
  // Try the legacy no-tier path first, then fall back to tier-aware lookup
  // (covers active/missions/{personal,confidential,public}/{id}/...).
  if (missionId) {
    const candidates: string[] = [
      pathResolver.active(`missions/${missionId}/mission-state.json`),
    ];
    const tierPath = pathResolver.findMissionPath(missionId);
    if (tierPath) candidates.push(`${tierPath}/mission-state.json`);
    for (const statePath of candidates) {
      try {
        if (safeExistsSync(statePath)) {
          const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
          if (persona === 'unknown') persona = normalizePersona(state.assigned_persona);
          if (!tenantSlug) tenantSlug = normalizeTenantSlug(state.tenant_slug);
          const brokered = state.cross_tenant_brokerage?.source_tenants;
          if (Array.isArray(brokered) && brokered.length > 0) {
            const slugs = brokered
              .map((t: unknown) => normalizeTenantSlug(typeof t === 'string' ? t : undefined))
              .filter((t): t is string => !!t);
            if (slugs.length > 0) brokeredTenants = slugs;
          }
          break;
        }
      } catch (_) {}
    }
  }

  // 2. Default Persona from process name if still unknown
  if (persona === 'unknown' && envRole) {
    persona = inferPersonaFromRole(envRole);
  }

  if (persona === 'unknown') {
    const argv1 = process.argv[1] || '';
    const procName = path.basename(argv1, path.extname(argv1)).toLowerCase().replace(/[-]/g, '_');
    if (procName.includes('orchestrator') || procName.includes('controller')) persona = 'ecosystem_architect';
  }

  // 3. Resolve Authorities
  
  // A. Persona-based intrinsic authorities
  if (persona === 'sovereign' || persona === 'ecosystem_architect') {
    authorities.push('GIT_WRITE', 'SECRET_READ', 'NETWORK_FETCH', 'SYSTEM_EXEC', 'KNOWLEDGE_WRITE');
  }

  // B. Temporal Grants (Role-based)
  const grantsPath = pathResolver.active('shared/auth-grants.json');
  if (safeExistsSync(grantsPath) && missionId) {
    try {
      const grants = JSON.parse(safeReadFile(grantsPath, { encoding: 'utf8' }) as string);
      const activeGrants = grants.filter((g: any) => 
        g.missionId === missionId && g.expiresAt > Date.now()
      );
      
      for (const grant of activeGrants) {
        if (grant.serviceId === 'github') authorities.push('GIT_WRITE', 'NETWORK_FETCH');
        if (grant.authority) authorities.push(grant.authority as Authority);
      }
    } catch (_) {}
  }

  // C. Environment Sudo Overrides
  if (process.env.KYBERION_SUDO === 'true') {
    authorities.push('SUDO');
  }

  return {
    persona,
    authorities: Array.from(new Set(authorities)),
    missionId,
    role: envRole,
    sudoScope: resolveSudoScope(),
    tenantSlug,
    ...(brokeredTenants ? { brokeredTenants } : {}),
  };
}

/**
 * Checks if the current context has a specific authority.
 */
export function hasAuthority(authority: Authority): boolean {
  const ctx = resolveIdentityContext();
  return ctx.authorities.includes('SUDO') || ctx.authorities.includes(authority);
}
