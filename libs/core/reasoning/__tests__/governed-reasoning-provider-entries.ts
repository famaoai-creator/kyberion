/**
 * Raw governed reasoning-provider entries, bundled at test-compile time via
 * `import.meta.glob` (no runtime fs). For suites that mock path-resolver or
 * secure-io: `primeReasoningProviderRegistryForTests(governedReasoningProviderEntries())`.
 */
const modules = import.meta.glob<{ providers?: unknown[]; order?: string[] }>(
  '../../../../knowledge/product/governance/reasoning-providers/*.json',
  { eager: true, import: 'default' }
);

export function governedReasoningProviderEntries(): unknown[] {
  const order =
    Object.entries(modules).find(([file]) => file.endsWith('/index.json'))?.[1].order ?? [];
  const entries = Object.entries(modules)
    .filter(([file]) => !file.endsWith('/index.json'))
    .flatMap(([, module]) => module.providers ?? []);
  const rank = (entry: unknown) => {
    const mode = (entry as { mode?: string }).mode ?? '';
    const index = order.indexOf(mode);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return entries.sort((a, b) => rank(a) - rank(b));
}
