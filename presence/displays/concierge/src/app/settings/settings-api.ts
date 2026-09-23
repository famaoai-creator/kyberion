/**
 * UI-06 settings: the file / secret network calls the settings page makes,
 * lifted out of the components unchanged so the shared form components
 * (AvatarPicker, voice FileDrop, SecretField) feed the exact same governed
 * endpoints and payload shapes as before — and so tests can pin those shapes
 * against a mocked `fetch`.
 *
 * Nothing here stores, logs or echoes a file or secret value: a file goes
 * into one multipart body, a secret value into one JSON body, and only the
 * server's non-secret response fields come back.
 */

export type SetupUploadAction = 'avatar' | 'voice_sample';

/** `POST /api/setup` multipart — `action`, `profile_id`, `source`, `file`. */
export async function postSetupUpload(input: {
  action: SetupUploadAction;
  profileId: string;
  source: string;
  file: File;
}): Promise<Response> {
  const form = new FormData();
  form.set('action', input.action);
  form.set('profile_id', input.profileId);
  form.set('source', input.source);
  form.set('file', input.file);
  return fetch('/api/setup', { method: 'POST', body: form });
}

/** Normalize any Blob the avatar picker hands over into a named File. */
export function toUploadFile(blob: Blob, fallbackName: string): File {
  if (typeof File !== 'undefined' && blob instanceof File) return blob;
  return new File([blob], fallbackName, { type: blob.type || 'image/png' });
}

export interface SecretReadiness {
  secretKeys: string[];
  present: Record<string, boolean>;
}

/** `GET /api/secrets/introduce?serviceId=` — which keys exist and whether each is set (never a value). */
export async function fetchSecretReadiness(serviceId: string): Promise<SecretReadiness | null> {
  try {
    const response = await fetch(
      `/api/secrets/introduce?serviceId=${encodeURIComponent(serviceId)}`,
      { cache: 'no-store' }
    );
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      secretKeys?: unknown;
      readiness?: { identities?: Array<{ secretKey?: unknown; present?: unknown }> };
    } | null;
    if (!response.ok || !body?.ok) return null;
    const present: Record<string, boolean> = {};
    for (const row of body.readiness?.identities ?? []) {
      if (typeof row.secretKey === 'string') present[row.secretKey] = row.present === true;
    }
    const secretKeys = Array.isArray(body.secretKeys)
      ? body.secretKeys.filter((key): key is string => typeof key === 'string')
      : Object.keys(present);
    return { secretKeys, present };
  } catch {
    return null;
  }
}

export type SecretProposal =
  | {
      ok: true;
      approvalId: string;
      status: string;
      envName: string;
      storageChannel: string;
    }
  | { ok: false; error: string };

/** `POST /api/secrets/introduce` — propose only; the value is never part of this call. */
export async function proposeSecret(input: {
  serviceId: string;
  secretKey: string;
  reason: string;
}): Promise<SecretProposal> {
  const response = await fetch('/api/secrets/introduce', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serviceId: input.serviceId,
      secretKey: input.secretKey,
      reason: input.reason || `Introduce ${input.serviceId} ${input.secretKey}`,
      autoApprove: true,
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    approvalId?: string;
    status?: string;
    envName?: string;
    storageChannel?: string;
  } | null;
  if (!response.ok || !payload?.ok) {
    return { ok: false, error: payload?.error || `HTTP ${response.status}` };
  }
  return {
    ok: true,
    approvalId: payload.approvalId || '',
    status: payload.status || '',
    envName: payload.envName || '',
    storageChannel: payload.storageChannel || 'concierge',
  };
}

export type SecretApplyResult =
  { ok: true; status: string; envName: string } | { ok: false; error: string };

/** `POST /api/secrets/apply {approvalId, value, storageChannel, channel}` — the only call that carries the value. */
export async function applySecret(input: {
  approvalId: string;
  value: string;
  storageChannel: string;
}): Promise<SecretApplyResult> {
  const response = await fetch('/api/secrets/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      approvalId: input.approvalId,
      value: input.value,
      storageChannel: input.storageChannel,
      channel: input.storageChannel,
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    status?: string;
    envName?: string;
  } | null;
  if (!response.ok || !payload?.ok) {
    return { ok: false, error: payload?.error || `HTTP ${response.status}` };
  }
  return { ok: true, status: payload.status || '', envName: payload.envName || '' };
}
