import { conciergeText, type ConciergeLocale, type ConciergeMessageKey } from './i18n';

// This browser boundary deliberately does not import the server's wire-error
// module (node:crypto), or expose its message, stack, correlation ID or extras.
const WIRE_CODES = [
  'busy',
  'session_locked',
  'not_found',
  'invalid_request',
  'not_implemented',
  'internal',
] as const;
type WireCode = (typeof WIRE_CODES)[number];

function safeCode(payload: unknown): WireCode | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  if (!Object.hasOwn(payload, 'error_code')) return undefined;
  const code = (payload as Record<string, unknown>).error_code;
  return WIRE_CODES.find((allowed) => code === allowed);
}

class ApprovalResponseFailure extends Error {
  readonly status: number | undefined;
  readonly code: WireCode | 'request_failed';

  constructor(status: number, payload: unknown) {
    super('Approval response was not successful');
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
    this.code = safeCode(payload) ?? 'request_failed';
  }
}

/** Project only the documented, finite error-code contract and HTTP status. */
export function approvalResponseFailure(status: number, payload: unknown): Error {
  return new ApprovalResponseFailure(status, payload);
}

const ERROR_BODY_LIMIT_BYTES = 4096;
const ERROR_BODY_TIMEOUT_MS = 1000;

async function readBoundedPayload(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<unknown> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return JSON.parse(text + decoder.decode()) as unknown;
    bytes += chunk.value.byteLength;
    if (bytes > ERROR_BODY_LIMIT_BYTES) return null;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

/**
 * Diagnostic-only read: bound time and bytes, discard every field except a
 * known code, and release the response stream. Never abort or repeat the POST.
 * HTML, malformed JSON and stalled/failed bodies use the same status fallback.
 */
export async function readApprovalResponseFailure(response: Response): Promise<Error> {
  let payload: unknown = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.body?.getReader();
    if (reader) {
      payload = await Promise.race([
        readBoundedPayload(reader),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ERROR_BODY_TIMEOUT_MS);
        }),
      ]);
    }
  } catch {
    // A diagnostic failure must never mask the HTTP result or leak its cause.
  } finally {
    clearTimeout(timer);
    if (reader) {
      // Cancellation concerns only the response body, not request dispatch.
      // Do not await a potentially stalled underlying source's cancel hook.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return approvalResponseFailure(response.status, payload);
}

/** Never render arbitrary exceptions, including passkey, transport or refresh errors. */
export function formatApprovalFailure(error: unknown, locale: ConciergeLocale): string {
  const failure = error instanceof ApprovalResponseFailure ? error : undefined;
  const status = failure?.status;
  const code = failure?.code ?? 'result_unconfirmed';
  let key: ConciergeMessageKey = 'home.approval_failure_unconfirmed';
  if (status === 401) key = 'home.approval_failure_auth';
  else if (status === 403) key = 'home.approval_failure_access';
  else if (status === 429 || code === 'busy' || code === 'session_locked')
    key = 'home.approval_failure_busy';
  else if (status === 404 || status === 410 || code === 'not_found')
    key = 'home.approval_failure_missing';
  else if (code === 'invalid_request' || status === 400 || status === 422)
    key = 'home.approval_failure_invalid';
  else if (code === 'not_implemented') key = 'home.approval_failure_unsupported';
  const diagnostic = status ? `HTTP ${status}; ${code}` : code;
  return conciergeText('home.approval_failure_notice', locale, {
    guidance: conciergeText(key, locale),
    diagnostic,
  });
}
