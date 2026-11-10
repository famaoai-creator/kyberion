/**
 * Low-weight identity-context registry for the policy layer.
 *
 * `resolvePolicyIdentityContext` must be callable synchronously during
 * secure-io / tier-guard bootstrap, so it cannot sit behind the full seam
 * catalog (`identity-context-bridge.ts` → `seam.ts` → `invariants.ts`).
 * The sole-implementation registry lives here; the bridge keeps its seam
 * registration for catalog fidelity and mirrors every registration into
 * this resolver. Until a richer resolver arrives, the safe default below
 * answers — identical semantics to the previous bridge fallback.
 */
import type { Authority, IdentityContext } from '../types.js';
import { baseRoleEnvText } from './base-role-env.js';
import { getRegisteredEnvBool, getRegisteredEnvText } from './env.js';
import { resolveProjectScope } from './project-scope-env.js';
import { scopedAssumedRole, scopedPersona } from './execution-scope.js';

export type IdentityContextResolver = (tenantOverride?: string) => IdentityContext;

export interface ConfiguredActorIdentity {
  persona?: string;
  role?: string;
}

/** Read process-configured identity at an explicit boundary, independent of scoped overrides. */
export function readConfiguredActorIdentity(
  env?: Record<string, string | undefined>
): ConfiguredActorIdentity {
  return {
    persona: baseRoleEnvText(env),
    role: getRegisteredEnvText('MISSION_ROLE', { env }),
  };
}

// Match the seam catalog's module lifetime: a fresh module graph must not
// inherit a resolver whose authority module belonged to a discarded graph.
const resolverRegistry: { resolver?: IdentityContextResolver } = {};

function registry(): { resolver?: IdentityContextResolver } {
  return resolverRegistry;
}

/** Install the complete resolver; returns a restore for the previous one. */
export function registerPolicyIdentityResolver(next: IdentityContextResolver): () => void {
  const reg = registry();
  if (reg.resolver) {
    throw new Error('Identity context resolver is already registered');
  }
  const previous = reg.resolver;
  reg.resolver = next;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (reg.resolver === next) reg.resolver = previous;
  };
}

const defaultResolver: IdentityContextResolver = (tenantOverride) => {
  // RA-01: an in-process withExecutionContext* assumption outranks the env.
  const scoped = scopedPersona();
  const projectScope = resolveProjectScope();
  const configured = readConfiguredActorIdentity();
  const envPersona = scoped.bound ? scoped.persona : configured.persona;
  const persona =
    envPersona === 'sovereign' ||
    envPersona === 'ecosystem_architect' ||
    envPersona === 'mission_owner' ||
    envPersona === 'worker' ||
    envPersona === 'analyst'
      ? envPersona
      : 'unknown';
  const authorities: Authority[] =
    persona === 'sovereign' || persona === 'ecosystem_architect'
      ? ['GIT_WRITE', 'SECRET_READ', 'NETWORK_FETCH', 'SYSTEM_EXEC', 'KNOWLEDGE_WRITE']
      : [];
  if (getRegisteredEnvBool('KYBERION_SUDO')) authorities.push('SUDO');
  return {
    persona,
    executionMode:
      persona === 'sovereign'
        ? 'sovereign'
        : persona === 'ecosystem_architect'
          ? 'system'
          : 'mission',
    authorities,
    missionId: projectScope.missionId,
    role: scopedAssumedRole() || configured.role,
    tenantSlug: tenantOverride || projectScope.tenantSlug,
  };
};

/**
 * Tier policy needs identity synchronously, including during secure-io
 * bootstrap. Keep that low-level dependency pointed at a safe default until
 * authority has installed its complete resolver; this avoids making the
 * policy layer import the higher-level authority module.
 */
export function resolvePolicyIdentityContext(tenantOverride?: string): IdentityContext {
  return (registry().resolver ?? defaultResolver)(tenantOverride);
}
