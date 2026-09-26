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

/**
 * PH-01: the Chronos in-process plugin host. Off unless
 * `KYBERION_CHRONOS_PLUGIN_HOST` is set; then one host per process (kept on
 * `globalThis` by `getOrCreatePluginHost`, so instrumentation and every route
 * bundle share it) activates the approved managed plugins of the tenant-less
 * scope plus the tenants in `KYBERION_CHRONOS_PLUGIN_HOST_TENANTS`.
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
 * unavailable (fail closed) while the rest of Chronos keeps working.
 */
export function ensureChronosPluginHost(
  options: EnsureChronosPluginHostOptions = {}
): PluginHost | null {
  if (!isChronosPluginHostEnabled(options.env)) return null;
  try {
    return getOrCreateChronosPluginHost(options);
  } catch (error) {
    console.warn('[chronos-mirror-v2] plugin host: boot failed', error);
    return null;
  }
}

function getOrCreateChronosPluginHost(options: EnsureChronosPluginHostOptions): PluginHost {
  const create = options.create ?? createPluginHost;
  return getOrCreatePluginHost(CHRONOS_PLUGIN_HOST_SURFACE, () => {
    const { tenants, rejected } = parsePluginHostTenantAllow(
      getRegisteredEnvText('KYBERION_CHRONOS_PLUGIN_HOST_TENANTS', { env: options.env }),
      options.isKnownTenant
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
