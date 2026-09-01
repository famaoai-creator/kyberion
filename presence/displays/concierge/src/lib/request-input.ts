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

/** Read a Concierge JSON body without turning malformed input into an empty request. */
export async function readRequestObject(
  request: { json: () => Promise<unknown> },
  field = 'request body',
  allowedKeys?: readonly string[]
): Promise<RequestObjectResult> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: `${field} must be valid JSON` };
  }
  try {
    const body = requireRequestObject(raw, field);
    if (allowedKeys) requireKnownRequestKeys(body, allowedKeys, field);
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
