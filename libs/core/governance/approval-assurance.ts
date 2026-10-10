/**
 * HA-03: assurance levels of a human approval decision.
 *
 * A human-only decision declares how strongly its decider must be proven
 * (`accountability.min_assurance`); each `authMethod` provides a fixed level.
 * The table is an allow-list — an unknown method provides nothing.
 *
 * `surface_session` is A2 on the premise that the surface resolved a member
 * from a verified session. Surfaces that cannot (localadmin bearer, the
 * Chronos sovereign fallback) move to `local_admin_token` in HA-05.
 */
import { getRegisteredEnvText } from '../foundation/env.js';
import { resolvePolicyApprovalAssuranceMode } from './approval-policy.js';

export type ApprovalAssuranceLevel = 'A0' | 'A1' | 'A2' | 'A3';

export type ApprovalAuthMethod =
  | 'surface_session'
  | 'channel_identity'
  | 'terminal_attested'
  | 'totp'
  | 'passkey'
  | 'manual'
  | 'local_token'
  | 'local_admin_token';

export const APPROVAL_ASSURANCE_LEVELS: readonly ApprovalAssuranceLevel[] = [
  'A0',
  'A1',
  'A2',
  'A3',
];

export const APPROVAL_AUTH_METHOD_ASSURANCE: Readonly<
  Record<ApprovalAuthMethod, ApprovalAssuranceLevel>
> = {
  local_token: 'A0',
  local_admin_token: 'A1',
  manual: 'A1',
  channel_identity: 'A1',
  surface_session: 'A2',
  terminal_attested: 'A2',
  totp: 'A2',
  passkey: 'A3',
};

export const APPROVAL_AUTH_METHODS = Object.keys(
  APPROVAL_AUTH_METHOD_ASSURANCE
) as ApprovalAuthMethod[];

/**
 * Methods that prove possession of a local credential, not a person: refused
 * for a human-only decision in every rollout mode.
 */
export const NON_HUMAN_PROOF_AUTH_METHODS: ReadonlySet<ApprovalAuthMethod> = new Set([
  'local_token',
  'local_admin_token',
]);

export const DEFAULT_HUMAN_ONLY_MIN_ASSURANCE: ApprovalAssuranceLevel = 'A2';
/**
 * HA-07: decisions that must survive a compromised terminal accept only a
 * verified passkey assertion — dual-key secrets, policy changes (the
 * approval-policy rule `min_assurance`) and project trust.
 */
export const DUAL_KEY_MIN_ASSURANCE: ApprovalAssuranceLevel = 'A3';
export const PROJECT_TRUST_MIN_ASSURANCE: ApprovalAssuranceLevel = 'A3';

/**
 * Approval channels whose requests require at least this level at decision
 * time, whatever `min_assurance` the record was created with — so a request
 * still pending from before its class was raised is judged by today's rule
 * (decided records are never re-graded).
 */
export const APPROVAL_CHANNEL_MIN_ASSURANCE: Readonly<Record<string, ApprovalAssuranceLevel>> = {
  'project-trust': PROJECT_TRUST_MIN_ASSURANCE,
};

export type ApprovalAssuranceMode = 'warn' | 'enforce';

/**
 * Staged rollout: warn records a shortfall, enforce rejects it. The mode is
 * the stricter of `approval-policy.json` `assurance_mode` (governed) and
 * `KYBERION_APPROVAL_ASSURANCE`: the environment of the deciding process can
 * tighten the policy to enforce, never relax it. Neither set: warn.
 */
export function resolveApprovalAssuranceMode(
  env: Record<string, string | undefined> = process.env,
  policyMode: ApprovalAssuranceMode | undefined = resolvePolicyApprovalAssuranceMode()
): ApprovalAssuranceMode {
  if (policyMode === 'enforce') return 'enforce';
  return getRegisteredEnvText('KYBERION_APPROVAL_ASSURANCE', { env }) === 'enforce'
    ? 'enforce'
    : 'warn';
}

export function isApprovalAssuranceLevel(value: unknown): value is ApprovalAssuranceLevel {
  return typeof value === 'string' && (APPROVAL_ASSURANCE_LEVELS as string[]).includes(value);
}

export function isApprovalAuthMethod(value: unknown): value is ApprovalAuthMethod {
  return typeof value === 'string' && value in APPROVAL_AUTH_METHOD_ASSURANCE;
}

/** The level an auth method provides, or undefined for a method outside the allow-list. */
export function assuranceOfAuthMethod(authMethod: unknown): ApprovalAssuranceLevel | undefined {
  return isApprovalAuthMethod(authMethod) ? APPROVAL_AUTH_METHOD_ASSURANCE[authMethod] : undefined;
}

export function assuranceMeets(
  provided: ApprovalAssuranceLevel,
  required: ApprovalAssuranceLevel
): boolean {
  return APPROVAL_ASSURANCE_LEVELS.indexOf(provided) >= APPROVAL_ASSURANCE_LEVELS.indexOf(required);
}

export function strongerAssurance(
  left: ApprovalAssuranceLevel,
  right: ApprovalAssuranceLevel
): ApprovalAssuranceLevel {
  return assuranceMeets(left, right) ? left : right;
}

/**
 * HA-05: the auth method an HTTP surface may record, from the principal its
 * route resolved and whether that principal resolved to a member.
 * `surface_session` (A2) only for a member resolved from a verified session
 * (browser session, OIDC, a member-bound registry token). A localadmin / API
 * bearer, an agent principal, or no resolved member (the Chronos sovereign
 * fallback) is `local_admin_token`, which a human-only decision refuses. A
 * credential-free loopback viewer proves only local access: `manual` (A1).
 */
export function surfaceDecisionAuthMethod(
  principal: { provider: string; actor?: { kind?: string } } | null | undefined,
  memberResolved: boolean
): ApprovalAuthMethod {
  if (!principal || !memberResolved || principal.actor?.kind === 'agent')
    return 'local_admin_token';
  switch (principal.provider) {
    case 'browser-session':
    case 'oidc-jwt':
    case 'registry-token':
      return 'surface_session';
    case 'loopback-local':
      return 'manual';
    default:
      return 'local_admin_token';
  }
}

export interface ApprovalAssuranceShortfall {
  required: ApprovalAssuranceLevel;
  provided: ApprovalAssuranceLevel;
  authMethod: ApprovalAuthMethod;
  mode: ApprovalAssuranceMode;
}
