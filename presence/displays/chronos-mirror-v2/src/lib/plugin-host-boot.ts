import { withExecutionContext } from '@agent/core/authority';
import { getRegisteredEnvBool, getRegisteredEnvText } from '@agent/core/foundation';
import {
  createPluginHost,
  getOrCreatePluginHost,
  getPluginHost,
  parsePluginHostTenantAllow,
  resolvePluginHostPollMs,
  type PluginHost,
  type PluginHostStatus,
} from '@agent/core/plugin-host';
import { resolveTenant } from '@agent/core/tenant-registry';

/**
 * PH-01: the Chronos in-process plugin host. Off unless
 * `KYBERION_CHRONOS_PLUGIN_HOST` is set; then one host per process (kept on
 * `globalThis` by `getOrCreatePluginHost`, so every route bundle shares it)
 * activates the approved managed plugins of the tenant-less scope plus the
 * tenants in `KYBERION_CHRONOS_PLUGIN_HOST_TENANTS`.
 *
 * Only route handlers create the host (the plugin-views GET / POST). Next.js
 * compiles `instrumentation.ts` in a separate webpack layer with its own copy
 * of every bundled `@agent/core` module, so a host started there registers
 * plugin operations in registries the routes never see (PE-02 found every
 * view action `PLUGIN_VIEW_ACTION_UNAVAILABLE` that way).
 */

export const CHRONOS_PLUGIN_HOST_SURFACE = 'chronos';

type EnvSource = Record<string, string | undefined>;

export interface EnsureChronosPluginHostOptions {
  /** Environment override (tests). */
  env?: EnvSource;
  /** Host factory override (tests). */
  create?: typeof createPluginHost;
  /** Tenant registry lookup override (tests). */
  isKnownTenant?: (slug: string) => boolean;
  /** Clock override (tests). */
  now?: () => number;
}

/** After a boot failure, no new boot is attempted (or logged) for this long. */
export const CHRONOS_PLUGIN_HOST_BOOT_BACKOFF_MS = 60_000;

// On globalThis like the host itself, so every route bundle shares it.
const BOOT_FAILURE_KEY = Symbol.for('kyberion.pluginHostBootFailure.chronos');

function bootFailedAt(): number | undefined {
  return (globalThis as Record<symbol, unknown>)[BOOT_FAILURE_KEY] as number | undefined;
}

/** Forgets a remembered boot failure (tests / operator retry). */
export function resetChronosPluginHostBootFailure(): void {
  delete (globalThis as Record<symbol, unknown>)[BOOT_FAILURE_KEY];
}

/**
 * Authority role Chronos reads the tenant registry with (it lives in the
 * personal tier). The server process itself runs without a role that may
 * read it, so a lookup under the ambient role rejected every tenant (PE-02).
 */
export const CHRONOS_TENANT_REGISTRY_ROLE = 'chronos_localadmin';

/** True when `slug` resolves in the tenant registry (read as Chronos localadmin). */
export function isKnownChronosTenant(slug: string): boolean {
  try {
    withExecutionContext(CHRONOS_TENANT_REGISTRY_ROLE, () => resolveTenant(slug));
    return true;
  } catch {
    return false;
  }
}

export function isChronosPluginHostEnabled(env?: EnvSource): boolean {
  return (
    getRegisteredEnvBool('KYBERION_CHRONOS_PLUGIN_HOST', { env, defaultValue: false }) === true
  );
}

/**
 * Returns the started Chronos plugin host, creating it on first use.
 * Idempotent; returns null (and creates nothing) when the flag is off. A boot
 * failure is logged and also returns null: nothing runs, so view actions stay
 * unavailable (fail closed) while the rest of Chronos keeps working. The
 * failure is remembered for `CHRONOS_PLUGIN_HOST_BOOT_BACKOFF_MS`, so the
 * plugin-views requests in that window neither retry nor log again.
 */
export function ensureChronosPluginHost(
  options: EnsureChronosPluginHostOptions = {}
): PluginHost | null {
  if (!isChronosPluginHostEnabled(options.env)) return null;
  const now = options.now ?? Date.now;
  const failedAt = bootFailedAt();
  if (failedAt !== undefined && now() - failedAt < CHRONOS_PLUGIN_HOST_BOOT_BACKOFF_MS) {
    return null;
  }
  try {
    const host = getOrCreateChronosPluginHost(options);
    resetChronosPluginHostBootFailure();
    return host;
  } catch (error) {
    (globalThis as Record<symbol, unknown>)[BOOT_FAILURE_KEY] = now();
    console.warn(
      `[chronos-mirror-v2] plugin host: boot failed; retrying after ${CHRONOS_PLUGIN_HOST_BOOT_BACKOFF_MS / 1000}s`,
      error
    );
    return null;
  }
}

function getOrCreateChronosPluginHost(options: EnsureChronosPluginHostOptions): PluginHost {
  const create = options.create ?? createPluginHost;
  return getOrCreatePluginHost(CHRONOS_PLUGIN_HOST_SURFACE, () => {
    const { tenants, rejected } = parsePluginHostTenantAllow(
      getRegisteredEnvText('KYBERION_CHRONOS_PLUGIN_HOST_TENANTS', { env: options.env }),
      options.isKnownTenant ?? isKnownChronosTenant
    );
    if (rejected.length > 0) {
      console.warn(
        `[chronos-mirror-v2] plugin host: ignoring ${rejected.length} invalid, reserved or unknown tenant(s) in KYBERION_CHRONOS_PLUGIN_HOST_TENANTS`
      );
    }
    if (tenants.length > 1) {
      // Plugin ops are registered process-wide: one host for several tenants
      // lets each tenant's plugins be called from the others' paths.
      console.warn(
        `[chronos-mirror-v2] plugin host: ${tenants.length} tenants allowed in one process share one trust domain (plugin operations are process-wide); run one Chronos per tenant to keep them isolated`
      );
    }
    const host = create({
      surface: CHRONOS_PLUGIN_HOST_SURFACE,
      tenantAllow: tenants,
      pollMs: resolvePluginHostPollMs(
        getRegisteredEnvText('KYBERION_PLUGIN_HOST_POLL_MS', { env: options.env })
      ),
    });
    host.start();
    return host;
  });
}

/** Status of the Chronos host; `enabled: false` when it is off or not started. */
export function chronosPluginHostStatus(): PluginHostStatus {
  return (
    getPluginHost(CHRONOS_PLUGIN_HOST_SURFACE)?.status() ?? {
      enabled: false,
      surface: CHRONOS_PLUGIN_HOST_SURFACE,
      plugins: [],
    }
  );
}
