/**
 * Low-level environment boundary for foundational modules that cannot import
 * the registry-backed env loader without creating a path-resolver cycle.
 * Feature code must use `@agent/core/foundation/config` (`config.text` / `config.get`)
 * or `getRegisteredEnvText` instead.
 */
export function getProcessEnv(
  name: string,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env[name];
}

export function setProcessEnv(
  name: string,
  value: string | undefined,
  env: Record<string, string | undefined> = process.env
): void {
  if (value === undefined) delete env[name];
  else env[name] = value;
}
