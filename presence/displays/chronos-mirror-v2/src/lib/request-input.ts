import {
  readJsonObjectRequest,
  type JsonObjectRequest as FoundationJsonObjectRequest,
} from '@agent/core/foundation';

export type JsonObjectRequest = FoundationJsonObjectRequest;

export type JsonObjectResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** Read a route body without allowing malformed JSON or non-object values to reach mutation logic. */
export async function readChronosJsonObject(
  request: JsonObjectRequest,
  resource: string
): Promise<JsonObjectResult> {
  return readJsonObjectRequest(request, `${resource} request body`);
}

/** Read a framework query/header value without allowing implicit coercion. */
export function readChronosStringParam(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readChronosOptionalStringParam(value: unknown): string | undefined {
  const normalized = readChronosStringParam(value);
  return normalized || undefined;
}
