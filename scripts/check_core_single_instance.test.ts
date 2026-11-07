import { describe, expect, it } from 'vitest';
import {
  CORE_SOURCE_IMPORT_EXCEPTIONS,
  checkCoreSingleInstance,
  coreRelativeImports,
  productionSourceFiles,
} from './check_core_single_instance.js';

describe('core single-instance gate', () => {
  it('finds every runtime form of a relative libs/core import, from any depth', () => {
    const forms = [
      `import { a } from '../libs/core/secure-io.js';`,
      `import '../libs/core/secure-io.js';`,
      `export { a } from '../libs/core/secure-io.js';`,
      `export * from '../libs/core/index.js';`,
      `const m = await import('../libs/core/secure-io.js');`,
      `const m = require('../libs/core/secure-io.js');`,
      `import m = require('../libs/core/secure-io.js');`,
      `import { type A, b } from '../libs/core/secure-io.js';`,
    ];
    for (const text of forms)
      expect(coreRelativeImports('scripts/foreign.ts', text), text).toEqual([
        expect.stringContaining('libs/core'),
      ]);
    // From inside libs/: the path never spells libs/core.
    expect(
      coreRelativeImports(
        'libs/actuators/x-actuator/src/index.ts',
        `import { a } from '../../../core/foundation/ajv.js';`
      )
    ).toEqual(['../../../core/foundation/ajv.js']);
    expect(
      coreRelativeImports(
        'presence/displays/concierge/src/lib/x.ts',
        `const m = import('../../../../../libs/core/tier-guard.js');`
      )
    ).toHaveLength(1);
  });

  it('ignores package imports, type-only imports, comments and libs/core itself', () => {
    for (const text of [
      `import { a } from '@agent/core/secure-io';`,
      `import type { A } from '../libs/core/secure-io.js';`,
      `export type { A } from '../libs/core/secure-io.js';`,
      `// see '../libs/core/secure-io.js'`,
      `const docs = 'libs/core/secure-io.ts';`,
      `import { a } from '../libs/core-like/x.js';`,
    ])
      expect(coreRelativeImports('scripts/foreign.ts', text), text).toEqual([]);
    expect(coreRelativeImports('libs/core/a.ts', `import { b } from './b.js';`)).toEqual([]);
  });

  it('fails an unlisted importer and a stale exception', () => {
    const files: Record<string, string> = {
      'scripts/foreign.ts': `import { a } from '../libs/core/secure-io.js';`,
      'scripts/listed.ts': `import { a } from '../libs/core/secure-io.js';`,
      'scripts/stale.ts': `import { a } from '@agent/core/secure-io';`,
    };
    const violations = checkCoreSingleInstance(
      Object.keys(files),
      (relative) => files[relative]!,
      new Map([
        ['scripts/listed.ts', 'bootstrap'],
        ['scripts/stale.ts', 'was bootstrap'],
      ])
    );
    expect(violations).toEqual([
      expect.stringMatching(/^scripts\/foreign\.ts: import @agent\/core by package name/),
      expect.stringMatching(/^scripts\/stale\.ts: listed in CORE_SOURCE_IMPORT_EXCEPTIONS/),
    ]);
  });

  it('scans production sources only and keeps the repository clean', () => {
    const files = productionSourceFiles();
    expect(files).toContain('scripts/build_repository.ts');
    expect(files.some((file) => file.startsWith('libs/core/'))).toBe(false);
    expect(files.some((file) => /\.(?:test|spec)\.[^/]+$/.test(file))).toBe(false);
    expect(files.some((file) => file.startsWith('tests/'))).toBe(false);
    for (const reason of CORE_SOURCE_IMPORT_EXCEPTIONS.values()) expect(reason).not.toBe('');
    expect(checkCoreSingleInstance(files)).toEqual([]);
  }, 60_000);
});
