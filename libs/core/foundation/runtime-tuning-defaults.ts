/**
 * Governed fallbacks for tunable environment settings whose values are shared
 * by more than one call site. The env registry (env-registry.json) declares
 * names and types; these constants are the single source for the default a
 * caller applies when the variable is unset. Keep values in lockstep with the
 * registry descriptions.
 */

/** Default for KYBERION_AGENT_BOOT_READY_TIMEOUT_MS. */
export const AGENT_BOOT_READY_TIMEOUT_MS_DEFAULT = 5000;

/** Default for KYBERION_RUNTIME_SWEEP_INTERVAL_MS. */
export const RUNTIME_SWEEP_INTERVAL_MS_DEFAULT = 30_000;
