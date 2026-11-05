/**
 * Store catalog gate (G0 of the store-catalog guard design).
 *
 * knowledge/product/governance/store-catalog.json declares every governed
 * store once, with its custodian (system / tenant / person). This gate keeps
 * it aligned with the declarations it replaces later:
 *   - state, ledger and floor roots have typed registrations and retention references;
 *   - every store-scoped authority role (`*_store`, `*_writer`, `*_reader`) is
 *     listed on each entry its security-policy paths reach, and nowhere else;
 *   - a legacy-move entry names an existing replacement;
 *   - the number of unscoped-legacy entries only goes down (baseline).
 * It reads the catalog; tier-guard does not consume it yet.
 */
import { withExecutionContext } from '@agent/core/authority';
import { compileSchema, writeJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  PARTITIONED_RUNTIME_STATE_ROOTS,
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
  STORAGE_FLOOR_ROOTS,
} from '@agent/core/storage-layout';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';
import { readSafeJsonFile } from './lib/json-input.js';

export interface StoreEntry {
  id: string;
  path: string;
  custody: { kind: 'system' | 'tenant' | 'person' | 'derived' | 'unscoped-legacy' };
  status: 'active' | 'planned' | 'legacy-move';
  moves_to?: string;
  legacy_roles?: string[];
  registration?: {
    family: 'state' | 'ledger' | 'floor';
    key: string;
    retention_path: string;
  };
}
export interface StoreCatalog {
  stores: StoreEntry[];
}
type RolePermissions = Record<string, { allow_read?: string[]; allow_write?: string[] }>;

const CATALOG = 'knowledge/product/governance/store-catalog.json';
const SCHEMA = 'knowledge/product/schemas/store-catalog.schema.json';
const POLICY = 'knowledge/product/governance/security-policy.json';
const RETENTION = 'knowledge/product/governance/storage-retention-catalog.json';
const RETENTION_SCHEMA = 'knowledge/product/schemas/storage-retention-catalog.schema.json';
const STORE_ROLE = /_(store|writer|reader)$/u;

export type StoreRootRegistries = Record<
  'state' | 'ledger' | 'floor',
  Readonly<Record<string, string>>
>;
const ROOT_REGISTRIES: StoreRootRegistries = {
  state: PARTITIONED_RUNTIME_STATE_ROOTS,
  ledger: PARTITIONED_RUNTIME_LEDGER_ROOTS,
  floor: STORAGE_FLOOR_ROOTS,
};
// G0 inventories these two historical roots without resolving their custody.
// Do not extend this compatibility set to new state, floor or ledger stores.
const LEGACY_BARE_LEDGER_REGISTRATIONS = new Set([
  'ledger:resource_usage',
  'ledger:execution_metrics',
]);

const canonicalRoot = (value: string): boolean =>
  /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) &&
  value.split('/').every((part) => part !== '.' && part !== '..');

/** Static registration integrity only: does not grant access or change retention actions. */
export function checkStoreRegistrations(
  stores: readonly StoreEntry[],
  registries: StoreRootRegistries,
  retention: readonly { path: string }[]
): string[] {
  const violations: string[] = [];
  const registered = new Set<string>();
  const retentionPaths = new Set(retention.map(({ path }) => path));
  for (const store of stores) {
    const registration = store.registration;
    if (!registration) continue;
    const { family, key, retention_path: policyPath } = registration;
    const name = `${family}:${key}`;
    if (registered.has(name)) violations.push(`${store.id}: duplicate registration ${name}`);
    registered.add(name);
    const familyRoots = Object.hasOwn(registries, family) ? registries[family] : undefined;
    const root = familyRoots && Object.hasOwn(familyRoots, key) ? familyRoots[key] : undefined;
    if (!root) {
      violations.push(`${store.id}: unknown registration ${name}`);
      continue;
    }
    if (!canonicalRoot(root)) violations.push(`${name}: noncanonical runtime root ${root}`);
    if (store.status !== 'active')
      violations.push(`${store.id}: registered runtime root must be active`);
    // G0's metrics/usage entries intentionally retain their bare-root,
    // unscoped-legacy attribution; registration does not reinterpret custody.
    const legacyBareRoot =
      LEGACY_BARE_LEDGER_REGISTRATIONS.has(name) &&
      store.custody.kind === 'unscoped-legacy' &&
      store.path === root;
    if (!legacyBareRoot && store.path !== `${root}/<tier>/<tenant>`)
      violations.push(`${store.id}: registration ${name} does not match root ${root}`);
    if (!canonicalRoot(policyPath) || !retentionPaths.has(policyPath))
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
  }
  for (const [family, roots] of Object.entries(registries))
    for (const key of Object.keys(roots))
      if (!registered.has(`${family}:${key}`))
        violations.push(`missing store registration ${family}:${key}`);
  return violations.sort();
}

/** security-policy placeholders → catalog placeholders, trailing slash dropped. */
export function normalizePolicyPath(raw: string): string {
  return raw
    .replace(/\$\{KYBERION_TENANT\}/gu, '<tenant>')
    .replace(/\$\{KYBERION_STANCE\}/gu, '<slug>')
    .replace(/\$\{[A-Z_]+\}/gu, '<id>')
    .replace(/\/+$/u, '');
}

const segments = (value: string): string[] => value.split('/').filter(Boolean);
/** <tier> and <id> stand for any one segment; <tenant>, <slug>, <customer> only for themselves. */
const GENERIC = new Set(['<tier>', '<id>']);
const placeholder = (segment: string): boolean => /^<[a-z]+>$/u.test(segment);

function segmentMatches(templateSegment: string, policySegment: string): boolean {
  if (templateSegment === policySegment) return true;
  if (GENERIC.has(templateSegment) || GENERIC.has(policySegment)) return true;
  // A named template placeholder accepts a literal value (e.g. the `shared` tenant segment),
  // never a different named placeholder: a stance slug is not a tenant slug.
  return placeholder(templateSegment) && !placeholder(policySegment);
}

/** Whether a policy path lies inside a catalog path template. */
export function templateCovers(template: string, policyPath: string): boolean {
  const t = segments(template);
  const p = segments(policyPath);
  if (!p.every((s, i) => i >= t.length || segmentMatches(t[i], s))) return false;
  // A grant on a parent of the template (e.g. `<root>/` for `<root>/<tier>/<tenant>`) is
  // covered when the template only adds placeholder segments below it.
  return p.length >= t.length || t.slice(p.length).every(placeholder);
}

/** The most specific catalog entry covering a policy path. */
export function owningStore(stores: StoreEntry[], policyPath: string): StoreEntry | undefined {
  return stores
    .filter((store) => store.status !== 'planned' && templateCovers(store.path, policyPath))
    .sort((a, b) => segments(b.path).length - segments(a.path).length)[0];
}

export function checkStoreCatalog(
  catalog: StoreCatalog,
  roles: RolePermissions,
  baseline: { unscoped_legacy: number }
): { violations: string[]; unscoped: number } {
  const violations: string[] = [];
  const stores = catalog.stores;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const store of stores) {
    if (ids.has(store.id)) violations.push(`duplicate store id ${store.id}`);
    if (paths.has(store.path)) violations.push(`duplicate store path ${store.path}`);
    ids.add(store.id);
    paths.add(store.path);
  }
  for (const store of stores) {
    if (store.status === 'legacy-move' && (!store.moves_to || !ids.has(store.moves_to)))
      violations.push(`${store.id}: legacy-move needs moves_to naming an existing store`);
  }
  const expected = new Map<string, Set<string>>();
  for (const [role, permissions] of Object.entries(roles)) {
    if (!STORE_ROLE.test(role)) continue;
    for (const raw of [...(permissions.allow_read ?? []), ...(permissions.allow_write ?? [])]) {
      const policyPath = normalizePolicyPath(raw);
      const store = owningStore(stores, policyPath);
      if (!store) {
        violations.push(`${role}: policy path ${raw} reaches no catalog store`);
        continue;
      }
      (expected.get(store.id) ?? expected.set(store.id, new Set()).get(store.id)!).add(role);
    }
  }
  for (const store of stores) {
    const want = [...(expected.get(store.id) ?? [])].sort();
    const have = [...(store.legacy_roles ?? [])].sort();
    if (want.join(',') !== have.join(','))
      violations.push(
        `${store.id}: legacy_roles [${have.join(', ')}] should be [${want.join(', ')}] (from ${POLICY})`
      );
  }
  const unscoped = stores.filter((store) => store.custody.kind === 'unscoped-legacy').length;
  if (unscoped > baseline.unscoped_legacy)
    violations.push(
      `unscoped-legacy stores grew from ${baseline.unscoped_legacy} to ${unscoped}: declare the custodian of new stores (scope model R-01)`
    );
  return { violations: violations.sort(), unscoped };
}

export const runCheckStoreCatalog = defineScript({
  name: 'check:store-catalog',
  flags: [],
  run(context) {
    const catalog = readSafeJsonFile<StoreCatalog>(
      pathResolver.rootResolve(CATALOG),
      'store catalog'
    );
    const validate = compileSchema(pathResolver.rootResolve(SCHEMA));
    if (!validate(catalog)) {
      throw new ScriptExitError(
        1,
        `${CATALOG} violates ${SCHEMA}: ${JSON.stringify(validate.errors)}`
      );
    }
    const retention = readSafeJsonFile<{ entries: { path: string }[] }>(
      pathResolver.rootResolve(RETENTION),
      'storage retention catalog'
    );
    const validateRetention = compileSchema(pathResolver.rootResolve(RETENTION_SCHEMA));
    if (!validateRetention(retention))
      throw new ScriptExitError(
        1,
        `${RETENTION} violates ${RETENTION_SCHEMA}: ${JSON.stringify(validateRetention.errors)}`
      );
    const registrationViolations = checkStoreRegistrations(
      catalog.stores,
      ROOT_REGISTRIES,
      retention.entries
    );
    if (registrationViolations.length > 0)
      throw new ScriptExitError(
        1,
        [
          'store registrations out of sync:',
          ...registrationViolations.map((line) => `- ${line}`),
        ].join('\n')
      );
    const policy = readSafeJsonFile<{ authority_role_permissions?: RolePermissions }>(
      pathResolver.rootResolve(POLICY),
      'security policy'
    );
    const baselinePath = resolveCiGateBaselinePath('store-catalog');
    const roles = policy.authority_role_permissions ?? {};
    if (context.unknownFlags.includes('--write-baseline')) {
      const { unscoped } = checkStoreCatalog(catalog, roles, { unscoped_legacy: Infinity });
      withExecutionContext('ecosystem_architect', () =>
        writeJson(baselinePath, { version: 1, unscoped_legacy: unscoped })
      );
      context.print(`[check:store-catalog] baseline written (unscoped-legacy ${unscoped})`);
      return { violations: [], unscoped };
    }
    const baseline = readSafeJsonFile<{ unscoped_legacy: number }>(
      baselinePath,
      'store catalog baseline'
    );
    const report = checkStoreCatalog(catalog, roles, baseline);
    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['store catalog out of sync:', ...report.violations.map((line) => `- ${line}`)].join('\n')
      );
    }
    context.print(
      `[check:store-catalog] OK (${catalog.stores.length} stores, ${report.unscoped} unscoped-legacy)`
    );
    if (report.unscoped < baseline.unscoped_legacy)
      context.print(
        '[check:store-catalog] fewer unscoped-legacy stores; lower the baseline with --write-baseline'
      );
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'check_store_catalog.ts') ||
  isDirectScript(import.meta.url, 'check_store_catalog.js')
)
  void runCheckStoreCatalog();
