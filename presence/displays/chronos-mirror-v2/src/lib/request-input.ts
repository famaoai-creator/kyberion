export type JsonObjectRequest = {
  json: () => Promise<unknown>;
};

export type JsonObjectResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Read a route body without allowing malformed JSON or non-object values to reach mutation logic. */
export async function readChronosJsonObject(
  request: JsonObjectRequest,
  resource: string
): Promise<JsonObjectResult> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: `${resource} request body must be valid JSON.` };
  }
  if (!isJsonObject(raw)) {
    return { ok: false, error: `${resource} request body must be a JSON object.` };
  }
  return { ok: true, body: raw };
}
