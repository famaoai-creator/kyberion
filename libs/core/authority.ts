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

/**
 * Authority Manager v1.0
 * Resolves logical identity and temporal authorities for the current execution.
 */

export function resolveIdentityContext(): IdentityContext {
  const missionId = process.env.MISSION_ID;
  const envPersona = process.env.KYBERION_PERSONA as Persona;
  const envRole = process.env.MISSION_ROLE;

  let persona: Persona = envPersona || 'unknown';
  const authorities: Authority[] = [];

  // 1. Resolve Persona from Mission State if not in env
  if ((persona === 'unknown') && missionId) {
    const statePath = pathResolver.active(`missions/${missionId}/mission-state.json`);
    try {
      if (safeExistsSync(statePath)) {
        const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
        persona = (state.assigned_persona || 'unknown').toLowerCase().replace(/\s+/g, '_') as Persona;
      }
    } catch (_) {}
  }

  // 2. Default Persona from process name if still unknown
  if (persona === 'unknown') {
    const argv1 = process.argv[1] || '';
    const procName = path.basename(argv1, path.extname(argv1)).toLowerCase();
    if (procName.includes('orchestrator')) persona = 'ecosystem_architect';
    else if (procName.includes('controller')) persona = 'ecosystem_architect';
  }

  // 3. Resolve Authorities
  
  // A. Persona-based intrinsic authorities
  if (persona === 'sovereign' || persona === 'ecosystem_architect') {
    authorities.push('SUDO', 'GIT_WRITE', 'SECRET_READ', 'NETWORK_FETCH', 'SYSTEM_EXEC', 'KNOWLEDGE_WRITE');
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
    role: envRole
  };
}

/**
 * Checks if the current context has a specific authority.
 */
export function hasAuthority(authority: Authority): boolean {
  const ctx = resolveIdentityContext();
  return ctx.authorities.includes('SUDO') || ctx.authorities.includes(authority);
}
