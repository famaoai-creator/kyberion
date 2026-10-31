import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeReadFile, safeReaddir, safeLstat } from '@agent/core/secure-io';
import ts from 'typescript';

const issuers = new Set([
  'libs/core/foundation/dot-result-store-capability.ts',
  'libs/core/dot/dot-result-store.ts',
]);
const predicates = new Set(['libs/core/authority.ts', 'libs/core/tier-guard.ts']);
const originImplementation = 'libs/core/dot/dot-result-origin.ts';
const originValues = new Map([
  ['mintDotResultOutcomePermit', 'libs/core/dot/dot-executor.ts'],
  ['mintDotReportMarkerPermit', 'libs/core/dot/dot-executor-reports.ts'],
  ['consumeDotResultOutcomePermit', 'libs/core/dot/dot-result-store.ts'],
  ['consumeDotReportMarkerPermit', 'libs/core/dot/dot-result-store.ts'],
]);
const originTypes = new Set([
  'DotResultOutcomeOrigin',
  'DotReportMarkerOrigin',
  'DotResultOutcomePermit',
  'DotReportMarkerPermit',
]);
function privateExportTargets(exports: unknown): string[] {
  const privateFiles = [
    'foundation/dot-result-store-capability',
    'dot/dot-result-origin',
    'dot/dot-result-store',
    'surface/front-desk-recovery-evidence',
  ].flatMap((name) =>
    ['', '.js', '.d.ts', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].map(
      (extension) => 'dist/' + name + extension
    )
  );
  const targets: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const target = path.posix.normalize(value.replace(/\\/g, '/'));
      const pattern = new RegExp(
        '^' +
          target
            .split('*')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*') +
          '$'
      );
      if (privateFiles.some((file) => pattern.test(file))) targets.push(value);
    } else if (value && typeof value === 'object')
      for (const child of Object.values(value)) visit(child);
  };
  visit(exports);
  return targets;
}
function violations(relative: string, text: string): string[] {
  if (
    !/dot-result-store-capability|withDotResultStoreCapability|dot-result-origin|(?:mint|consume)Dot(?:ResultOutcome|ReportMarker)Permit/.test(
      text
    )
  )
    return [];
  const problems: string[] = [];
  const module = (value: ts.Node | undefined) =>
    value &&
    ts.isStringLiteralLike(value) &&
    /(?:^|\/)dot-result-store-capability(?:\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))?$/.test(
      value.text.replace(/\\/g, '/')
    );
  const originModule = (value: ts.Node | undefined) =>
    value &&
    ts.isStringLiteralLike(value) &&
    /(?:^|\/)dot-result-origin(?:\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))?$/.test(
      value.text.replace(/\\/g, '/')
    );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && originModule(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = clause?.namedBindings;
      if (
        clause?.name ||
        !names ||
        !ts.isNamedImports(names) ||
        names.elements.some((entry) => {
          const name = (entry.propertyName ?? entry.name).text;
          return clause.isTypeOnly || entry.isTypeOnly
            ? !originTypes.has(name)
            : originValues.get(name) !== relative;
        })
      )
        problems.push('origin import is outside its exact producer or consumer');
    }
    if (ts.isExportDeclaration(node) && originModule(node.moduleSpecifier))
      problems.push('origin reexport is forbidden');
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.some((entry) =>
        originValues.has((entry.propertyName ?? entry.name).text)
      )
    )
      problems.push('origin value reexport is forbidden');
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      originModule(node.moduleReference.expression)
    )
      problems.push('origin namespace import is forbidden');
    if (
      ts.isCallExpression(node) &&
      originModule(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      problems.push('origin namespace import is forbidden');
    if (
      ts.isIdentifier(node) &&
      originValues.has(node.text) &&
      relative !== originImplementation &&
      originValues.get(node.text) !== relative
    )
      problems.push('origin value identifier is outside its exact producer or consumer');
    if (ts.isImportDeclaration(node) && module(node.moduleSpecifier)) {
      if (!issuers.has(relative)) {
        const clause = node.importClause;
        const names = clause?.namedBindings;
        if (
          !predicates.has(relative) ||
          clause?.name ||
          !names ||
          !ts.isNamedImports(names) ||
          names.elements.some(
            (entry) =>
              !['DOT_RESULT_STORE_ROLE', 'isDotResultStoreCapability'].includes(
                (entry.propertyName ?? entry.name).text
              )
          )
        )
          problems.push(
            'capability value import outside fixed facade or named predicate consumers'
          );
      }
    }
    if (ts.isExportDeclaration(node) && module(node.moduleSpecifier))
      problems.push('capability reexport is forbidden');
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      module(node.moduleReference.expression) &&
      !issuers.has(relative)
    )
      problems.push('namespace capability import is forbidden');
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.some(
        (entry) => (entry.propertyName ?? entry.name).text === 'withDotResultStoreCapability'
      )
    )
      problems.push('issuer reexport is forbidden');
    if (
      ts.isCallExpression(node) &&
      module(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      !issuers.has(relative)
    )
      problems.push('namespace capability import is forbidden');
    if (
      ts.isIdentifier(node) &&
      node.text === 'withDotResultStoreCapability' &&
      !issuers.has(relative)
    )
      problems.push('issuer identifier outside fixed facade');
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true));
  return problems;
}

describe('DOT result capability trusted import boundary', () => {
  it('never publishes private capability, origin or store targets through any package export alias', () => {
    const manifest = JSON.parse(
      safeReadFile(path.join(process.cwd(), 'libs/core/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(privateExportTargets(manifest.exports)).toEqual([]);
    expect(
      privateExportTargets({
        './alias': {
          types: './dist/dot/dot-result-origin.d.ts',
          default: './dist/dot/dot-result-store.js',
        },
      })
    ).toHaveLength(2);
    expect(
      privateExportTargets({
        './alias': { node: { default: './dist/foundation/dot-result-store-capability.js' } },
      })
    ).toHaveLength(1);
    expect(privateExportTargets({ './*': './dist/*' })).toHaveLength(1);
    expect(
      privateExportTargets({
        './dot/dot-result-records': {
          types: './dist/dot/dot-result-records.d.ts',
          default: './dist/dot/dot-result-records.js',
        },
      })
    ).toEqual([]);
  });
  it('restricts issuer use to its implementation, focused tests and the governed result facade', () => {
    const source = process.cwd();
    const ignored = new Set([
      '.git',
      '.worktrees',
      '.codex',
      '.agents',
      '.claude',
      '.gemini',
      'node_modules',
      'dist',
      'build',
      'generated',
      'retired',
      'archive',
      'archives',
      '.aws',
      '.azure',
      '.gcloud',
      '.ssh',
      '.npm',
      '.pnpm-store',
      'coverage',
      'active',
      'vault',
      'work',
      'tests',
      'tests_ai',
      'knowledge',
      'customer',
      'evidence',
    ]);
    const files = safeReaddir(source)
      .flatMap((entry) => {
        if (ignored.has(entry)) return [];
        const target = path.join(source, entry);
        const stat = safeLstat(target);
        return stat.isSymbolicLink() ? [] : stat.isDirectory() ? getAllFiles(target) : [target];
      })
      .filter(
        (file) =>
          /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(file) &&
          !/(?:^|\/)(?:dist|node_modules|fixtures|__fixtures__|__tests__|test-fixtures|\.next|\.nuxt)\//.test(
            file
          ) &&
          !/\.(?:test|spec)\.[^/]+$/.test(file) &&
          !file.endsWith('.d.ts')
      );
    for (const file of files) {
      const relative = path.relative(source, file).split(path.sep).join('/');
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      expect(violations(relative, text), relative).toEqual([]);
    }
  });
  it('rejects namespace/default/aliased issuer and barrel access for every source extension', () => {
    for (const extension of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']) {
      const target = '../foundation/dot-result-store-capability' + extension;
      for (const text of [
        `import * as cap from '${target}';`,
        `import cap from '${target}';`,
        `import cap = require('${target}');`,
        `export * from '${target}';`,
        `export {withDotResultStoreCapability as facade} from '${target}';`,
        `import {withDotResultStoreCapability as hidden} from '${target}';`,
        `const cap = require('${target}');`,
        `const cap = import('${target}');`,
      ])
        for (const consumer of [
          'libs/core/authority.ts',
          'libs/core/tier-guard.ts',
          'scripts/foreign.ts',
          'plugins/foreign.mjs',
        ])
          expect(violations(consumer, text).length, text).toBeGreaterThan(0);
      expect(
        violations(
          'libs/core/authority.ts',
          `import {isDotResultStoreCapability,DOT_RESULT_STORE_ROLE} from '${target}';`
        )
      ).toEqual([]);
      expect(
        violations(
          'libs/core/dot/dot-result-store.ts',
          `import {withDotResultStoreCapability} from '${target}';`
        )
      ).toEqual([]);
    }
  });
  it('separates outcome and report producers from consumers across aliases and all module extensions', () => {
    for (const extension of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']) {
      const target = './dot-result-origin' + extension;
      for (const [value, owner] of originValues) {
        expect(violations(owner, `import {${value} as local} from '${target}'; local();`)).toEqual(
          []
        );
        for (const consumer of [
          'scripts/foreign.ts',
          'plugins/foreign.mjs',
          ...new Set(originValues.values()),
        ]) {
          if (consumer !== owner)
            expect(
              violations(consumer, `import {${value} as local} from '${target}'; local();`).length
            ).toBeGreaterThan(0);
          expect(
            violations(consumer, `export {${value} as alias} from '${target}';`).length
          ).toBeGreaterThan(0);
        }
      }
      for (const consumer of [
        'libs/core/dot/dot-executor.ts',
        'libs/core/dot/dot-executor-reports.ts',
        'libs/core/dot/dot-result-store.ts',
        'scripts/foreign.ts',
      ]) {
        for (const text of [
          `import * as origin from '${target}';`,
          `import origin from '${target}';`,
          `import origin = require('${target}');`,
          `const origin = require('${target}');`,
          `const origin = import('${target}');`,
          `export * from '${target}';`,
        ])
          expect(violations(consumer, text).length, text).toBeGreaterThan(0);
      }
      expect(
        violations(
          'scripts/type-only.ts',
          `import type {DotResultOutcomePermit,DotReportMarkerOrigin} from '${target}';`
        )
      ).toEqual([]);
      expect(
        violations('scripts/type-only.ts', `import {type DotResultOutcomePermit} from '${target}';`)
      ).toEqual([]);
      expect(
        violations('scripts/type-only.ts', `import {DotResultOutcomePermit} from '${target}';`)
          .length
      ).toBeGreaterThan(0);
    }
  });
});
