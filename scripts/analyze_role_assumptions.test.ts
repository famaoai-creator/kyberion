import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  buildReachabilityReport,
  normalizeReachabilityReport,
  type RoleAssumptionReachabilityReport,
} from './analyze_role_assumptions.js';

/**
 * RN-02: the analyzer on a hermetic fixture checkout. Each surface exercises
 * one resolution rule so a regression names the rule it broke.
 */
const FIXTURE_ROOT = pathResolver.sharedTmp(`analyze-role-assumptions-${process.pid}`);
/** Fixture-relative import prefix, built so repo import scanners do not read it as ours. */
const CORE = ['..', 'libs', 'core'].join('/');
const NEXT_CORE = ['..', '..', '..', 'libs', 'core'].join('/');
const ROUTE_CORE = ['..', '..', '..', '..', '..', '..', 'libs', 'core'].join('/');
const CHILD_PROCESS = ['node', 'child_process'].join(':');

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: {} }),
  'knowledge/product/governance/role-assumption-policy.json': JSON.stringify({
    version: '1.0.0',
    description: 'fixture',
    shared_core_roles: { roles: ['shared_writer'], rationale: 'fixture' },
    system_roles: {
      literal_surface: { may_assume: ['role_literal', 'role_extra'], rationale: 'fixture' },
    },
  }),
  'knowledge/product/governance/surfaces/fixture.json': JSON.stringify({
    version: 1,
    surfaces: [
      { id: 'literal-surface', command: 'node', args: ['dist/apps/literal.js'] },
      {
        id: 'custom-next-surface',
        command: 'node',
        args: ['server/start.ts'],
        cwd: 'apps/next-workspace',
      },
      { id: 'wrapper-surface', command: 'node', args: ['dist/apps/wrapper.js'] },
      {
        id: 'unknown-next-surface',
        command: 'node',
        args: ['server/start.ts'],
        cwd: 'apps/unknown-next',
      },
      {
        id: 'plain-node-surface',
        command: 'node',
        args: ['server/start.ts'],
        cwd: 'apps/plain-workspace',
      },
      { id: 'union-surface', command: 'node', args: ['dist/apps/union.js'] },
      { id: 'dynamic-surface', command: 'node', args: ['dist/apps/dynamic.js'] },
      { id: 'require-surface', command: 'node', args: ['dist/apps/required.js'] },
      { id: 'variants-surface', command: 'node', args: ['dist/apps/variants.js'] },
      { id: 'missing-surface', command: 'node', args: ['dist/apps/missing.js'] },
      { id: 'spawn-surface', command: 'node', args: ['dist/apps/spawn.js'] },
      { id: 'delegate-surface', command: 'node', args: ['dist/apps/delegate.js'] },
      { id: 'launch-surface', command: 'node', args: ['dist/apps/launch.js'] },
      { id: 'other-surface', command: 'node', args: ['dist/apps/other.js'] },
      { id: 'rawwrite-surface', command: 'node', args: ['dist/apps/rawwrite.js'] },
      { id: 'member-surface', command: 'node', args: ['dist/apps/members.js'] },
      { id: 'member-kinds-surface', command: 'node', args: ['dist/apps/member-kinds.js'] },
    ],
  }),
  'apps/next-workspace/package.json': JSON.stringify({
    name: '@fixture/next-app',
    dependencies: { next: '16.3.8' },
  }),
  'apps/next-workspace/server/start.ts': [
    // Fixture source uses native Node TypeScript; split the specifier so the
    // repository NodeNext text scanner does not mistake this string for a host import.
    "import { admit } from '" + './peer.ts' + "';",
    "import { withExecutionContext } from '" + NEXT_CORE + "/authority.js';",
    "withExecutionContext('role_next_server', () => admit());",
  ].join('\n'),
  'apps/next-workspace/server/peer.ts': [
    "import { withExecutionContext } from '" + NEXT_CORE + "/authority.js';",
    "export function admit() { withExecutionContext('role_next_peer', () => undefined); }",
  ].join('\n'),
  'apps/next-workspace/src/app/api/check/route.ts': [
    "import { withExecutionContext } from '" + ROUTE_CORE + "/authority.js';",
    "export function GET() { return withExecutionContext('role_next_route', () => 'ok'); }",
  ].join('\n'),
  'apps/next-workspace/src/app/page.tsx': 'export default function Page() { return <main />; }',
  'apps/next-workspace/server/types.d.mts': 'export declare function declarationOnly(): void;',
  'apps/next-workspace/server/types.d.cts': 'export declare function declarationOnly(): void;',
  'apps/next-workspace/server/peer.test.ts': 'export const testOnly = true;',
  'apps/next-workspace/dist/server.mjs': 'export const compiledOnly = true;',
  'apps/next-workspace/.next/server.mjs': 'export const generatedOnly = true;',
  'apps/next-workspace/node_modules/outsider/index.mjs': 'export const dependencyOnly = true;',
  'server/start.ts': 'export const wrongWorkingDirectory = true;',
  'apps/outsider/src/app/route.js': 'export const outsideApp = true;',
  'apps/plain-workspace/package.json': JSON.stringify({
    name: '@fixture/plain-app',
    dependencies: {},
  }),
  'apps/plain-workspace/server/start.ts': [
    "import { withExecutionContext } from '" + NEXT_CORE + "/authority.js';",
    "withExecutionContext('role_plain_server', () => undefined);",
  ].join('\n'),
  'apps/plain-workspace/src/app/api/check/route.ts': [
    "import { withExecutionContext } from '" + ROUTE_CORE + "/authority.js';",
    "export function GET() { return withExecutionContext('role_not_a_next_route', () => 'ok'); }",
  ].join('\n'),
  'apps/unknown-next/package.json': JSON.stringify({
    name: '@fixture/unknown-next',
    dependencies: { next: '16.3.8' },
  }),
  'apps/unknown-next/server/start.ts': [
    "import { loadRelative, loadComputed } from '" + './peer.ts' + "';",
    "void loadRelative(); void loadComputed('runtime-input');",
  ].join('\n'),
  'apps/unknown-next/server/peer.ts': [
    "export async function loadRelative() { return import('./missing-peer.ts'); }",
    'export async function loadComputed(specifier: string) { return import(specifier); }',
  ].join('\n'),
  'apps/unknown-next/src/app/api/check/route.ts': 'export function GET() { return 0; }',
  'libs/core/authority.ts': [
    'export function withExecutionContext<T>(role: string, fn: () => T): T {',
    '  return fn();',
    '}',
    'export async function withExecutionContextAsync<T>(role: string, fn: () => Promise<T>): Promise<T> {',
    '  return fn();',
    '}',
    'export function buildExecutionEnv(env: NodeJS.ProcessEnv = process.env, role?: string): NodeJS.ProcessEnv {',
    '  return role ? { ...env, MISSION_ROLE: role } : { ...env };',
    '}',
    'export function buildSystemRoleLaunchEnv(env: NodeJS.ProcessEnv, systemRole: string): NodeJS.ProcessEnv {',
    '  return { ...env, SYSTEM_ROLE: systemRole };',
    '}',
  ].join('\n'),
  'libs/core/stores.ts': [
    "import { withExecutionContext } from './authority.js';",
    "export type StoreRole = 'store_a' | 'store_b';",
    'export function withStoreRole<T>(role: StoreRole, fn: () => T): T {',
    '  return withExecutionContext(role, fn);',
    '}',
    'export function writeAsSharedWriter(): void {',
    "  withExecutionContext('shared_writer', () => undefined);",
    '}',
    'export function neverCalled(): void {',
    "  withExecutionContext('role_unreachable', () => undefined);",
    '}',
    'export function unionRole(flag: boolean): void {',
    "  const role: 'union_a' | 'union_b' = flag ? 'union_a' : 'union_b';",
    '  withExecutionContext(role, () => undefined);',
    '}',
  ].join('\n'),
  // Declarations reached only through a member access (`x.name`).
  'libs/core/members.ts': [
    "import { withExecutionContext } from './authority.js';",
    "function inner(): void { withExecutionContext('role_renamed_export', () => undefined); }",
    'export { inner as renamedExport };',
    'export default function (): void {',
    "  withExecutionContext('role_default_export', () => undefined);",
    '}',
    'export function notAccessed(): void {',
    "  withExecutionContext('role_not_accessed', () => undefined);",
    '}',
    "const KEY = 'viaComputedKey';",
    'export class Service {',
    "  compute(): void { withExecutionContext('role_typed_member', () => undefined); }",
    '}',
    'export class Keyed {',
    "  [KEY](): void { withExecutionContext('role_computed_member', () => undefined); }",
    '}',
    'export class Unused {',
    "  idle(): void { withExecutionContext('role_unused_member', () => undefined); }",
    '}',
  ].join('\n'),
  'apps/members.ts': [
    `import * as members from '${CORE}/members.js';`,
    `import type { Keyed, Service, Unused } from '${CORE}/members.js';`,
    'export function useService(service: Service): void { service.compute(); }',
    'export function useKeyed(keyed: Keyed): void { keyed.viaComputedKey(); }',
    'export type Untouched = Unused;',
    'members.renamedExport();',
    'members.default();',
  ].join('\n'),
  // Every way a member name can be declared, each reached only through a
  // typed member access (type-only imports add no edge of their own).
  'libs/core/member-kinds.ts': [
    "import { withExecutionContext } from './authority.js';",
    "export enum K { Go = 'goNow' }",
    'export class EnumKeyed {',
    "  [K.Go](): void { withExecutionContext('role_enum_key', () => undefined); }",
    '}',
    // `zzE` stands for a global, and the fixture program has no lib, so
    // `Object` is declared here: only the shorthand property declares `zzE`.
    'declare const Object: { assign<T, U>(target: T, source: U): T & U };',
    'export function makeTool() {',
    "  withExecutionContext('role_shorthand', () => undefined);",
    '  return Object.assign(() => undefined, { zzE });',
    '}',
    'export class Fielded {',
    "  run = (): void => { withExecutionContext('role_arrow_field', () => undefined); };",
    '}',
    'export class Getter {',
    '  get value(): number {',
    "    withExecutionContext('role_getter', () => undefined);",
    '    return 1;',
    '  }',
    '}',
    'export namespace Space {',
    "  export function act(): void { withExecutionContext('role_namespace', () => undefined); }",
    '}',
    'export class Mapped {',
    "  doThing(): void { withExecutionContext('role_mapped', () => undefined); }",
    "  skip(): void { withExecutionContext('role_mapped_skipped', () => undefined); }",
    '}',
    'export type OnlyDo<T> = { [P in keyof T as P extends `do${string}` ? P : never]: T[P] };',
    "const TPL = `tpl${'Key'}` as const;",
    'export class Templated {',
    "  [TPL](): void { withExecutionContext('role_template_key', () => undefined); }",
    '}',
  ].join('\n'),
  'libs/core/barrel-impl.ts': [
    "import { withExecutionContext } from './authority.js';",
    "export function inner(): void { withExecutionContext('role_barrel', () => undefined); }",
  ].join('\n'),
  'libs/core/barrel.d.ts': "export { inner as viaBarrel } from './barrel-impl.js';",
  'apps/member-kinds.ts': [
    `import type { EnumKeyed, Fielded, Getter, Mapped, OnlyDo, Templated, makeTool } from '${CORE}/member-kinds.js';`,
    `import { Space } from '${CORE}/member-kinds.js';`,
    `import * as barrel from '${CORE}/barrel.js';`,
    'export function useEnum(item: EnumKeyed): void { item.goNow(); }',
    'export function useShorthand(make: typeof makeTool): void { make().zzE(); }',
    'export function useField(item: Fielded): void { item.run(); }',
    'export function useGetter(item: Getter): number { return item.value; }',
    'export function useNamespace(): void { Space.act(); }',
    'export function useMapped(item: OnlyDo<Mapped>): void { item.doThing(); }',
    'export function useTemplate(item: Templated): void { item.tplKey(); }',
    'export function useBarrel(): void { barrel.viaBarrel(); }',
  ].join('\n'),
  'apps/literal.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    `import { writeAsSharedWriter } from '${CORE}/stores.js';`,
    "withExecutionContext('role_literal', () => writeAsSharedWriter());",
  ].join('\n'),
  'apps/wrapper.ts': [
    `import { withStoreRole } from '${CORE}/stores.js';`,
    "withStoreRole('store_a', () => undefined);",
  ].join('\n'),
  'apps/union.ts': [`import { unionRole } from '${CORE}/stores.js';`, 'unionRole(true);'].join(
    '\n'
  ),
  'apps/dynamic.ts': [
    'export async function load(name: string): Promise<unknown> {',
    '  return import(name);',
    '}',
  ].join('\n'),
  'apps/required.ts': [
    `import { createRequire } from '${['node', 'module'].join(':')}';`,
    'const load = createRequire(import.meta.url);',
    'export function run(): void {',
    `  (load('${CORE}/required-dep.js') as { go(): void }).go();`,
    '}',
  ].join('\n'),
  'libs/core/required-dep.ts': [
    "import { withExecutionContext } from './authority.js';",
    "export function go(): void { withExecutionContext('role_required', () => undefined); }",
  ].join('\n'),
  'apps/variants.ts': [
    `import { promisify } from '${['node', 'util'].join(':')}';`,
    `import { exec } from '${CHILD_PROCESS}';`,
    `import { createRequire } from '${['node', 'module'].join(':')}';`,
    `import { Worker } from '${['node', 'worker_threads'].join(':')}';`,
    'const run = promisify(exec);',
    "void run('node dist/scripts/promisified.js', { env: process.env });",
    'const load = createRequire(import.meta.url);',
    `const cp = load('${CHILD_PROCESS}') as { spawn(...args: unknown[]): void };`,
    "cp.spawn('node', ['dist/scripts/required-child.js'], { env: process.env });",
    "new Worker('dist/scripts/worker.js');",
  ].join('\n'),
  'scripts/promisified.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    "withExecutionContext('role_promisified', () => undefined);",
  ].join('\n'),
  'scripts/required-child.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    "withExecutionContext('role_required_child', () => undefined);",
  ].join('\n'),
  'scripts/worker.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    "withExecutionContext('role_worker', () => undefined);",
  ].join('\n'),
  'apps/missing.ts': [`import { helper } from '${CORE}/not-there.js';`, 'helper();'].join('\n'),
  'apps/spawn.ts': [
    `import { spawn } from '${CHILD_PROCESS}';`,
    "spawn(process.execPath, ['dist/scripts/child.js'], { env: { ...process.env } });",
    "spawn(process.execPath, ['dist/scripts/isolated.js'], { env: { PATH: '' } });",
    "spawn(process.execPath, ['dist/apps/unanalysed.js'], { env: process.env });",
  ].join('\n'),
  'apps/unanalysed.ts': 'export {};',
  'apps/delegate.ts': [
    `import { spawn } from '${CHILD_PROCESS}';`,
    `import { buildExecutionEnv } from '${CORE}/authority.js';`,
    "spawn(process.execPath, ['dist/scripts/delegated-child.js'], { env: buildExecutionEnv(process.env, 'role_delegated') });",
    "spawn(process.execPath, ['dist/scripts/delegated-child.js'], { env: buildExecutionEnv({ PATH: '' }, 'role_not_delegated') });",
    'export function forward(role: string): NodeJS.ProcessEnv {',
    '  return buildExecutionEnv(process.env, role);',
    '}',
    "forward('role_forwarded');",
  ].join('\n'),
  'apps/launch.ts': [
    `import { spawn } from '${CHILD_PROCESS}';`,
    `import { buildExecutionEnv, buildSystemRoleLaunchEnv } from '${CORE}/authority.js';`,
    'function launchEnv(): NodeJS.ProcessEnv {',
    "  return buildSystemRoleLaunchEnv(process.env, 'other_surface');",
    '}',
    // A NEW SYSTEM_ROLE: the launched child is not walked under launch_surface.
    "spawn(process.execPath, ['dist/scripts/launched-child.js'], { env: launchEnv() });",
    // An explicit undefined env inherits process.env like no env at all.
    "spawn(process.execPath, ['dist/scripts/undefined-env-child.js'], { env: undefined });",
    // buildExecutionEnv(undefined, role) defaults to process.env.
    "void buildExecutionEnv(undefined, 'role_default_env');",
    // A delegation under another SYSTEM_ROLE belongs to that system role.
    "void buildExecutionEnv({ ...process.env, SYSTEM_ROLE: 'other_surface' }, 'role_for_other');",
  ].join('\n'),
  'apps/other.ts': 'export {};',
  'apps/rawwrite.ts': [
    "process.env.KYBERION_DELEGATED_ROLE = 'role_raw@rawwrite_surface';",
    "export const cleared = { KYBERION_DELEGATED_ROLE: '' };",
  ].join('\n'),
  'scripts/launched-child.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    "withExecutionContext('role_in_launched_child', () => undefined);",
  ].join('\n'),
  'scripts/undefined-env-child.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    "withExecutionContext('role_undefined_env_child', () => undefined);",
  ].join('\n'),
  'scripts/delegated-child.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    "withExecutionContext('role_in_delegated_child', () => undefined);",
  ].join('\n'),
  'scripts/child.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    "withExecutionContext('role_child', () => undefined);",
  ].join('\n'),
  'scripts/isolated.ts': [
    `import { withExecutionContext } from '${CORE}/authority.js';`,
    "withExecutionContext('role_isolated', () => undefined);",
  ].join('\n'),
};

describe('RN-02 role assumption reachability analysis', () => {
  let report: RoleAssumptionReachabilityReport;

  beforeAll(() => {
    for (const [rel, content] of Object.entries(FILES)) {
      const file = path.join(FIXTURE_ROOT, rel);
      safeMkdir(path.dirname(file), { recursive: true });
      safeWriteFile(file, `${content}\n`);
    }
    report = buildReachabilityReport(FIXTURE_ROOT);
  });

  afterAll(() => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('analyzes custom native TypeScript Next server and dynamically discovered route roles without outsiders', () => {
    const surface = report.system_roles.custom_next_surface;
    expect(surface.entries).toEqual([
      'apps/next-workspace/server/peer.ts',
      'apps/next-workspace/server/start.ts',
      'apps/next-workspace/src/app/api/check/route.ts',
      'apps/next-workspace/src/app/page.tsx',
    ]);
    expect(Object.keys(surface.reachable_roles)).toEqual([
      'role_next_peer',
      'role_next_route',
      'role_next_server',
    ]);
    expect(surface.unresolved_sites).toEqual([]);
  });

  it('fails closed on unknown relative and computed imports in a custom server peer chain', () => {
    const surface = report.system_roles.unknown_next_surface;
    expect(surface.entries).toEqual([
      'apps/unknown-next/server/peer.ts',
      'apps/unknown-next/server/start.ts',
      'apps/unknown-next/src/app/api/check/route.ts',
    ]);
    expect(surface.unresolved_sites).toEqual([
      'apps/unknown-next/server/peer.ts#loadComputed',
      'apps/unknown-next/server/peer.ts#loadRelative',
    ]);
    expect(report.unresolved_sites['apps/unknown-next/server/peer.ts#loadComputed'][0]).toMatch(
      /computed specifier/
    );
    expect(report.unresolved_sites['apps/unknown-next/server/peer.ts#loadRelative'][0]).toMatch(
      /missing-peer/
    );
  });

  it('does not invent Next route discovery for an unrelated Node package', () => {
    const surface = report.system_roles.plain_node_surface;
    expect(surface.entries).toEqual(['apps/plain-workspace/server/start.ts']);
    expect(Object.keys(surface.reachable_roles)).toEqual(['role_plain_server']);
  });

  it('resolves literal roles and reaches roles assumed by called library functions', () => {
    const surface = report.system_roles.literal_surface;
    expect(Object.keys(surface.reachable_roles)).toEqual(['role_literal', 'shared_writer']);
    expect(surface.unresolved_sites).toEqual([]);
    // role_extra is granted but provably unreachable.
    expect(surface.policy_roles_not_reachable).toEqual(['role_extra']);
  });

  it('follows member accesses to renamed, default, typed and computed-key declarations only', () => {
    const surface = report.system_roles.member_surface;
    expect(Object.keys(surface.reachable_roles)).toEqual([
      'role_computed_member',
      'role_default_export',
      'role_renamed_export',
      'role_typed_member',
    ]);
    expect(surface.unresolved_sites).toEqual([]);
  });

  it('reaches every member-declaration kind through a typed member access', () => {
    const surface = report.system_roles.member_kinds_surface;
    expect(Object.keys(surface.reachable_roles)).toEqual(
      expect.arrayContaining([
        'role_arrow_field',
        'role_enum_key',
        'role_getter',
        'role_mapped',
        'role_namespace',
        'role_shorthand',
        'role_template_key',
      ])
    );
  });

  it('attributes a forwarded role to the wrapper call site, not the declared union', () => {
    expect(Object.keys(report.system_roles.wrapper_surface.reachable_roles)).toEqual(['store_a']);
    expect(report.assumption_sites).toContainEqual({
      site: 'apps/wrapper.ts#<module> (via libs/core/stores.ts#withStoreRole)',
      roles: ['store_a'],
      unresolved: [],
    });
  });

  it('resolves a union of string literals through the type checker', () => {
    expect(Object.keys(report.system_roles.union_surface.reachable_roles)).toEqual([
      'union_a',
      'union_b',
    ]);
  });

  it('never reports an unreferenced function as reachable', () => {
    for (const surface of Object.values(report.system_roles)) {
      expect(surface.reachable_roles).not.toHaveProperty('role_unreachable');
    }
  });

  it('treats a computed dynamic import as an any-role site', () => {
    const surface = report.system_roles.dynamic_surface;
    expect(surface.unresolved_sites).toEqual(['apps/dynamic.ts#load']);
    expect(report.unresolved_sites['apps/dynamic.ts#load'][0]).toMatch(/dynamic import/);
    expect(surface.policy_roles_not_reachable).toEqual([]);
  });

  it('follows createRequire-bound loads like require (S1)', () => {
    const surface = report.system_roles.require_surface;
    expect(Object.keys(surface.reachable_roles)).toEqual(['role_required']);
    expect(surface.unresolved_sites).toEqual([]);
  });

  it('detects promisify(exec), require-bound child_process and worker threads (S9)', () => {
    const surface = report.system_roles.variants_surface;
    expect(Object.keys(surface.reachable_roles)).toEqual([
      'role_promisified',
      'role_required_child',
      'role_worker',
    ]);
    expect(surface.unresolved_sites).toEqual([]);
  });

  it('reports an internal specifier that does not resolve as an any-role site (S1)', () => {
    const surface = report.system_roles.missing_surface;
    expect(surface.unresolved_sites).toEqual(['apps/missing.ts#<module>']);
    expect(report.unresolved_sites['apps/missing.ts#<module>'][0]).toMatch(/not-there\.js/);
    expect(surface.policy_roles_not_reachable).toEqual([]);
  });

  it('walks child processes that inherit SYSTEM_ROLE and skips those that do not', () => {
    const surface = report.system_roles.spawn_surface;
    expect(surface.child_process_entries).toEqual([
      { site: 'apps/spawn.ts#<module>', targets: ['apps/unanalysed.ts', 'scripts/child.ts'] },
    ]);
    expect(Object.keys(surface.reachable_roles)).toEqual(['role_child']);
    // A child entry outside the analysed program is an any-role site.
    expect(surface.unresolved_sites).toEqual(['apps/unanalysed.ts']);
  });

  it('reaches the role a child is delegated through buildExecutionEnv under SYSTEM_ROLE (DR-01)', () => {
    const surface = report.system_roles.delegate_surface;
    // The delegated role itself, forwarded wrapper roles, and what the child
    // entry assumes (still bounded by the parent SYSTEM_ROLE); an env that
    // cannot carry SYSTEM_ROLE delegates nothing.
    expect(Object.keys(surface.reachable_roles)).toEqual([
      'role_delegated',
      'role_forwarded',
      'role_in_delegated_child',
    ]);
    expect(surface.unresolved_sites).toEqual([]);
    expect(report.assumption_sites).toContainEqual({
      site: 'apps/delegate.ts#<module> [delegated child role]',
      roles: ['role_delegated'],
      unresolved: [],
    });
  });

  it('models launch envs, explicit undefined envs and foreign delegations (DR-01)', () => {
    const launch = report.system_roles.launch_surface;
    expect(Object.keys(launch.reachable_roles)).toEqual([
      'role_default_env',
      'role_undefined_env_child',
    ]);
    expect(launch.unresolved_sites).toEqual([]);
    // Delegated under SYSTEM_ROLE=other_surface by launch.ts: other_surface's role.
    expect(Object.keys(report.system_roles.other_surface.reachable_roles)).toEqual([
      'role_for_other',
    ]);
  });

  it('treats a raw non-empty write of KYBERION_DELEGATED_ROLE as an any-role site (DR-01)', () => {
    const surface = report.system_roles.rawwrite_surface;
    expect(surface.unresolved_sites).toEqual(['apps/rawwrite.ts#<module>']);
    expect(report.unresolved_sites['apps/rawwrite.ts#<module>']).toEqual([
      expect.stringMatching(/raw write of KYBERION_DELEGATED_ROLE/),
    ]);
  });

  it('compares reports by content, not by layout', () => {
    expect(normalizeReachabilityReport('{\n  "a": [1, 2]\n}\n')).toBe(
      normalizeReachabilityReport('{"a":[\n1,\n2\n]}')
    );
  });

  it('ignores example paths but not roles in the staleness comparison (S7)', () => {
    const report = (path: string[], roles: string[]) =>
      JSON.stringify({
        system_roles: {
          x: {
            reachable_roles: Object.fromEntries(
              roles.map((role) => [role, { example_path: path }])
            ),
          },
        },
      });
    expect(normalizeReachabilityReport(report(['a#f', 'b#g'], ['r1']))).toBe(
      normalizeReachabilityReport(report(['c#h'], ['r1']))
    );
    expect(normalizeReachabilityReport(report(['a#f'], ['r1']))).not.toBe(
      normalizeReachabilityReport(report(['a#f'], ['r1', 'r2']))
    );
  });
});
