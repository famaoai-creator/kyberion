/**
 * Shared trusted-import boundary check for the module-private store grants of
 * G2 (store-catalog guard design): only the governed facade names the issuer,
 * and every other module that imports the capability module is a named,
 * value-only consumer of the names listed for it. Type-only imports are erased
 * at runtime and do not count. Test files are outside the boundary (vitest
 * aliases one source instance; tests open grants to exercise them).
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeReadFile, safeReaddir, safeLstat } from '@agent/core/secure-io';
import ts from 'typescript';

export interface StoreGrantBoundary {
  /** Repository-relative capability module. */
  implementation: string;
  /** Issuer identifier -> the only files (besides the implementation) that may name it. */
  issuers: ReadonlyMap<string, readonly string[]>;
  /** Named value imports allowed per consumer; any other importer is a violation. */
  consumers: ReadonlyMap<string, readonly string[]>;
}

function moduleBase(boundary: StoreGrantBoundary): string {
  return path.posix.basename(boundary.implementation).replace(/\.ts$/, '');
}

function modulePattern(boundary: StoreGrantBoundary): RegExp {
  const base = moduleBase(boundary).replace(/[-]/g, '\\-');
  return new RegExp(`(?:^|/)${base}(?:\\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))?$`);
}

export function storeGrantBoundaryViolations(
  boundary: StoreGrantBoundary,
  relative: string,
  text: string
): string[] {
  if (relative === boundary.implementation) return [];
  const pattern = modulePattern(boundary);
  const problems: string[] = [];
  const module = (value: ts.Node | undefined) =>
    value && ts.isStringLiteralLike(value) && pattern.test(value.text.replace(/\\/g, '/'));
  const allowed = boundary.consumers.get(relative);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && module(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (clause?.isTypeOnly) return ts.forEachChild(node, visit);
      if (clause?.name || (bindings && !ts.isNamedImports(bindings)))
        problems.push('default or namespace import of a store grant module');
      else if (!bindings) problems.push('side-effect import of a store grant module');
      else
        for (const entry of bindings.elements) {
          if (entry.isTypeOnly) continue;
          const imported = (entry.propertyName ?? entry.name).text;
          if (!allowed) problems.push(`import of ${boundary.implementation} outside its consumers`);
          else if (!allowed.includes(imported)) problems.push(`import of ${imported} not allowed`);
          if (entry.propertyName && boundary.issuers.has(imported))
            problems.push(`aliased issuer import ${imported}`);
        }
    }
    if (ts.isExportDeclaration(node) && module(node.moduleSpecifier))
      problems.push('reexport of a store grant module is forbidden');
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      module(node.moduleReference.expression)
    )
      problems.push('import = require of a store grant module is forbidden');
    if (
      ts.isCallExpression(node) &&
      module(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      problems.push('dynamic import of a store grant module is forbidden');
    if (ts.isIdentifier(node) && boundary.issuers.has(node.text)) {
      if (!boundary.issuers.get(node.text)!.includes(relative))
        problems.push(`issuer ${node.text} outside its governed callers`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true));
  return problems;
}

const IGNORED = new Set([
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

/** Product source files of the checkout (no tests, fixtures, builds or declarations). */
export function productSourceFiles(): string[] {
  const source = process.cwd();
  return safeReaddir(source)
    .flatMap((entry) => {
      if (IGNORED.has(entry) || entry.startsWith('.')) return [];
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
}

/**
 * The three boundary checks: no package export, no violation in the checkout,
 * and every forbidden import form refused for foreign modules while each named
 * consumer's own import stays allowed. `formerConsumers` are modules that once
 * imported the capability module and may no longer.
 */
export function describeStoreGrantBoundary(
  title: string,
  boundary: StoreGrantBoundary,
  options: { formerConsumers?: readonly string[] } = {}
): void {
  const base = moduleBase(boundary);
  const issuers = [...boundary.issuers.keys()];
  describe(title, () => {
    it('never publishes the capability module through a package export', () => {
      const manifest = safeReadFile(path.join(process.cwd(), 'libs/core/package.json'), {
        encoding: 'utf8',
      }) as string;
      expect(manifest).not.toContain(base);
      expect(JSON.parse(manifest).exports?.['./*']).toBeUndefined();
    });

    it('restricts the issuer to its governed facade and the predicates to named consumers', () => {
      const source = process.cwd();
      const files = productSourceFiles();
      for (const expected of [
        boundary.implementation,
        ...[...boundary.issuers.values()].flat(),
        ...boundary.consumers.keys(),
      ])
        expect(
          files.some((file) => file.endsWith(expected)),
          expected
        ).toBe(true);
      const mention = new RegExp([base, ...issuers].join('|'));
      for (const file of files) {
        const relative = path.relative(source, file).split(path.sep).join('/');
        const text = safeReadFile(file, { encoding: 'utf8' }) as string;
        if (!mention.test(text)) continue;
        expect(storeGrantBoundaryViolations(boundary, relative, text), relative).toEqual([]);
      }
    });

    it('rejects namespace, default, aliased, dynamic and barrel access', () => {
      const issuerCallers = new Set([...boundary.issuers.values()].flat());
      const foreign = [
        'libs/core/authority.ts',
        'libs/core/tier-guard.ts',
        'libs/core/tier-guard-store-grants.ts',
        'libs/core/index.ts',
        'scripts/foreign.ts',
        'presence/displays/concierge/app/api/foreign.ts',
        ...(options.formerConsumers ?? []),
      ].filter((file) => !issuerCallers.has(file));
      for (const extension of ['', '.ts', '.js', '.mjs', '.cjs']) {
        const target = '../foundation/' + base + extension;
        const forms = [
          `import * as cap from '${target}';`,
          `import cap from '${target}';`,
          `import '${target}';`,
          `import cap = require('${target}');`,
          `export * from '${target}';`,
          `const cap = require('${target}');`,
          `const cap = import('${target}');`,
          ...issuers.flatMap((issuer) => [
            `export {${issuer} as facade} from '${target}';`,
            `import {${issuer} as hidden} from '${target}';`,
            `import {${issuer}} from '${target}';`,
          ]),
        ];
        for (const consumer of foreign)
          for (const text of forms)
            expect(
              storeGrantBoundaryViolations(boundary, consumer, text).length,
              `${consumer}: ${text}`
            ).toBeGreaterThan(0);
        for (const [consumer, names] of boundary.consumers)
          expect(
            storeGrantBoundaryViolations(
              boundary,
              consumer,
              `import {${names.join(', ')}} from '${target}';`
            ),
            consumer
          ).toEqual([]);
        for (const former of options.formerConsumers ?? [])
          for (const names of boundary.consumers.values())
            expect(
              storeGrantBoundaryViolations(
                boundary,
                former,
                `import {${names.join(', ')}} from '${target}';`
              ).length,
              former
            ).toBeGreaterThan(0);
      }
    });
  });
}
