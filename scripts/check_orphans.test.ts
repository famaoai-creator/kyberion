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

  describe('baseline ratchet', () => {
    const baseline: OrphanBaseline = {
      version: 1,
      libs_core_modules: [{ id: 'libs/core/old.ts', reason: 'kept on purpose' }],
      scripts: [{ id: 'scripts/fixed.ts', reason: 'was orphaned' }],
      pipelines: [{ id: 'pipelines/x.json', reason: 'TODO: explain' }],
      actuator_ops: [],
    };

    it('reports new orphans, stale entries and unreasoned entries', () => {
      const comparison = compareWithBaseline(
        {
          libs_core_modules: ['libs/core/new.ts', 'libs/core/old.ts'],
          scripts: [],
          pipelines: ['pipelines/x.json'],
          actuator_ops: [],
        },
        baseline
      );
      expect(comparison.added.libs_core_modules).toEqual(['libs/core/new.ts']);
      expect(comparison.stale.scripts).toEqual(['scripts/fixed.ts']);
      expect(comparison.invalid).toEqual(['pipelines: pipelines/x.json needs a reason']);
    });

    it('keeps reasons, drops stale entries and marks new ones TODO on update', () => {
      const next = updatedBaseline(
        {
          libs_core_modules: ['libs/core/new.ts', 'libs/core/old.ts'],
          scripts: [],
          pipelines: [],
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
