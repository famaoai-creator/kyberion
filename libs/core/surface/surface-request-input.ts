/** Read a framework-shaped request value without coercing arrays or objects. */
export function readSurfaceStringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
