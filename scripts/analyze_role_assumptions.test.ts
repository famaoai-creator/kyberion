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
      { id: 'wrapper-surface', command: 'node', args: ['dist/apps/wrapper.js'] },
      { id: 'union-surface', command: 'node', args: ['dist/apps/union.js'] },
      { id: 'dynamic-surface', command: 'node', args: ['dist/apps/dynamic.js'] },
      { id: 'require-surface', command: 'node', args: ['dist/apps/required.js'] },
      { id: 'variants-surface', command: 'node', args: ['dist/apps/variants.js'] },
      { id: 'missing-surface', command: 'node', args: ['dist/apps/missing.js'] },
      { id: 'spawn-surface', command: 'node', args: ['dist/apps/spawn.js'] },
    ],
  }),
  'libs/core/authority.ts': [
    'export function withExecutionContext<T>(role: string, fn: () => T): T {',
    '  return fn();',
    '}',
    'export async function withExecutionContextAsync<T>(role: string, fn: () => Promise<T>): Promise<T> {',
    '  return fn();',
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

  it('resolves literal roles and reaches roles assumed by called library functions', () => {
    const surface = report.system_roles.literal_surface;
    expect(Object.keys(surface.reachable_roles)).toEqual(['role_literal', 'shared_writer']);
    expect(surface.unresolved_sites).toEqual([]);
    // role_extra is granted but provably unreachable.
    expect(surface.policy_roles_not_reachable).toEqual(['role_extra']);
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
