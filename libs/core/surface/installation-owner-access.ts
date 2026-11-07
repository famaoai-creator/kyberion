/**
 * installation-owner-access — who may read or change settings of the whole
 * machine (installation scope: operator service credentials, the owner's
 * personal profile and avatar, personal onboarding authority, …).
 *
 * Authorization is by identity and assurance; the transport is only a factor:
 *
 *   READ  — the installation owner, on any transport.
 *   WRITE — the installation owner AND (a trusted loopback peer OR a passkey
 *           step-up this session verified within INSTALLATION_STEP_UP_WINDOW_MS).
 *
 * The installation owner is an authenticated human principal (token / OIDC
 * source, role `localadmin`, assurance above `none`, not expired) whose member id is the local
 * owner member (`FIRST_RUN_DEFAULT_MEMBER_ID`) and whose member profile is
 * `active`. A credential-less loopback request is NOT the owner: it is
 * admitted only while bootstrap is open (first-run setup unclaimed and no
 * owner can sign in yet), or when the operator turned on the default-off
 * escape hatch {@link INSTALLATION_ANONYMOUS_LOOPBACK_ENV}.
 *
 * Every input is server-resolved evidence — the verified principal, the
 * transport adapter's loopback attestation, the session binding the adapter
 * derives from the presented credential, and the server-side step-up record.
 * No request parameter reaches this decision.
 *
 * Model: knowledge/product/governance/installation-owner-authorization.md
 */
import type { ResolvedPrincipal } from '../authn/authn-principal-resolver.js';
import {
  INSTALLATION_STEP_UP_WINDOW_MS,
  readFreshInstallationStepUp,
} from '../authn/installation-step-up.js';
import { withExecutionContext } from '../authority.js';
import { getRegisteredEnvBool, isVitestProcess } from '../foundation/env.js';
import { auditChain } from '../governance/audit-chain.js';
import { createLogger } from '../logger.js';
import { readMemberProfile, type MemberProfile } from '../organization/member-registry.js';
import { FIRST_RUN_DEFAULT_MEMBER_ID, readFirstRunStatus } from './first-run-setup.js';
import {
  installationBootstrapGeneration,
  signalInstallationBootstrapChange,
} from './installation-bootstrap-signal.js';

const logger = createLogger('installation-owner-access');

export { INSTALLATION_STEP_UP_WINDOW_MS };

/** The member that owns this installation (`is_local_owner`). */
export const INSTALLATION_OWNER_MEMBER_ID = FIRST_RUN_DEFAULT_MEMBER_ID;

/** Default-off escape hatch: credential-less loopback stays an operator after bootstrap. */
export const INSTALLATION_ANONYMOUS_LOOPBACK_ENV = 'KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK';

/** Principal id given to a credential-less loopback operator (bootstrap / escape hatch). */
export const ANONYMOUS_LOOPBACK_PRINCIPAL_ID = 'human:concierge-localadmin';

export type InstallationAccessMode = 'read' | 'write';

export type InstallationAccessDenialCode =
  'authentication_required' | 'installation_owner_required' | 'installation_step_up_required';

export type InstallationAccessBasis =
  'installation_owner' | 'bootstrap_loopback' | 'anonymous_loopback_override';

export interface InstallationOwnerGrant {
  readonly allowed: true;
  readonly mode: InstallationAccessMode;
  readonly basis: InstallationAccessBasis;
  /** Audit actor: `user:owner`, or the anonymous loopback operator. */
  readonly actorId: string;
  /** Stable principal id for request/approval binding. */
  readonly principalId: string;
  readonly transport: 'loopback' | 'remote';
  /** A fresh passkey step-up was what admitted this write. */
  readonly stepUp: boolean;
  readonly memberId?: string;
}

export interface InstallationOwnerDenial {
  readonly allowed: false;
  readonly mode: InstallationAccessMode;
  readonly status: 401 | 403;
  readonly code: InstallationAccessDenialCode;
  readonly reason: string;
  readonly transport: 'loopback' | 'remote';
  /** Set when the denied principal was authenticated (audit actor). */
  readonly actorId?: string;
}

export type InstallationOwnerDecision = InstallationOwnerGrant | InstallationOwnerDenial;

/** Every fact the decision depends on — all resolved server-side. */
export interface InstallationOwnerFacts {
  mode: InstallationAccessMode;
  /** The verified principal, or null/undefined when the request carried no credential. */
  principal?: ResolvedPrincipal | null;
  /** The transport adapter proved a direct loopback peer (never a header). */
  trustedLoopback: boolean;
  /** Status of the installation owner's member profile (null: missing / unreadable). */
  ownerMemberStatus: MemberProfile['status'] | null;
  /** First-run setup still open and no owner can sign in yet. */
  bootstrapOpen: boolean;
  /** {@link INSTALLATION_ANONYMOUS_LOOPBACK_ENV} is on. */
  anonymousLoopbackOverride: boolean;
  /** When this session's installation step-up was verified (server-side record), if any. */
  stepUpVerifiedAt?: string | null;
  now: number;
  stepUpWindowMs?: number;
}

/** A credential-less (loopback-local / stub) principal — never an identity. */
export function isAnonymousPrincipal(principal: ResolvedPrincipal | null | undefined): boolean {
  return (
    !principal ||
    principal.provider === 'loopback-local' ||
    principal.provider === 'stub' ||
    principal.source === 'loopback' ||
    principal.source === 'anonymous'
  );
}

function deny(
  facts: InstallationOwnerFacts,
  status: 401 | 403,
  code: InstallationAccessDenialCode,
  reason: string,
  actorId?: string
): InstallationOwnerDenial {
  return {
    allowed: false,
    mode: facts.mode,
    status,
    code,
    reason,
    transport: facts.trustedLoopback ? 'loopback' : 'remote',
    ...(actorId ? { actorId } : {}),
  };
}

/** The pure decision table (see the module comment). */
export function evaluateInstallationOwnerAccess(
  facts: InstallationOwnerFacts
): InstallationOwnerDecision {
  const transport = facts.trustedLoopback ? 'loopback' : 'remote';
  const principal = facts.principal ?? null;

  if (isAnonymousPrincipal(principal)) {
    if (facts.trustedLoopback && (facts.bootstrapOpen || facts.anonymousLoopbackOverride)) {
      return {
        allowed: true,
        mode: facts.mode,
        basis: facts.bootstrapOpen ? 'bootstrap_loopback' : 'anonymous_loopback_override',
        actorId: ANONYMOUS_LOOPBACK_PRINCIPAL_ID,
        principalId: ANONYMOUS_LOOPBACK_PRINCIPAL_ID,
        transport,
        stepUp: false,
      };
    }
    return deny(
      facts,
      401,
      'authentication_required',
      'sign in as the installation owner (anonymous local access ends once an owner is bound)'
    );
  }

  const ownerActorId = `user:${INSTALLATION_OWNER_MEMBER_ID}`;
  const actorId = principal!.actor?.id;
  if (principal!.expiresAt) {
    const expires = Date.parse(principal!.expiresAt);
    if (!Number.isFinite(expires) || expires <= facts.now) {
      return deny(facts, 401, 'authentication_required', 'credential expired', actorId);
    }
  }
  if (
    principal!.actor?.kind !== 'human' ||
    (principal!.source !== 'token' && principal!.source !== 'oidc') ||
    principal!.assurance === 'none' ||
    // The full owner registration: a readonly or narrowed-role credential
    // bound to the owner member is not installation authority.
    principal!.role !== 'localadmin' ||
    principal!.memberId !== INSTALLATION_OWNER_MEMBER_ID ||
    actorId !== ownerActorId
  ) {
    return deny(
      facts,
      403,
      'installation_owner_required',
      'only the installation owner may use installation-scope settings',
      actorId
    );
  }
  if (facts.ownerMemberStatus !== 'active') {
    return deny(
      facts,
      403,
      'installation_owner_required',
      'the installation owner member is not active',
      actorId
    );
  }

  const grant = (stepUp: boolean): InstallationOwnerGrant => ({
    allowed: true,
    mode: facts.mode,
    basis: 'installation_owner',
    actorId: ownerActorId,
    principalId: ownerActorId,
    transport,
    stepUp,
    memberId: INSTALLATION_OWNER_MEMBER_ID,
  });
  if (facts.mode === 'read' || facts.trustedLoopback) return grant(false);

  const windowMs = facts.stepUpWindowMs ?? INSTALLATION_STEP_UP_WINDOW_MS;
  const verified = facts.stepUpVerifiedAt ? Date.parse(facts.stepUpVerifiedAt) : NaN;
  if (Number.isFinite(verified) && verified <= facts.now && facts.now - verified <= windowMs) {
    return grant(true);
  }
  return deny(
    facts,
    403,
    'installation_step_up_required',
    'confirm with your passkey to change installation settings from another device',
    actorId
  );
}

// ---------------------------------------------------------------------------
// Evidence gathering (impure)
// ---------------------------------------------------------------------------

export interface InstallationAccessOptions {
  /** Member / tenant / passkey registry root (hermetic tests). */
  rootDir?: string;
  env?: Record<string, string | undefined>;
  now?: number;
  /** Test seam: override the bootstrap probe. */
  bootstrapOpen?: boolean;
}

const BOOTSTRAP_CACHE_MS = 5_000;
let bootstrapCache: { open: boolean; at: number; rootDir?: string; generation: number } | null =
  null;

/**
 * Forget the cached bootstrap probe. Credential writers signal this through
 * installation-bootstrap-signal.ts; tests call it directly.
 */
export function resetInstallationBootstrapCache(): void {
  bootstrapCache = null;
  signalInstallationBootstrapChange();
}

/**
 * Whether bootstrap is still open: first-run setup unclaimed and no owner can
 * sign in yet (first-run-setup.ts `readFirstRunStatus`). Fails closed. The
 * probe reads the member registry, so it is cached briefly per process.
 */
export function installationBootstrapOpen(options: InstallationAccessOptions = {}): boolean {
  if (options.bootstrapOpen !== undefined) return options.bootstrapOpen;
  const now = options.now ?? Date.now();
  if (
    bootstrapCache &&
    bootstrapCache.rootDir === options.rootDir &&
    bootstrapCache.generation === installationBootstrapGeneration() &&
    now - bootstrapCache.at >= 0 &&
    now - bootstrapCache.at < BOOTSTRAP_CACHE_MS
  ) {
    return bootstrapCache.open;
  }
  let open = false;
  try {
    // System scope (tenant cleared): the first-run document and member
    // registry are installation-wide, read before any viewer exists.
    open =
      withExecutionContext(
        'sovereign_concierge',
        () => readFirstRunStatus(options.rootDir ? { rootDir: options.rootDir } : {}),
        undefined,
        ''
      ).state === 'unclaimed';
  } catch {
    open = false;
  }
  bootstrapCache = {
    open,
    at: now,
    rootDir: options.rootDir,
    generation: installationBootstrapGeneration(),
  };
  return open;
}

let overrideWarned = false;

/** {@link INSTALLATION_ANONYMOUS_LOOPBACK_ENV}; warns once per process while it is on. */
export function anonymousLoopbackOverrideEnabled(
  env?: Record<string, string | undefined>
): boolean {
  const on =
    getRegisteredEnvBool(INSTALLATION_ANONYMOUS_LOOPBACK_ENV, env ? { env } : undefined) === true;
  if (on && !overrideWarned) {
    overrideWarned = true;
    logger.warn(
      'anonymous loopback admitted as installation operator — ' +
        `${INSTALLATION_ANONYMOUS_LOOPBACK_ENV} is on, so any local process or OS user reaches ` +
        'installation settings without signing in | next: unset it once the automation ' +
        'authenticates as the installation owner | evidence: ' +
        `env ${INSTALLATION_ANONYMOUS_LOOPBACK_ENV}=1`
    );
  }
  return on;
}

/** Whether a credential-less loopback request may still act as the local operator. */
export function anonymousLoopbackAllowed(options: InstallationAccessOptions = {}): boolean {
  return anonymousLoopbackOverrideEnabled(options.env) || installationBootstrapOpen(options);
}

function ownerMemberStatus(options: InstallationAccessOptions): MemberProfile['status'] | null {
  try {
    return (
      withExecutionContext(
        'sovereign_concierge',
        () =>
          readMemberProfile(
            INSTALLATION_OWNER_MEMBER_ID,
            options.rootDir ? { rootDir: options.rootDir } : {}
          ),
        undefined,
        ''
      )?.status ?? null
    );
  } catch {
    return null;
  }
}

function stepUpVerifiedAt(
  sessionBinding: string | undefined,
  options: InstallationAccessOptions,
  now: number
): string | null {
  if (!sessionBinding) return null;
  try {
    return withExecutionContext(
      'sovereign_concierge',
      () =>
        readFreshInstallationStepUp(
          INSTALLATION_OWNER_MEMBER_ID,
          sessionBinding,
          { now: new Date(now) },
          options.rootDir ? { rootDir: options.rootDir } : {}
        ),
      undefined,
      ''
    );
  } catch {
    return null;
  }
}

const issuedGrants = new WeakSet<object>();

/**
 * True only for a grant {@link resolveInstallationOwnerAccess} issued in this
 * process — a copied or hand-built object never passes. Core gates
 * (operator-service-connection) accept installation authority only this way.
 */
export function isIssuedInstallationOwnerGrant(
  value: unknown,
  mode: InstallationAccessMode = 'read'
): value is InstallationOwnerGrant {
  return (
    typeof value === 'object' &&
    value !== null &&
    issuedGrants.has(value) &&
    (mode === 'read' || (value as InstallationOwnerGrant).mode === 'write')
  );
}

export interface InstallationAccessRequest {
  mode: InstallationAccessMode;
  principal?: ResolvedPrincipal | null;
  trustedLoopback: boolean;
  /** Adapter-derived binding of the presented credential (step-up lookup). */
  sessionBinding?: string;
}

/** Gather the server-side facts and decide. Grants are frozen and registered. */
export function resolveInstallationOwnerAccess(
  request: InstallationAccessRequest,
  options: InstallationAccessOptions = {}
): InstallationOwnerDecision {
  const now = options.now ?? Date.now();
  const anonymous = isAnonymousPrincipal(request.principal);
  const facts: InstallationOwnerFacts = {
    mode: request.mode,
    principal: request.principal ?? null,
    trustedLoopback: request.trustedLoopback,
    ownerMemberStatus: anonymous ? null : ownerMemberStatus(options),
    bootstrapOpen:
      anonymous && request.trustedLoopback ? installationBootstrapOpen(options) : false,
    anonymousLoopbackOverride:
      anonymous && request.trustedLoopback ? anonymousLoopbackOverrideEnabled(options.env) : false,
    stepUpVerifiedAt:
      !anonymous && request.mode === 'write' && !request.trustedLoopback
        ? stepUpVerifiedAt(request.sessionBinding, options, now)
        : null,
    now,
  };
  const decision = Object.freeze(evaluateInstallationOwnerAccess(facts));
  if (decision.allowed) issuedGrants.add(decision);
  return decision;
}

export interface InstallationAccessAuditEvent {
  surface: string;
  operation: string;
  decision: InstallationOwnerDecision;
}

/**
 * Audit an installation-scope write: actor, transport and whether a step-up
 * admitted it. Returns false when the record could not be written — callers
 * must then refuse an admitted write (fail closed). Skipped (true) under
 * Vitest unless a recorder is injected.
 */
export function recordInstallationAccessAudit(
  event: InstallationAccessAuditEvent,
  recorder?: (entry: Parameters<typeof auditChain.record>[0]) => void
): boolean {
  const { decision } = event;
  const grant = decision.allowed === true ? (decision as InstallationOwnerGrant) : undefined;
  const denial = decision.allowed === true ? undefined : (decision as InstallationOwnerDenial);
  const entry: Parameters<typeof auditChain.record>[0] = {
    agentId: decision.actorId || 'anonymous',
    action: 'installation_scope_write',
    operation: event.operation,
    result: decision.allowed ? 'allowed' : 'denied',
    reason: grant ? `installation-scope write admitted (${grant.basis})` : denial!.reason,
    metadata: {
      surface: event.surface,
      transport: decision.transport,
      step_up: grant ? grant.stepUp : false,
      ...(grant ? { basis: grant.basis } : { error_code: denial!.code }),
    },
  };
  try {
    if (recorder) {
      recorder(entry);
      return true;
    }
    if (isVitestProcess()) return true;
    auditChain.record(entry);
    return true;
  } catch {
    return false;
  }
}
