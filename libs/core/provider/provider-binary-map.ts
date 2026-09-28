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
