/**
 * HA-07: a member's registered passkeys (WebAuthn credentials), one file per
 * member at `knowledge/personal/members/{member_id}/passkeys.json` — beside
 * the member profile, in the personal tier, never tenant-scoped (members are
 * not). Only public keys are stored. Callers run inside an authorized
 * personal-tier execution context, as with member-registry.ts.
 *
 * The file also carries the member's pending registration and step-up
 * challenges (single use, short TTL) and a random WebAuthn user handle, so no
 * member id or name reaches the authenticator as the user id.
 *
 * The file stays in the personal tier rather than the runtime floor: it is
 * gitignored, the knowledge index scans only Markdown, tenant ingest never
 * reads `knowledge/personal/members/`, and `sovereign_concierge` (the only
 * writer) already holds personal-tier write authority (role-write-access.json).
 */
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as pathResolver from '../path-resolver.js';
import { withLockSync } from '../lock-utils.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isRecord, readTextFile } from '../foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { isValidMemberId } from '../organization/member-id-grammar.js';

export const PASSKEY_MAX_CREDENTIALS_PER_MEMBER = 10;
export const PASSKEY_LABEL_MAX = 64;

export interface PasskeyCredential {
  /** base64url credential id (as the browser reports it). */
  credential_id: string;
  /** base64url COSE public key. */
  public_key: string;
  counter: number;
  transports?: string[];
  label: string;
  created_at: string;
  last_used_at?: string;
  /**
   * Before this instant the passkey cannot settle an A3 decision (enrollment
   * cooldown). Absent = usable since creation.
   */
  usable_after?: string;
  /** The usable passkey whose step-up authorized this enrollment, if any. */
  enrolled_with?: string;
}

export interface PasskeyPendingRegistration {
  challenge: string;
  expires_at: string;
  /** The usable passkey whose step-up authorized this enrollment. */
  stepped_up_with?: string;
  /** sha256 of that step-up's token; `verify` must present the token again. */
  step_up_token_hash?: string;
}

export type PasskeyStepUpPurpose = 'enroll' | 'revoke';

/** A step-up assertion in progress: one purpose, one member, single use. */
export interface PasskeyPendingStepUp {
  purpose: PasskeyStepUpPurpose;
  /** For `revoke`: the credential to remove. */
  target?: string;
  nonce: string;
  challenge: string;
  expires_at: string;
  claimed_at?: string;
  verified_at?: string;
  credential_id?: string;
  /** sha256 (base64url) of the step-up token handed to the confirming browser. */
  token_hash?: string;
}

export interface PasskeyCredentialFile {
  version: 1;
  member_id: string;
  /** base64url random WebAuthn user handle. */
  user_handle: string;
  credentials: PasskeyCredential[];
  pending_registration?: PasskeyPendingRegistration;
  pending_step_up?: PasskeyPendingStepUp;
}

/** What a listing shows — never the public key. */
export type PasskeyCredentialSummary = Omit<PasskeyCredential, 'public_key' | 'counter'>;

export interface PasskeyStorePathOptions {
  rootDir?: string;
}

function assertMember(memberId: string): void {
  if (!isValidMemberId(memberId) || memberId.startsWith('ext-')) {
    throw new Error(`[passkey-store] invalid member id '${memberId}'`);
  }
}

export function passkeyCredentialPath(
  memberId: string,
  options: PasskeyStorePathOptions = {}
): string {
  assertMember(memberId);
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  return path.join(rootDir, 'knowledge', 'personal', 'members', memberId, 'passkeys.json');
}

function safePath(memberId: string, options: PasskeyStorePathOptions): string {
  return assertSafeRepositoryPath(passkeyCredentialPath(memberId, options), {
    allowMissingLeaf: true,
    rootDir: options.rootDir,
  });
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function isCredential(value: unknown): value is PasskeyCredential {
  return (
    isRecord(value) &&
    typeof value.credential_id === 'string' &&
    BASE64URL.test(value.credential_id) &&
    typeof value.public_key === 'string' &&
    BASE64URL.test(value.public_key) &&
    typeof value.counter === 'number' &&
    Number.isInteger(value.counter) &&
    value.counter >= 0 &&
    typeof value.label === 'string' &&
    typeof value.created_at === 'string' &&
    (value.last_used_at === undefined || typeof value.last_used_at === 'string') &&
    (value.usable_after === undefined || typeof value.usable_after === 'string') &&
    (value.enrolled_with === undefined || typeof value.enrolled_with === 'string') &&
    (value.transports === undefined ||
      (Array.isArray(value.transports) &&
        value.transports.every((entry) => typeof entry === 'string')))
  );
}

function isPendingStepUp(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.purpose === 'enroll' || value.purpose === 'revoke') &&
    (value.target === undefined || typeof value.target === 'string') &&
    typeof value.nonce === 'string' &&
    typeof value.challenge === 'string' &&
    typeof value.expires_at === 'string' &&
    (value.token_hash === undefined || typeof value.token_hash === 'string')
  );
}

function assertFileShape(value: unknown, memberId: string): asserts value is PasskeyCredentialFile {
  const pending = isRecord(value) ? value.pending_registration : undefined;
  const stepUp = isRecord(value) ? value.pending_step_up : undefined;
  const ok =
    isRecord(value) &&
    value.version === 1 &&
    value.member_id === memberId &&
    typeof value.user_handle === 'string' &&
    BASE64URL.test(value.user_handle) &&
    Array.isArray(value.credentials) &&
    value.credentials.every(isCredential) &&
    (pending === undefined ||
      (isRecord(pending) &&
        typeof pending.challenge === 'string' &&
        typeof pending.expires_at === 'string')) &&
    (stepUp === undefined || isPendingStepUp(stepUp));
  if (!ok) throw new Error(`[passkey-store] passkey file for member '${memberId}' is malformed`);
}

/** The member's passkey file, or null when the member registered none yet. */
export function readPasskeyCredentialFile(
  memberId: string,
  options: PasskeyStorePathOptions = {}
): PasskeyCredentialFile | null {
  const file = safePath(memberId, options);
  if (!safeExistsSync(file)) return null;
  if (!safeLstat(file).isFile()) {
    throw new Error(`[passkey-store] passkey file for member '${memberId}' is not a regular file`);
  }
  const parsed = parseSafeJsonInput(readTextFile(file), `passkeys of member '${memberId}'`);
  assertFileShape(parsed, memberId);
  return parsed;
}

function writeFile(value: PasskeyCredentialFile, options: PasskeyStorePathOptions): void {
  assertFileShape(value, value.member_id);
  const file = safePath(value.member_id, options);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

/**
 * Read-modify-write the member's file under its lock. `next` is written when
 * returned; a throw leaves the file as it was.
 */
export function updatePasskeyCredentialFile<T>(
  memberId: string,
  options: PasskeyStorePathOptions,
  fn: (current: PasskeyCredentialFile) => { next?: PasskeyCredentialFile; result: T }
): T {
  assertMember(memberId);
  return withLockSync(`passkey-credentials-${memberId}`, () => {
    const current = readPasskeyCredentialFile(memberId, options) ?? {
      version: 1 as const,
      member_id: memberId,
      user_handle: randomBytes(16).toString('base64url'),
      credentials: [],
    };
    const { next, result } = fn(current);
    if (next) writeFile(next, options);
    return result;
  });
}

/** Whether the passkey may settle an A3 decision (or authorize a step-up) at `now`. */
export function isPasskeyUsable(credential: PasskeyCredential, now: Date = new Date()): boolean {
  return !credential.usable_after || Date.parse(credential.usable_after) <= now.getTime();
}

function summarize(credential: PasskeyCredential): PasskeyCredentialSummary {
  const { public_key: _publicKey, counter: _counter, ...summary } = credential;
  return summary;
}

export function listPasskeyCredentials(
  memberId: string,
  options: PasskeyStorePathOptions = {}
): PasskeyCredentialSummary[] {
  return (readPasskeyCredentialFile(memberId, options)?.credentials ?? []).map(summarize);
}

/** A credential of THIS member — another member's credential id is not found. */
export function findPasskeyCredential(
  memberId: string,
  credentialId: string,
  options: PasskeyStorePathOptions = {}
): PasskeyCredential | null {
  return (
    readPasskeyCredentialFile(memberId, options)?.credentials.find(
      (entry) => entry.credential_id === credentialId
    ) ?? null
  );
}

/** Store a fresh registration challenge (replacing any earlier one) and return the user handle. */
export function beginPasskeyRegistration(
  memberId: string,
  pending: PasskeyPendingRegistration,
  options: PasskeyStorePathOptions = {}
): { userHandle: string; existing: PasskeyCredential[] } {
  return updatePasskeyCredentialFile(memberId, options, (current) => {
    if (current.credentials.length >= PASSKEY_MAX_CREDENTIALS_PER_MEMBER) {
      throw new Error(
        `[POLICY_VIOLATION] member '${memberId}' already has ${PASSKEY_MAX_CREDENTIALS_PER_MEMBER} passkeys — revoke one first`
      );
    }
    return {
      next: { ...current, pending_registration: pending },
      result: { userHandle: current.user_handle, existing: current.credentials },
    };
  });
}

/** Take the pending registration challenge (single use): cleared whether or not it is still valid. */
export function takePendingPasskeyRegistration(
  memberId: string,
  now: Date = new Date(),
  options: PasskeyStorePathOptions = {}
): PasskeyPendingRegistration {
  return updatePasskeyCredentialFile(memberId, options, (current) => {
    const pending = current.pending_registration;
    if (!pending) {
      throw new Error('[POLICY_VIOLATION] no passkey registration is in progress — start again');
    }
    const { pending_registration: _taken, ...rest } = current;
    if (Date.parse(pending.expires_at) <= now.getTime()) {
      // Clear the stale challenge, then refuse.
      writeFile(rest, options);
      throw new Error('[POLICY_VIOLATION] passkey registration expired — start again');
    }
    return { next: rest, result: pending };
  });
}

export function addPasskeyCredential(
  memberId: string,
  credential: PasskeyCredential,
  options: PasskeyStorePathOptions = {}
): PasskeyCredentialSummary {
  if (!isCredential(credential)) throw new Error('[passkey-store] malformed passkey credential');
  return updatePasskeyCredentialFile(memberId, options, (current) => {
    if (current.credentials.some((entry) => entry.credential_id === credential.credential_id)) {
      throw new Error('[POLICY_VIOLATION] this passkey is already registered');
    }
    if (current.credentials.length >= PASSKEY_MAX_CREDENTIALS_PER_MEMBER) {
      throw new Error(
        `[POLICY_VIOLATION] member '${memberId}' already has ${PASSKEY_MAX_CREDENTIALS_PER_MEMBER} passkeys — revoke one first`
      );
    }
    return {
      next: { ...current, credentials: [...current.credentials, credential] },
      result: summarize(credential),
    };
  });
}

/** Remove a credential; false when the member has no such credential. */
export function revokePasskeyCredential(
  memberId: string,
  credentialId: string,
  options: PasskeyStorePathOptions = {}
): boolean {
  if (!readPasskeyCredentialFile(memberId, options)) return false;
  return updatePasskeyCredentialFile(memberId, options, (current) => {
    const remaining = current.credentials.filter((entry) => entry.credential_id !== credentialId);
    if (remaining.length === current.credentials.length) return { result: false };
    return { next: { ...current, credentials: remaining }, result: true };
  });
}

/**
 * Persist the signature counter an assertion reported. A counter that does not
 * move forward (when either side is non-zero) means a cloned authenticator or
 * a replayed assertion and is refused.
 */
export function recordPasskeyUse(
  memberId: string,
  credentialId: string,
  newCounter: number,
  now: Date = new Date(),
  options: PasskeyStorePathOptions = {}
): void {
  updatePasskeyCredentialFile(memberId, options, (current) => {
    const index = current.credentials.findIndex((entry) => entry.credential_id === credentialId);
    if (index < 0) {
      throw new Error(`[POLICY_VIOLATION] passkey is not registered to member '${memberId}'`);
    }
    const stored = current.credentials[index];
    if ((newCounter !== 0 || stored.counter !== 0) && newCounter <= stored.counter) {
      throw new Error(
        `[POLICY_VIOLATION] passkey signature counter did not advance (${newCounter} ≤ ${stored.counter}) — possible cloned authenticator`
      );
    }
    const credentials = [...current.credentials];
    credentials[index] = { ...stored, counter: newCounter, last_used_at: now.toISOString() };
    return { next: { ...current, credentials }, result: undefined };
  });
}
