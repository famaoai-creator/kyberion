/**
 * Next.js server start hook. PH-01: starts the Chronos plugin host (a no-op
 * unless `KYBERION_CHRONOS_PLUGIN_HOST` is set). Node.js runtime only — the
 * edge runtime cannot import plugin code; the dynamic import keeps the host
 * out of the edge bundle.
 */
export async function register(): Promise<void> {
  // Keep the positive NEXT_RUNTIME check wrapping the import: Next only drops
  // the Node-only module graph from the edge bundle for this exact shape.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { ensureChronosPluginHost } = await import('./lib/plugin-host-boot');
      ensureChronosPluginHost();
    } catch (error) {
      // The plugin host must never keep Chronos from starting.
      console.warn('[chronos-mirror-v2] plugin host boot failed', error);
    }
  }
}
