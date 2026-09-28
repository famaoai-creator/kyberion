/**
 * Canonical provider-id -> CLI binary map.
 *
 * Both `provider-bridge` (invocation plans) and `backend-conformance`
 * (capability probes) need this mapping, and it used to be hardcoded twice
 * with slightly different shapes. Convention: `<provider>-cli` -> `<provider>`
 * with explicit overrides only where the binary differs.
 */

const PROVIDER_BINARY_OVERRIDES: Record<string, string> = {
  gh: 'gh',
  'cursor-cli': 'cursor-agent',
};

export function providerCliBinary(provider: string): string {
  return PROVIDER_BINARY_OVERRIDES[provider] ?? provider.replace(/-cli$/, '');
}

/**
 * Providers whose CLI can recover from a pnpm placeholder shim at runtime.
 *
 * pnpm's approve-builds mechanism shims only packages with a postinstall
 * script; today `@anthropic-ai/claude-code` is the sole CLI in that class,
 * which is why the stale-snapshot exemption in reasoning-bootstrap is
 * claude-specific. If another provider gains the same fallback mechanism
 * (probe alternate install paths when the shimmed binary fails), add it here
 * rather than hardcoding provider names at call sites.
 */
const PLACEHOLDER_FALLBACK_PROVIDERS = new Set(['claude-cli']);

/**
 * True when the reasoning mode's runtime probe can recover from a pnpm
 * placeholder shim by falling back to alternate install paths — i.e. a
 * cached `binary_found=false` snapshot does not prove the backend is absent.
 */
export function modeHasPlaceholderFallback(mode: string): boolean {
  return PLACEHOLDER_FALLBACK_PROVIDERS.has(mode);
}
