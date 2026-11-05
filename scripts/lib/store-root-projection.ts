/** Build-time store registration projection. No runtime root-map or filesystem imports. */
export const STORE_ROOT_FAMILIES = ['state', 'ledger', 'floor'] as const;
export type StoreRootFamily = (typeof STORE_ROOT_FAMILIES)[number];
export type StoreRootRegistries = Record<StoreRootFamily, Readonly<Record<string, string>>>;

export interface StoreRootRegistration {
  family: StoreRootFamily;
  key: string;
  order: number;
  retention_path: string;
}

export interface StoreRootSource {
  id: string;
  path: string;
  custody: { kind: 'system' | 'tenant' | 'person' | 'derived' | 'unscoped-legacy' };
  status: 'active' | 'planned' | 'legacy-move';
  registration?: StoreRootRegistration;
}

export interface StoreRootProjection {
  roots: StoreRootRegistries;
  violations: string[];
}

const PARTITION_SUFFIX = '/<tier>/<tenant>';
// G0 inventories these historical metrics roots without resolving custody.
const LEGACY_BARE_LEDGER_REGISTRATIONS = new Set([
  'ledger:resource_usage',
  'ledger:execution_metrics',
]);

export function isCanonicalStoreRoot(value: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

/**
 * Project validated catalog data, independently of the currently compiled maps.
 * A generator can therefore heal stale constants before the runtime-map gate runs.
 */
export function projectStoreRoots(
  stores: readonly StoreRootSource[],
  retention: readonly { path: string }[]
): StoreRootProjection {
  const violations: string[] = [];
  const registrations = new Set<string>();
  const orders = new Set<string>();
  const ids = new Set<string>();
  const paths = new Set<string>();
  const entries: Record<StoreRootFamily, { key: string; root: string; order: number }[]> = {
    state: [],
    ledger: [],
    floor: [],
  };
  const retentionPaths = new Set(retention.map(({ path }) => path));
  for (const store of stores) {
    if (ids.has(store.id)) violations.push(`duplicate store id ${store.id}`);
    if (paths.has(store.path)) violations.push(`duplicate store path ${store.path}`);
    ids.add(store.id);
    paths.add(store.path);
    const registration = store.registration;
    if (!registration) continue;
    const { family, key, order, retention_path: policyPath } = registration;
    const name = `${family}:${key}`;
    let valid = true;
    if (!STORE_ROOT_FAMILIES.includes(family)) {
      violations.push(`${store.id}: invalid registration family ${family}`);
      continue;
    }
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || Object.hasOwn(Object.prototype, key)) {
      violations.push(`${store.id}: invalid registration key ${name}`);
      valid = false;
    }
    if (registrations.has(name)) {
      violations.push(`${store.id}: duplicate registration ${name}`);
      valid = false;
    }
    registrations.add(name);
    if (!Number.isSafeInteger(order) || order < 1) {
      violations.push(`${store.id}: registration ${name} requires a positive safe-integer order`);
      valid = false;
    } else if (orders.has(`${family}:${order}`)) {
      violations.push(`${store.id}: duplicate registration order ${family}:${order}`);
      valid = false;
    }
    orders.add(`${family}:${order}`);
    if (store.status !== 'active') {
      violations.push(`${store.id}: registered runtime root must be active`);
      valid = false;
    }
    const partitioned = store.path.endsWith(PARTITION_SUFFIX);
    const legacyBareRoot =
      LEGACY_BARE_LEDGER_REGISTRATIONS.has(name) && store.custody.kind === 'unscoped-legacy';
    const root = partitioned ? store.path.slice(0, -PARTITION_SUFFIX.length) : store.path;
    if ((!partitioned && !legacyBareRoot) || !isCanonicalStoreRoot(root)) {
      violations.push(
        `${store.id}: registration ${name} requires a canonical root with tier/tenant binding`
      );
      valid = false;
    }
    if (!isCanonicalStoreRoot(policyPath) || !retentionPaths.has(policyPath))
      violations.push(
        `${store.id}: retention reference ${policyPath} does not name an existing canonical policy`
      );
    else if (root !== policyPath && !root.startsWith(policyPath + '/'))
      violations.push(`${store.id}: retention reference ${policyPath} does not cover root ${root}`);
    else {
      const effective = retention
        .filter(({ path }) => root === path || root.startsWith(path + '/'))
        .sort((a, b) => b.path.length - a.path.length)[0]?.path;
      if (policyPath !== effective)
        violations.push(
          `${store.id}: retention reference ${policyPath} differs from effective root policy ${effective}`
        );
      if (retention.filter(({ path }) => path === policyPath).length !== 1)
        violations.push(`${store.id}: retention reference ${policyPath} is ambiguous`);
    }
    if (valid) entries[family].push({ key, root, order });
  }
  const roots = Object.fromEntries(
    STORE_ROOT_FAMILIES.map((family) => [
      family,
      Object.fromEntries(
        entries[family]
          .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
          .map(({ key, root }) => [key, root])
      ),
    ])
  ) as StoreRootRegistries;
  return { roots, violations: violations.sort() };
}

/** Compare the static runtime exports only after projection; no generation circularity. */
export function compareStoreRootRegistries(
  projection: StoreRootProjection,
  registries: StoreRootRegistries
): string[] {
  const violations = [...projection.violations];
  for (const family of STORE_ROOT_FAMILIES) {
    const expected = projection.roots[family];
    const current = registries[family];
    for (const [key, root] of Object.entries(current)) {
      if (!Object.hasOwn(expected, key))
        violations.push(`missing store registration ${family}:${key}`);
      else if (expected[key] !== root)
        violations.push(`registration ${family}:${key} does not match root ${root}`);
      if (!isCanonicalStoreRoot(root))
        violations.push(`${family}:${key}: noncanonical runtime root ${root}`);
    }
    for (const key of Object.keys(expected))
      if (!Object.hasOwn(current, key)) violations.push(`unknown registration ${family}:${key}`);
    if (Object.keys(expected).join(',') !== Object.keys(current).join(','))
      violations.push(`${family}: runtime root key order differs from catalog registration order`);
  }
  return violations.sort();
}
