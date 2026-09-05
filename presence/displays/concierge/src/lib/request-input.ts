import { readJsonObjectRequest } from '@agent/core/foundation';

export type RequestInputObject = Record<string, unknown>;

export type RequestObjectResult =
  { ok: true; body: RequestInputObject } | { ok: false; error: string };

export class RequestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestInputError';
  }
}

export function requireRequestObject(value: unknown, field: string): RequestInputObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestInputError(`${field} must be an object`);
  }
  return value as RequestInputObject;
}

export function optionalRequestString(
  object: RequestInputObject,
  field: string
): string | undefined {
  if (!(field in object)) return undefined;
  if (typeof object[field] !== 'string') {
    throw new RequestInputError(`${field} must be a string`);
  }
  return object[field] as string;
}

export function requireKnownRequestKeys(
  object: RequestInputObject,
  allowedKeys: readonly string[],
  field = 'request body'
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(object).find(
    (key) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' || !allowed.has(key)
  );
  if (unknown) throw new RequestInputError(`${field}.${unknown} is not supported`);
}

export function requireKnownFormKeys(
  form: FormData,
  allowedKeys: readonly string[],
  field = 'form body'
): void {
  const allowed = new Set(allowedKeys);
  const seen = new Set<string>();
  for (const key of form.keys()) {
    if (!allowed.has(key)) throw new RequestInputError(`${field}.${key} is not supported`);
    if (seen.has(key)) throw new RequestInputError(`${field}.${key} must appear once`);
    seen.add(key);
  }
}

/** Read a Concierge JSON body without turning malformed input into an empty request. */
export async function readRequestObject(
  request: { json: () => Promise<unknown> },
  field = 'request body',
  allowedKeys?: readonly string[]
): Promise<RequestObjectResult> {
  const result = await readJsonObjectRequest(request, field);
  if (!result.ok) return result;
  try {
    if (allowedKeys) requireKnownRequestKeys(result.body, allowedKeys, field);
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
