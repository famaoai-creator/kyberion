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
export const DUAL_KEY_MIN_ASSURANCE: ApprovalAssuranceLevel = 'A3';

export type ApprovalAssuranceMode = 'warn' | 'enforce';

/** Staged rollout: warn (default) records a shortfall, enforce rejects it. */
export function resolveApprovalAssuranceMode(
  env: Record<string, string | undefined> = process.env
): ApprovalAssuranceMode {
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

export interface ApprovalAssuranceShortfall {
  required: ApprovalAssuranceLevel;
  provided: ApprovalAssuranceLevel;
  authMethod: ApprovalAuthMethod;
  mode: ApprovalAssuranceMode;
}
