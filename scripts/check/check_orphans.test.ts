import { describe, expect, it } from 'vitest';
import {
  compareWithBaseline,
  exportedSymbols,
  findOrphans,
  updatedBaseline,
  type OrphanBaseline,
  type OrphanSnapshot,
} from './check_orphans.js';

function snapshot(
  files: Record<string, string>,
  opDomains: OrphanSnapshot['opDomains'] = {}
): OrphanSnapshot {
  return { files: new Map(Object.entries(files)), opDomains };
}

const CORE_PACKAGE = JSON.stringify({
  exports: {
    './approval-decision-routing': {
      types: './dist/governance/approval-decision-routing.d.ts',
      default: './dist/governance/approval-decision-routing.js',
    },
  },
});

describe('check_orphans (OW-07)', () => {
  describe('libs/core modules', () => {
    it('flags a module nothing imports and whose exports nobody uses', () => {
      const report = findOrphans(
        snapshot({
          'libs/core/lonely.ts': 'export function lonelyHelper() { return 1; }',
          'libs/core/index-part-01.ts': "export * from './lonely.js';",
          'libs/core/lonely.test.ts': "import { lonelyHelper } from './lonely.js';",
        })
      );
      // A barrel re-export and a test are not callers.
      expect(report.libs_core_modules).toEqual(['libs/core/lonely.ts']);
    });

    it('counts relative imports, package subpaths and exported-symbol use', () => {
      const report = findOrphans(
        snapshot({
          'libs/core/package.json': CORE_PACKAGE,
          'libs/core/a.ts': 'export const a = 1;',
          'libs/core/b.ts': "import { a } from './a.js'; export const b = a;",
          'libs/core/governance/approval-decision-routing.ts': 'export function route() {}',
          'libs/core/c.ts': 'export function viaBarrel() {}',
          'scripts/use.ts': [
            "import { route } from '@agent/core/approval-decision-routing';",
            "import { viaBarrel, b } from '@agent/core';",
            'route(); viaBarrel(); b;',
          ].join('\n'),
          'package.json': '{"scripts":{"use":"node scripts/use.ts"}}',
        })
      );
      expect(report.libs_core_modules).toEqual([]);
    });

    it('reads files that carry NUL bytes', () => {
      const report = findOrphans(
        snapshot({
          'libs/core/binaryish.ts': 'export const binaryish = "\u0000";',
          'scripts/user.ts': "import { binaryish } from '@agent/core';\u0000 binaryish;",
          'package.json': '"scripts/user.ts"',
        })
      );
      expect(report.libs_core_modules).toEqual([]);
    });

    it('counts imported names, not identifiers that merely share the name', () => {
      const report = findOrphans(
        snapshot({
          'libs/core/named.ts': 'export function sharedName() {}',
          'libs/core/namespaced.ts': 'export function viaNamespace() {}',
          'libs/core/dynamic.ts': 'export function viaDynamic() {}',
          'libs/core/coincidence.ts': 'export function status() {}',
          'scripts/a.ts': [
            "import { sharedName as alias } from '@agent/core';",
            "import * as core from '@agent/core';",
            "const { viaDynamic } = await import('@agent/core');",
            // A local `status` variable is not a use of libs/core/coincidence.ts.
            'const status = 1; alias(); core.viaNamespace(); viaDynamic(); status;',
          ].join('\n'),
          'package.json': '"scripts/a.ts"',
        })
      );
      expect(report.libs_core_modules).toEqual(['libs/core/coincidence.ts']);
    });

    it('extracts declared and listed exports', () => {
      expect(
        exportedSymbols(
          'export async function f() {}\nexport interface I {}\nconst x = 1;\nexport { x as y, type Z };'
        ).sort()
      ).toEqual(['I', 'Z', 'f', 'y']);
    });
  });

  it('flags top-level scripts nothing invokes', () => {
    const report = findOrphans(
      snapshot({
        'scripts/wired.ts': 'export {};',
        'scripts/imported.ts': 'export {};',
        'scripts/loose.ts': '// mentions loose.ts in its own header only\nexport {};',
        'scripts/lib/helper.ts': 'export {};',
        'scripts/runner.ts': "import './imported.js';",
        'package.json':
          '{"scripts":{"wired":"node dist/scripts/wired.js","run":"tsx scripts/runner.ts"}}',
        'scripts/loose.test.ts': "import './loose.js';",
      })
    );
    expect(report.scripts).toEqual(['scripts/loose.ts']);
  });

  it('accepts a schedule, a reference or a README row for a pipeline', () => {
    const report = findOrphans(
      snapshot({
        'pipelines/scheduled.json': JSON.stringify({ pipeline_id: 'scheduled', schedule: {} }),
        'pipelines/documented.json': JSON.stringify({ pipeline_id: 'documented' }),
        'pipelines/called.json': JSON.stringify({ pipeline_id: 'called' }),
        'pipelines/lost.json': JSON.stringify({ pipeline_id: 'lost' }),
        'pipelines/README.md': '| `documented` | Does a thing |',
        'scripts/caller.ts': "run('pipelines/called.json');",
        'package.json': '"scripts/caller.ts"',
      })
    );
    expect(report.pipelines).toEqual(['pipelines/lost.json']);
    // A README row alone is a docs-only mention, tracked as its own kind.
    expect(report.documented_only).toEqual(['pipelines/documented.json']);
  });

  it('does not count a ratchet inventory listing as a pipeline caller', () => {
    const report = findOrphans(
      snapshot({
        'pipelines/listed.json': JSON.stringify({ pipeline_id: 'listed' }),
        'knowledge/product/governance/shared-tmp-allowlist.json': JSON.stringify({
          pipeline_literals: [{ file: 'pipelines/listed.json', count: 1 }],
        }),
      })
    );
    expect(report.pipelines).toEqual(['pipelines/listed.json']);
  });

  it('counts a disabled (opt-in) schedule as wired', () => {
    const report = findOrphans(
      snapshot({
        'pipelines/opt-in.json': JSON.stringify({
          pipeline_id: 'opt-in',
          schedule: { id: 'opt-in-weekly', cron: '0 3 * * 0', enabled: false },
        }),
      })
    );
    expect(report.pipelines).toEqual([]);
    expect(report.documented_only).toEqual([]);
  });

  it('requires an op reference outside its own actuator and the catalogs', () => {
    const report = findOrphans(
      snapshot(
        {
          'libs/actuators/browser-actuator/src/index.ts':
            "switch (op) { case 'click': break; } const x = { op: 'self_only' };",
          'libs/actuators/browser-actuator/src/op-catalog.ts': "'browser:catalog_only'",
          'knowledge/product/governance/actuator-op-registry.json': '"browser:registry_only"',
          'pipelines/flow.json': JSON.stringify({
            pipeline_id: 'flow',
            schedule: {},
            steps: [{ op: 'browser:goto' }, { op: 'click' }],
          }),
        },
        {
          browser: {
            capture: ['goto', 'catalog_only', 'registry_only'],
            apply: ['click', 'self_only'],
          },
        }
      )
    );
    expect(report.actuator_ops).toEqual([
      'browser:catalog_only',
      'browser:registry_only',
      'browser:self_only',
    ]);
  });

  it('treats an op advertised in the discovery catalog and named by a test as agent-callable', () => {
    const discovery = JSON.stringify({
      actuators: [
        {
          n: 'media-actuator',
          ops: [
            { op: 'tested' },
            { op: 'stepped' },
            { op: 'mentioned' },
            { op: 'untested' },
            { op: 'qualified' },
          ],
        },
      ],
    });
    const report = findOrphans(
      snapshot(
        {
          'knowledge/product/orchestration/actuator-op-discovery.json': discovery,
          'libs/actuators/media-actuator/src/ops.test.ts': [
            "await actuator.dispatch('tested', {});",
            "handleAction({ action: 'stepped', params: {} });",
            // Any other quoted string that equals an op name is not an exercise.
            "expect(result.status).toBe('mentioned');",
          ].join('\n'),
          // A qualified `domain:op` in any test counts; a bare name elsewhere does not.
          'tests/media.test.ts': "expect(ids).toContain('media:qualified'); run('unadvertised');",
          'libs/actuators/other-actuator/src/x.test.ts': "dispatch('untested');",
        },
        {
          media: {
            capture: ['tested', 'stepped', 'mentioned', 'untested', 'qualified', 'unadvertised'],
          },
        }
      )
    );
    expect(report.actuator_ops).toEqual([
      'media:mentioned',
      'media:unadvertised',
      'media:untested',
    ]);
  });

  it('attributes a bare op literal only to the domain its file targets', () => {
    const report = findOrphans(
      snapshot(
        {
          // `op: 'status'` in a file that only talks to the system actuator.
          'scripts/system-caller.ts': "run({ actuator: 'system', op: 'status' });",
          'scripts/browser-caller.ts':
            "browserActuator.run({ op: 'snapshot' }); // browser-actuator",
          'package.json': '"scripts/system-caller.ts scripts/browser-caller.ts"',
        },
        { system: { capture: ['status'] }, browser: { capture: ['status', 'snapshot'] } }
      )
    );
    expect(report.actuator_ops).toEqual(['browser:status']);
  });

  it('treats an op the provider bridge resolves to a cli_native harness capability as reachable', () => {
    const capability = (type: string, provider: string, name: string) =>
      JSON.stringify({
        capabilities: [{ capability_id: `x.${name}`, source: { type, provider, name } }],
      });
    const report = findOrphans(
      snapshot(
        {
          'knowledge/product/governance/harness-capabilities/a.json': capability(
            'cli_native',
            'codex-cli',
            'cloud'
          ),
          'knowledge/product/governance/harness-capabilities/b.json': capability(
            'agent_runtime',
            'codex-cli',
            'app-server'
          ),
        },
        { codex: { capture: ['cloud', 'app-server'] } }
      )
    );
    expect(report.actuator_ops).toEqual(['codex:app-server']);
  });

  it('counts side-effect imports in a barrel (self-registering modules)', () => {
    const report = findOrphans(
      snapshot({
        'libs/core/provider/bundles/one.ts': "registerBundle('one');\nexport {};",
        'libs/core/provider/bundles/two.ts': "export const two = registerBundle('two');",
        'libs/core/provider/bundles/index.ts': "import './one.js';",
        'libs/core/provider/index.ts': "export * from './bundles/two.js';",
        'libs/core/reasoning/runtime.ts': "import '../provider/bundles/index.js';",
      })
    );
    // `two` is only re-exported (not a caller); `one` is loaded for its side effect.
    expect(report.libs_core_modules.filter((file) => file.includes('/bundles/'))).toEqual([
      'libs/core/provider/bundles/two.ts',
    ]);
  });

  describe('baseline ratchet', () => {
    const baseline: OrphanBaseline = {
      version: 1,
      libs_core_modules: [{ id: 'libs/core/old.ts', reason: 'kept on purpose' }],
      scripts: [{ id: 'scripts/fixed.ts', reason: 'was orphaned' }],
      pipelines: [{ id: 'pipelines/x.json', reason: 'TODO: explain' }],
      documented_only: [],
      actuator_ops: [],
    };

    it('reports new orphans, stale entries and unreasoned entries', () => {
      const comparison = compareWithBaseline(
        {
          libs_core_modules: ['libs/core/new.ts', 'libs/core/old.ts'],
          scripts: [],
          pipelines: ['pipelines/x.json'],
          documented_only: [],
          actuator_ops: [],
        },
        baseline
      );
      expect(comparison.added.libs_core_modules).toEqual(['libs/core/new.ts']);
      expect(comparison.stale.scripts).toEqual(['scripts/fixed.ts']);
      expect(comparison.invalid).toEqual(['pipelines: pipelines/x.json needs a reason']);
    });

    it('rejects placeholder backlog reasons', () => {
      const comparison = compareWithBaseline(
        {
          libs_core_modules: [],
          scripts: ['scripts/x.ts'],
          pipelines: [],
          documented_only: [],
          actuator_ops: [],
        },
        {
          version: 1,
          libs_core_modules: [],
          scripts: [
            { id: 'scripts/x.ts', reason: 'No caller yet (OW-07 backlog: wire or retire).' },
          ],
          pipelines: [],
          documented_only: [],
          actuator_ops: [],
        }
      );
      expect(comparison.invalid).toEqual([
        'scripts: scripts/x.ts has a placeholder backlog reason — wire, retire or record the reviewed decision',
      ]);
    });

    it('keeps reasons, drops stale entries and marks new ones TODO on update', () => {
      const next = updatedBaseline(
        {
          libs_core_modules: ['libs/core/new.ts', 'libs/core/old.ts'],
          scripts: [],
          pipelines: [],
          documented_only: [],
          actuator_ops: [],
        },
        baseline
      );
      expect(next.libs_core_modules).toEqual([
        { id: 'libs/core/new.ts', reason: expect.stringMatching(/^TODO/) },
        { id: 'libs/core/old.ts', reason: 'kept on purpose' },
      ]);
      expect(next.scripts).toEqual([]);
    });
  });
});
