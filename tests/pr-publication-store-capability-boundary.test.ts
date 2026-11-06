import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeReadFile, safeReaddir, safeLstat } from '@agent/core/secure-io';
import ts from 'typescript';

// G2: the PR publication binding and store grant are module-private. Only the
// governed runtime issues them, and only the VCS hosts and the two store facades
// may open a binding or a store access.
const capability = 'libs/core/foundation/pr-publication-store-capability.ts';
const runtime = 'libs/core/governance/pr-publication-runtime.ts';
const publicationHost = 'libs/core/vcs/publication-host.ts';
const governanceHost = 'libs/core/vcs/governance-host.ts';
const charterRegistry = 'libs/core/governance/accountability-charter-registry.ts';
const reservationStore = 'libs/core/governance/external-operation-store.ts';

interface Boundary {
  implementation: string;
  pattern: RegExp;
  /** Issuer identifier -> the only files (besides the implementation) that may name it. */
  issuers: ReadonlyMap<string, readonly string[]>;
  /** Named value imports allowed per consumer; undefined = any non-issuer name. */
  consumers?: ReadonlyMap<string, readonly string[]>;
}

const boundaries: Boundary[] = [
  {
    implementation: capability,
    pattern: /(?:^|\/)pr-publication-store-capability(?:\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))?$/,
    issuers: new Map([
      ['withPrPublicationBinding', [runtime]],
      ['withPrPublicationStoreGrant', [runtime]],
    ]),
    // G2: the grant alone authorizes; tier-guard asks its predicates and the store-grant
    // table asks the authority (authority.ts refuses the name through retired-store-roles).
    consumers: new Map([
      [
        runtime,
        [
          'currentPrPublicationBinding',
          'PR_PUBLICATION_GRANT_ISSUANCE_RIGHT',
          'withPrPublicationBinding',
          'withPrPublicationStoreGrant',
        ],
      ],
      [
        'libs/core/tier-guard.ts',
        [
          'prPublicationGrantTenant',
          'prPublicationResourceAllowed',
          'prPublicationStoreGrantActive',
        ],
      ],
      ['libs/core/tier-guard-store-grants.ts', ['prPublicationGrantAuthorizes']],
    ]),
  },
  {
    implementation: runtime,
    pattern: /(?:^|\/)pr-publication-runtime(?:\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))?$/,
    issuers: new Map([
      ['withPrPublicationRuntime', [publicationHost, governanceHost]],
      [
        'withPrPublicationStoreAccess',
        [publicationHost, governanceHost, charterRegistry, reservationStore],
      ],
    ]),
  },
];

function violations(relative: string, text: string): string[] {
  const problems: string[] = [];
  for (const boundary of boundaries) {
    if (relative === boundary.implementation) continue;
    const module = (value: ts.Node | undefined) =>
      value &&
      ts.isStringLiteralLike(value) &&
      boundary.pattern.test(value.text.replace(/\\/g, '/'));
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && module(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const allowed = boundary.consumers?.get(relative);
        // Type-only imports are erased at runtime.
        if (clause?.isTypeOnly) return ts.forEachChild(node, visit);
        if (clause?.name || (bindings && !ts.isNamedImports(bindings)))
          problems.push('default or namespace import of a publication grant module');
        else if (bindings && ts.isNamedImports(bindings))
          for (const entry of bindings.elements) {
            if (entry.isTypeOnly) continue;
            const imported = (entry.propertyName ?? entry.name).text;
            if (boundary.consumers && !allowed)
              problems.push(`import of ${boundary.implementation} outside its named consumers`);
            else if (allowed && !allowed.includes(imported))
              problems.push(`import of ${imported} is not allowed here`);
            if (entry.propertyName && boundary.issuers.has(imported))
              problems.push(`aliased issuer import ${imported}`);
          }
      }
      if (ts.isExportDeclaration(node) && module(node.moduleSpecifier)) {
        // Only a named, issuer-free re-export by an allowed consumer (e.g. the core barrel).
        const clause = node.exportClause;
        const allowed = boundary.consumers?.get(relative);
        if (
          !clause ||
          !ts.isNamedExports(clause) ||
          clause.elements.some((entry) => {
            const name = (entry.propertyName ?? entry.name).text;
            return (
              boundary.issuers.has(name) ||
              (boundary.consumers !== undefined && !(allowed ?? []).includes(name))
            );
          })
        )
          problems.push('reexport of a publication grant module is forbidden');
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        module(node.moduleReference.expression)
      )
        problems.push('import = require of a publication grant module is forbidden');
      if (
        ts.isCallExpression(node) &&
        module(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        problems.push('dynamic import of a publication grant module is forbidden');
      if (ts.isIdentifier(node) && boundary.issuers.has(node.text)) {
        if (!boundary.issuers.get(node.text)!.includes(relative))
          problems.push(`issuer ${node.text} outside its governed callers`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true));
  }
  return problems;
}

describe('PR publication grant trusted import boundary', () => {
  it('never publishes the capability module through a package export', () => {
    const manifest = safeReadFile(path.join(process.cwd(), 'libs/core/package.json'), {
      encoding: 'utf8',
    }) as string;
    expect(manifest).not.toMatch(/pr-publication-store-capability/);
    expect(JSON.parse(manifest).exports?.['./*']).toBeUndefined();
  });

  it('restricts the issuers to the governed runtime, the VCS hosts and the store facades', () => {
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
        if (ignored.has(entry) || entry.startsWith('.')) return [];
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
    for (const expected of [capability, runtime, publicationHost, charterRegistry])
      expect(files.some((file) => file.endsWith(expected))).toBe(true);
    for (const file of files) {
      const relative = path.relative(source, file).split(path.sep).join('/');
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      if (!/pr-publication|withPrPublication/.test(text)) continue;
      expect(violations(relative, text), relative).toEqual([]);
    }
  });

  it('rejects namespace, default, aliased, dynamic and barrel access to the issuers', () => {
    for (const extension of ['', '.ts', '.js', '.mjs', '.cjs']) {
      const foundation = '../foundation/pr-publication-store-capability' + extension;
      const governance = '../governance/pr-publication-runtime' + extension;
      for (const text of [
        `import * as cap from '${foundation}';`,
        `import cap from '${foundation}';`,
        `import cap = require('${foundation}');`,
        `export * from '${foundation}';`,
        `export {withPrPublicationStoreGrant as facade} from '${foundation}';`,
        `import {withPrPublicationStoreGrant as hidden} from '${foundation}';`,
        `import {prPublicationGrantAuthorizes} from '${foundation}';`,
        `const cap = require('${foundation}');`,
        `const cap = import('${foundation}');`,
        `import * as host from '${governance}';`,
        `import host from '${governance}';`,
        `export * from '${governance}';`,
        `export {withPrPublicationRuntime} from '${governance}';`,
        `export {prPublicationGrantAuthorizes} from '${foundation}';`,
        `import {withPrPublicationRuntime} from '${governance}';`,
        `import {withPrPublicationStoreAccess} from '${governance}';`,
        `import {withPrPublicationStoreAccess as hidden} from '${governance}';`,
        `const host = import('${governance}');`,
      ])
        for (const consumer of [
          'libs/core/authority.ts',
          'libs/core/tier-guard.ts',
          'libs/core/workforce/artifact-store.ts',
          'scripts/foreign.ts',
          'presence/displays/concierge/app/api/foreign.ts',
        ])
          expect(violations(consumer, text).length, `${consumer}: ${text}`).toBeGreaterThan(0);
      expect(
        violations(publicationHost, `import {withPrPublicationRuntime} from '${governance}';`)
      ).toEqual([]);
      expect(
        violations(
          reservationStore,
          `import {withPrPublicationStoreAccess, currentPrPublicationScope} from '${governance}';`
        )
      ).toEqual([]);
      expect(
        violations(reservationStore, `import {withPrPublicationRuntime} from '${governance}';`)
          .length
      ).toBeGreaterThan(0);
      expect(
        violations(runtime, `import {withPrPublicationStoreGrant} from '${foundation}';`)
      ).toEqual([]);
      expect(
        violations(
          'libs/core/tier-guard.ts',
          `import {currentPrPublicationScope} from '${governance}';`
        )
      ).toEqual([]);
      expect(
        violations('libs/core/index.ts', `export {currentPrPublicationScope} from '${governance}';`)
      ).toEqual([]);
      expect(
        violations(
          'libs/core/tier-guard.ts',
          `import {prPublicationStoreGrantActive, prPublicationResourceAllowed} from '${foundation}';`
        )
      ).toEqual([]);
      expect(
        violations(
          'libs/core/tier-guard-store-grants.ts',
          `import {prPublicationGrantAuthorizes} from '${foundation}';`
        )
      ).toEqual([]);
    }
  });
});
