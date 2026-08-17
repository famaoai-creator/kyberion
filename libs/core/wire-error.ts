import { randomUUID } from 'node:crypto';

export type WireErrorCode =
  'busy' | 'session_locked' | 'not_found' | 'invalid_request' | 'not_implemented' | 'internal';

export interface WireSafeError {
  code: WireErrorCode;
  message: string;
  correlation_id: string;
}

const WIRE_MESSAGES: Record<WireErrorCode, string> = {
  busy: 'The server is busy. Try again later.',
  session_locked: 'The session is locked by another operation.',
  not_found: 'The requested resource was not found.',
  invalid_request: 'The request is invalid or not permitted.',
  not_implemented: 'This operation is not implemented.',
  internal: 'An internal error occurred. Use the correlation ID when contacting support.',
};

function errorDetails(error: unknown): { code?: unknown; status?: unknown; message: string } {
  if (error instanceof Error) {
    return {
      code: (error as NodeJS.ErrnoException).code,
      status: (error as Error & { status?: unknown }).status,
      message: error.message,
    };
  }
  if (typeof error === 'string') return { message: error };
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
    return {
      code: candidate.code,
      status: candidate.status,
      message: typeof candidate.message === 'string' ? candidate.message : '',
    };
  }
  return { message: '' };
}

function classifyWireCode(error: unknown): WireErrorCode {
  const details = errorDetails(error);
  const status = Number(details.status);
  const message = details.message.toLowerCase();
  const code = String(details.code ?? '').toLowerCase();

  if (status === 404 || code === 'enotfound' || /\bnot found\b|missing resource/u.test(message)) {
    return 'not_found';
  }
  if (
    status === 423 ||
    code === 'session_locked' ||
    /session[_ ]locked|lease[_ ]held|already locked/u.test(message)
  ) {
    return 'session_locked';
  }
  if (
    status === 409 ||
    code === 'ebusy' ||
    /\bbusy\b|temporarily unavailable|try again later/u.test(message)
  ) {
    return 'busy';
  }
  if (
    status === 501 ||
    code === 'not_implemented' ||
    /not implemented|unsupported/u.test(message)
  ) {
    return 'not_implemented';
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 422 ||
    /invalid|malformed|denied|forbidden|unauthori[sz]ed|approval|required|policy_violation|tier_violation/u.test(
      message
    )
  ) {
    return 'invalid_request';
  }
  return 'internal';
}

/** Convert an internal exception to the deliberately small wire error contract. */
export function toWireError(error: unknown, correlationId: string = randomUUID()): WireSafeError {
  const code = classifyWireCode(error);
  return { code, message: WIRE_MESSAGES[code], correlation_id: correlationId };
}

/** Format a wire error for text transports without including the original error. */
export function formatWireError(error: unknown, prefix?: string, correlationId?: string): string {
  const safe = toWireError(error, correlationId ?? randomUUID());
  const body = `${safe.message} (correlation_id=${safe.correlation_id})`;
  return prefix ? `${prefix}: ${body}` : body;
}
