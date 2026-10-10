import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { frontDeskFetch } from './front-desk-fetch';

/** HA-07: browser half of Concierge passkeys (registration + approval signing). */

export interface PasskeySummary {
  credential_id: string;
  label: string;
  created_at: string;
  last_used_at?: string;
  transports?: string[];
  /** Enrollment cooldown: the passkey can approve A3 requests from this time. */
  usable_after?: string;
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && browserSupportsWebAuthn();
}

async function postJson(
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await frontDeskFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !data || data.ok !== true) {
    throw new Error(String(data?.error ?? response.status));
  }
  return data;
}

export function parsePasskeyList(
  payload: unknown
): { member: boolean; passkeys: PasskeySummary[]; stepUpRequired: boolean } | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.passkeys)) return null;
  const passkeys = record.passkeys.filter(
    (entry): entry is PasskeySummary =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as PasskeySummary).credential_id === 'string' &&
      typeof (entry as PasskeySummary).label === 'string' &&
      typeof (entry as PasskeySummary).created_at === 'string'
  );
  return {
    member: record.member === true,
    passkeys,
    stepUpRequired: record.step_up_required === true,
  };
}

/** True while a passkey is still in its enrollment cooldown. */
export function passkeyCoolingDown(passkey: PasskeySummary, now = Date.now()): boolean {
  return Boolean(passkey.usable_after && Date.parse(passkey.usable_after) > now);
}

/**
 * Confirm a passkey change with an assertion from one of the member's usable
 * passkeys. Returns the single-use step-up token; it stays in memory for the
 * one change it authorizes and is never stored.
 */
async function confirmWithPasskey(
  purpose: 'enroll' | 'revoke',
  credentialId?: string
): Promise<string> {
  const started = await postJson('/api/me/passkeys', {
    action: 'step_up_options',
    purpose,
    ...(credentialId ? { credential_id: credentialId } : {}),
  });
  const response = await startAuthentication({
    optionsJSON: started.options as PublicKeyCredentialRequestOptionsJSON,
  });
  const confirmed = await postJson('/api/me/passkeys', { action: 'step_up_verify', response });
  if (typeof confirmed.step_up_token !== 'string' || !confirmed.step_up_token) {
    throw new Error('step-up was not confirmed');
  }
  return confirmed.step_up_token;
}

export async function registerPasskey(label: string, options: { stepUp: boolean }): Promise<void> {
  const stepUpToken = options.stepUp ? await confirmWithPasskey('enroll') : undefined;
  const withToken = stepUpToken ? { step_up_token: stepUpToken } : {};
  const started = await postJson('/api/me/passkeys', { action: 'options', ...withToken });
  const response = await startRegistration({
    optionsJSON: started.options as PublicKeyCredentialCreationOptionsJSON,
  });
  await postJson('/api/me/passkeys', { action: 'verify', response, label, ...withToken });
}

export async function revokePasskey(
  credentialId: string,
  options: { stepUp: boolean }
): Promise<void> {
  const stepUpToken = options.stepUp ? await confirmWithPasskey('revoke', credentialId) : undefined;
  await postJson('/api/me/passkeys', {
    action: 'revoke',
    credential_id: credentialId,
    ...(stepUpToken ? { step_up_token: stepUpToken } : {}),
  });
}

/** Sign one approval decision: challenge bound to the card → authenticator → server verify + record. */
export async function decideWithPasskey(input: {
  requestId: string;
  decision: 'approved' | 'rejected';
  channel?: string;
  storageChannel?: string;
  /** The digest of the card as shown; the server refuses a stale one. */
  presentedDigest?: string;
}): Promise<void> {
  if (!input.presentedDigest) {
    throw new Error('this request cannot be signed: reload the approval queue and try again');
  }
  const path = `/api/approvals/${encodeURIComponent(input.requestId)}/passkey`;
  const scope = {
    decision: input.decision,
    channel: input.channel,
    storageChannel: input.storageChannel,
  };
  const started = await postJson(path, {
    ...scope,
    action: 'options',
    presentedDigest: input.presentedDigest,
  });
  const response = await startAuthentication({
    optionsJSON: started.options as PublicKeyCredentialRequestOptionsJSON,
  });
  await postJson(path, {
    ...scope,
    action: 'verify',
    challengeId: started.challenge_id,
    response,
  });
}
