/** Read a framework query/header value without allowing implicit coercion. */
export function readChronosStringParam(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readChronosOptionalStringParam(value: unknown): string | undefined {
  const normalized = readChronosStringParam(value);
  return normalized || undefined;
}
