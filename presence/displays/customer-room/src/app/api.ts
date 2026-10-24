/** The calls the page makes. The token travels only in the Authorization header. */
import { isAttachmentMediaType, MAX_ATTACHMENT_BYTES, type AnswerPayload } from './model.js';

export interface ApiResult {
  status: number;
  /** Parsed JSON, or null when the answer was not JSON. */
  body: Record<string, unknown> | null;
}

export type FetchFn = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    cache: 'no-store';
    credentials: 'omit';
    referrerPolicy: 'no-referrer';
  }
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  blob(): Promise<Blob>;
}>;

async function post(
  fetchFn: FetchFn,
  path: string,
  token: string,
  payload: Record<string, unknown>
): Promise<ApiResult> {
  try {
    const response = await fetchFn(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

export function viewAgenda(fetchFn: FetchFn, token: string): Promise<ApiResult> {
  return post(fetchFn, '/api/view', token, {});
}

export function respond(
  fetchFn: FetchFn,
  token: string,
  contentHash: string,
  answers: AnswerPayload[]
): Promise<ApiResult> {
  return post(fetchFn, '/api/respond', token, { content_hash: contentHash, answers });
}

/**
 * One image of the agenda as a Blob, or null when it cannot be shown (any
 * failure, a type outside png / jpeg / webp, or more than the size limit).
 */
export async function fetchAttachment(
  fetchFn: FetchFn,
  token: string,
  attachmentId: string
): Promise<Blob | null> {
  try {
    const response = await fetchFn('/api/attachment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ attachment_id: attachmentId }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const type = response.headers.get('content-type');
    if (response.status !== 200 || !isAttachmentMediaType(type)) return null;
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > MAX_ATTACHMENT_BYTES) return null;
    // The object URL carries the allowlisted type, never one the bytes suggest.
    return blob.type === type ? blob : new Blob([blob], { type });
  } catch {
    return null;
  }
}
