/**
 * Actions — how a rendered component asks the producer to do something.
 *
 * A component carries an action descriptor in its props (`props.action`);
 * the host turns it into an HTTP call against the producer through a target
 * resolver. The descriptor shape matches the headless operation descriptors
 * the surfaces already publish (`operation_id`, `method`, `path`), so a
 * producer never has to write host-specific code.
 *
 * Policy lives here, not in the renderer: only producer-relative `/api/`
 * paths are accepted, methods are limited to GET/POST, and the body is
 * always JSON built from the descriptor plus explicit extra fields.
 */

export interface ActionDescriptor {
  operation_id: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  /** Re-read the current source after the action succeeded (default true). */
  refresh?: boolean;
  /** For input actions: the body field that receives the typed text (default `text`). */
  body_field?: string;
}

/** Producer-relative API path: `/api/...` with a conservative character set. */
export const ACTION_PATH_PATTERN = /^\/api\/[A-Za-z0-9/_\-.?=&%:]*$/u;
export const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,120}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Parse a descriptor from untrusted props; returns null when it is unusable. */
export function parseActionDescriptor(value: unknown): ActionDescriptor | null {
  if (!isRecord(value)) return null;
  const operationId = typeof value.operation_id === 'string' ? value.operation_id : '';
  const path = typeof value.path === 'string' ? value.path : '';
  const method =
    value.method === 'GET'
      ? 'GET'
      : value.method === 'POST' || value.method === undefined
        ? 'POST'
        : null;
  if (!method || !OPERATION_ID_PATTERN.test(operationId) || !ACTION_PATH_PATTERN.test(path))
    return null;
  const descriptor: ActionDescriptor = { operation_id: operationId, method, path };
  if (isRecord(value.body)) descriptor.body = value.body;
  if (typeof value.refresh === 'boolean') descriptor.refresh = value.refresh;
  if (typeof value.body_field === 'string' && /^[a-z_][a-z0-9_]{0,40}$/u.test(value.body_field)) {
    descriptor.body_field = value.body_field;
  }
  return descriptor;
}

export interface ActionResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Maps a producer-relative path to the URL the host should actually call. */
export type ActionTarget = (path: string) => string;

/**
 * Execute an action. `target` decides where producer-relative paths go (for
 * the viewer: the host's provider proxy). The result never throws on HTTP
 * errors — callers read `ok`/`status` and decide what to show.
 */
export async function runAction(
  fetchImpl: FetchLike,
  target: ActionTarget,
  action: ActionDescriptor,
  extra: Record<string, unknown> = {}
): Promise<ActionResult> {
  if (!ACTION_PATH_PATTERN.test(action.path)) {
    return { ok: false, status: 0, body: { error: 'action path not allowed' } };
  }
  const init: RequestInit = { method: action.method, headers: { Accept: 'application/json' } };
  if (action.method === 'POST') {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ ...(action.body ?? {}), ...extra });
  }
  try {
    const response = await fetchImpl(target(action.path), init);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON body: status alone is the result.
      body = null;
    }
    const envelopeOk = !(isRecord(body) && body.ok === false);
    return { ok: response.ok && envelopeOk, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: error instanceof Error ? error.message : 'network failure' },
    };
  }
}

/** Body for an input action: typed text under the configured field plus a request id. */
export function inputActionBody(
  action: ActionDescriptor,
  text: string,
  requestId: string
): Record<string, unknown> {
  return { [action.body_field ?? 'text']: text, request_id: requestId };
}
