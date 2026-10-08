/** Browser-only operator API. Never retain credentials or expose raw responses. */
export interface OperatorServiceDescriptor {
  serviceId: string;
  label: string;
  secretKey: 'ACCESS_TOKEN';
  authOperation: string;
  setupUrl: string;
  scopeNotice: string;
  credential_present: boolean;
}
export type OperatorError =
  | 'local_operator_required'
  | 'invalid_request'
  | 'approval_required'
  | 'recovery_required'
  | 'unavailable';
export type OperatorResult<T> = ({ ok: true } & T) | { ok: false; error: OperatorError };
export type OperatorProbeStatus =
  | 'authenticated'
  | 'credential_missing'
  | 'credential_shadowed'
  | 'authentication_failed'
  | 'unavailable'
  | 'unsupported';
export type OperatorProposal = { approvalId: string; status: 'approved' | 'pending' };
export type OperatorProbe = { serviceId: string; status: OperatorProbeStatus; checkedAt: string };

const endpoint = '/api/services/operator';
const errors: readonly string[] = [
  'local_operator_required',
  'invalid_request',
  'approval_required',
  'recovery_required',
  'unavailable',
];
const probeStatuses: readonly string[] = [
  'authenticated',
  'credential_missing',
  'credential_shadowed',
  'authentication_failed',
  'unavailable',
  'unsupported',
];
const unavailable = (): { ok: false; error: OperatorError } => ({
  ok: false,
  error: 'unavailable',
});
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function safeSetupUrl(value: unknown): value is string {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function parseOperatorServices(value: unknown): OperatorServiceDescriptor[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const services: OperatorServiceDescriptor[] = [];
  for (const row of value) {
    if (
      !record(row) ||
      !text(row.serviceId) ||
      !/^[a-z][a-z0-9_-]*$/.test(row.serviceId) ||
      seen.has(row.serviceId) ||
      !text(row.label) ||
      row.secretKey !== 'ACCESS_TOKEN' ||
      !text(row.authOperation) ||
      !safeSetupUrl(row.setupUrl) ||
      !text(row.scopeNotice) ||
      typeof row.credential_present !== 'boolean'
    )
      return null;
    seen.add(row.serviceId);
    services.push({
      serviceId: row.serviceId,
      label: row.label,
      secretKey: row.secretKey,
      authOperation: row.authOperation,
      setupUrl: row.setupUrl,
      scopeNotice: row.scopeNotice,
      credential_present: row.credential_present,
    });
  }
  return services;
}

async function request(
  body?: Record<string, string>,
  signal?: AbortSignal
): Promise<OperatorResult<Record<string, unknown>>> {
  try {
    const response = await fetch(endpoint, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
      ...(body
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const value: unknown = await response.json();
    if (!record(value)) return unavailable();
    if (!response.ok || value.ok !== true) {
      return {
        ok: false,
        error:
          typeof value.error === 'string' && errors.includes(value.error)
            ? (value.error as OperatorError)
            : 'unavailable',
      };
    }
    return { ...value, ok: true };
  } catch {
    return unavailable();
  }
}

export async function fetchOperatorServices(
  signal?: AbortSignal
): Promise<OperatorResult<{ services: OperatorServiceDescriptor[] }>> {
  const result = await request(undefined, signal);
  if (!result.ok) return result;
  const services = parseOperatorServices(result.services);
  return services ? { ok: true, services } : unavailable();
}

export async function proposeOperatorService(
  serviceId: string,
  signal?: AbortSignal
): Promise<OperatorResult<OperatorProposal>> {
  const result = await request({ action: 'propose', serviceId }, signal);
  if (!result.ok) return result;
  return text(result.approvalId) && (result.status === 'approved' || result.status === 'pending')
    ? { ok: true, approvalId: result.approvalId, status: result.status }
    : unavailable();
}

/** The only call carrying a token; send it once, without storage, logging, or retries. */
export async function applyOperatorService(
  serviceId: string,
  approvalId: string,
  value: string,
  signal?: AbortSignal
): Promise<OperatorResult<{ serviceId: string; status: 'registered' }>> {
  const result = await request({ action: 'apply', serviceId, approvalId, value }, signal);
  if (!result.ok) return result;
  return result.serviceId === serviceId && result.status === 'registered'
    ? { ok: true, serviceId, status: 'registered' }
    : unavailable();
}

export async function probeOperatorService(
  serviceId: string,
  signal?: AbortSignal
): Promise<OperatorResult<OperatorProbe>> {
  const result = await request({ action: 'probe', serviceId }, signal);
  if (!result.ok) return result;
  return result.serviceId === serviceId &&
    typeof result.status === 'string' &&
    probeStatuses.includes(result.status) &&
    text(result.checkedAt) &&
    /^\d{4}-\d{2}-\d{2}T/.test(result.checkedAt) &&
    Number.isFinite(Date.parse(result.checkedAt))
    ? {
        ok: true,
        serviceId,
        status: result.status as OperatorProbeStatus,
        checkedAt: new Date(result.checkedAt).toISOString(),
      }
    : unavailable();
}

/** One request per card; cancelled/unmounted generations can never update the next flow. */
export function createOperatorRequestGuard() {
  let active: AbortController | null = null;
  return {
    begin() {
      if (active) return null;
      const controller = new AbortController();
      active = controller;
      return {
        signal: controller.signal,
        current: () => active === controller && !controller.signal.aborted,
        finish: () => {
          if (active === controller) active = null;
        },
      };
    },
    cancel() {
      active?.abort();
      active = null;
    },
  };
}

/** Refresh only the exact reviewed approval; never create a replacement implicitly. */
export async function checkOperatorApproval(
  serviceId: string,
  approvalId: string,
  signal?: AbortSignal
): Promise<OperatorResult<OperatorProposal>> {
  const result = await request({ action: 'status', serviceId, approvalId }, signal);
  if (!result.ok) return result;
  return result.approvalId === approvalId &&
    (result.status === 'approved' || result.status === 'pending')
    ? { ok: true, approvalId, status: result.status }
    : unavailable();
}
