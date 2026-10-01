import { resolveReasoningProviderDescriptor } from '../reasoning/reasoning-provider-registry.js';

/**
 * Provider-id -> CLI binary.
 *
 * RS-01: the binary is declared once in the governed provider descriptor
 * (`reasoning-providers/*.json` `cli.binary`); a mode, alias, or provider id
 * resolves to it. Identifiers the registry does not know (e.g. `gh` for a
 * GitHub capability) keep the `<provider>-cli` -> `<provider>` convention.
 */
export function providerCliBinary(provider: string): string {
  return resolveReasoningProviderDescriptor(provider)?.cli?.binary ?? provider.replace(/-cli$/, '');
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

/**
 * Providers exempt from gating chain usability on local-binary health.
 *
 * `provider-discovery` probes these binaries like any other CLI, but the
 * backend can delegate through API-configured auth — a missing local binary
 * must not mark the reasoning chain "hollow". New local CLI providers added
 * to provider-discovery automatically join the gating set.
 */
export const CHAIN_GATING_EXEMPT_PROVIDERS = new Set(['devin']);
