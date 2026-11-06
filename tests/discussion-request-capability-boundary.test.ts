import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeReadFile, safeReaddir, safeLstat } from '@agent/core/secure-io';
import ts from 'typescript';

// The opaque Discussion request grant (G2): only the governed receipt facade issues it.
const implementation = 'libs/core/foundation/discussion-request-capability.ts';
const facade = 'libs/core/discussion/discussion-request-storage-scope.ts';
const issuerName = 'withDiscussionRequestCapability';
// Named, value-only consumers of the capability module and the names each may import.
// G2: the grant alone authorizes, so authority.ts and tier-guard.ts no longer import it;
// the only predicate consumer is the tier-guard store-grant table.
const consumers = new Map<string, readonly string[]>([
  [facade, [issuerName, 'DISCUSSION_REQUEST_GRANT_ISSUANCE_RIGHT']],
  ['libs/core/tier-guard-store-grants.ts', ['isDiscussionRequestCapability']],
]);

function violations(relative: string, text: string): string[] {
  if (!/discussion-request-capability|withDiscussionRequestCapability/.test(text)) return [];
  if (relative === implementation) return [];
  const problems: string[] = [];
  const module = (value: ts.Node | undefined) =>
    value &&
    ts.isStringLiteralLike(value) &&
    /(?:^|\/)discussion-request-capability(?:\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))?$/.test(
      value.text.replace(/\\/g, '/')
    );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && module(node.moduleSpecifier)) {
      const allowed = consumers.get(relative);
      const clause = node.importClause;
      const names = clause?.namedBindings;
      if (
        !allowed ||
        clause?.name ||
        !names ||
        !ts.isNamedImports(names) ||
        names.elements.some(
          (entry) => !entry.isTypeOnly && !allowed.includes((entry.propertyName ?? entry.name).text)
        )
      )
        problems.push('capability import outside the facade or its named predicate consumers');
    }
    if (ts.isExportDeclaration(node) && module(node.moduleSpecifier))
      problems.push('capability reexport is forbidden');
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      module(node.moduleReference.expression)
    )
      problems.push('namespace capability import is forbidden');
    if (
      ts.isCallExpression(node) &&
      module(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      problems.push('namespace capability import is forbidden');
    if (ts.isIdentifier(node) && node.text === issuerName && relative !== facade)
      problems.push('issuer identifier outside the governed receipt facade');
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true));
  return problems;
}

describe('Discussion request grant trusted import boundary', () => {
  it('never publishes the capability module through a package export', () => {
    const manifest = safeReadFile(path.join(process.cwd(), 'libs/core/package.json'), {
      encoding: 'utf8',
    }) as string;
    expect(manifest).not.toMatch(/discussion-request-capability/);
    expect(JSON.parse(manifest).exports?.['./*']).toBeUndefined();
  });

  it('restricts issuer use to its implementation and the governed receipt facade', () => {
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
    expect(files.some((file) => file.endsWith(facade))).toBe(true);
    for (const file of files) {
      const relative = path.relative(source, file).split(path.sep).join('/');
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      expect(violations(relative, text), relative).toEqual([]);
    }
  });

  it('rejects namespace, default, aliased and barrel access to the issuer', () => {
    for (const extension of ['', '.ts', '.js', '.mjs', '.cjs']) {
      const target = '../foundation/discussion-request-capability' + extension;
      for (const text of [
        `import * as cap from '${target}';`,
        `import cap from '${target}';`,
        `import cap = require('${target}');`,
        `export * from '${target}';`,
        `export {${issuerName} as facade} from '${target}';`,
        `import {${issuerName} as hidden} from '${target}';`,
        `const cap = require('${target}');`,
        `const cap = import('${target}');`,
      ])
        for (const consumer of [
          'libs/core/authority.ts',
          'libs/core/tier-guard.ts',
          'libs/core/tier-guard-store-grants.ts',
          'scripts/foreign.ts',
          'presence/displays/concierge/app/api/foreign.ts',
        ])
          expect(violations(consumer, text).length, `${consumer}: ${text}`).toBeGreaterThan(0);
      expect(
        violations(
          'libs/core/tier-guard-store-grants.ts',
          `import {isDiscussionRequestCapability} from '${target}';`
        )
      ).toEqual([]);
      for (const former of ['libs/core/authority.ts', 'libs/core/tier-guard.ts'])
        expect(
          violations(former, `import {isDiscussionRequestCapability} from '${target}';`).length
        ).toBeGreaterThan(0);
      expect(violations(facade, `import {${issuerName}} from '${target}';`)).toEqual([]);
    }
  });
});
