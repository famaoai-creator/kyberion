import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeReadFile, safeReaddir, safeLstat } from '@agent/core/secure-io';
import ts from 'typescript';

// The private task source workspace window (G2): only the governed workspace IO facade opens it.
const implementation = 'libs/core/foundation/task-source-workspace-capability.ts';
const facade = 'libs/core/workforce/task-source-workspace-io.ts';
const issuerName = 'withTaskSourceWorkspaceCapability';
// Named, value-only consumers of the capability module and the names each may import.
// G2: the window alone authorizes (no task_source_workspace role), so authority.ts no longer
// imports it; the predicates are read by the tier-guard store-grant table (authorization)
// and the narrow store denial (narrowing every I/O made inside a window).
const consumers = new Map<string, readonly string[]>([
  [facade, [issuerName, 'taskSourceWorkspaceIoActive']],
  ['libs/core/tier-guard-store-grants.ts', ['taskSourceWorkspaceGrantAllows']],
  ['libs/core/foundation/narrow-store-role-denial.ts', ['taskSourceWorkspaceIoDenial']],
]);

function violations(relative: string, text: string): string[] {
  if (!/task-source-workspace-capability|withTaskSourceWorkspaceCapability/.test(text)) return [];
  if (relative === implementation) return [];
  const problems: string[] = [];
  const module = (value: ts.Node | undefined) =>
    value &&
    ts.isStringLiteralLike(value) &&
    /(?:^|\/)task-source-workspace-capability(?:\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))?$/.test(
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
      problems.push('issuer identifier outside the governed workspace IO facade');
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true));
  return problems;
}

describe('Task source workspace window trusted import boundary', () => {
  it('never publishes the capability module through a package export', () => {
    const manifest = safeReadFile(path.join(process.cwd(), 'libs/core/package.json'), {
      encoding: 'utf8',
    }) as string;
    expect(manifest).not.toMatch(/task-source-workspace-capability/);
    expect(JSON.parse(manifest).exports?.['./*']).toBeUndefined();
  });

  it('restricts issuer use to its implementation and the governed workspace IO facade', () => {
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
      const target = '../foundation/task-source-workspace-capability' + extension;
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
          `import {taskSourceWorkspaceGrantAllows} from '${target}';`
        )
      ).toEqual([]);
      expect(
        violations(
          'libs/core/foundation/narrow-store-role-denial.ts',
          `import {taskSourceWorkspaceIoDenial} from '${target}';`
        )
      ).toEqual([]);
      // The former role gate in authority.ts is gone; it, tier-guard and the
      // task source edit tool reach the window only through the facade.
      for (const former of [
        'libs/core/authority.ts',
        'libs/core/tier-guard.ts',
        'libs/core/workforce/task-source-edit.ts',
      ])
        expect(
          violations(former, `import {taskSourceWorkspaceIoActive} from '${target}';`).length
        ).toBeGreaterThan(0);
      expect(violations(facade, `import {${issuerName}} from '${target}';`)).toEqual([]);
    }
  });
});
