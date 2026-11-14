import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { productSourceFiles } from './helpers/store-grant-boundary.js';
import ts from 'typescript';

// The shared binding module also contains public read APIs. Only this new issuer
// is private: keep its name out of all barrels and callers except the broker.
describe('personal credential operation issuer boundary', () => {
  it('admits the selected operation only through its proof-verifying broker', () => {
    for (const file of productSourceFiles()) {
      const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
      if (relative === 'libs/core/foundation/credential-binding.ts') continue;
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      if (
        !text.includes('withPersonalServiceCredentialBinding') &&
        !text.includes('credential-binding')
      )
        continue;
      const violations: string[] = [];
      const bindingModule = (node: ts.Node | undefined): boolean =>
        Boolean(
          node &&
          ts.isStringLiteralLike(node) &&
          /(?:^|\/)credential-binding(?:\.[cm]?[jt]s)?$/.test(node.text)
        );
      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          bindingModule(node.moduleSpecifier) &&
          node.importClause?.namedBindings &&
          ts.isNamespaceImport(node.importClause.namedBindings)
        )
          violations.push('namespace binding import exposes issuer');
        if (
          ts.isExportDeclaration(node) &&
          bindingModule(node.moduleSpecifier) &&
          !node.exportClause
        )
          violations.push('wildcard binding reexport exposes issuer');
        if (
          ts.isCallExpression(node) &&
          bindingModule(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        )
          violations.push('dynamic binding import exposes issuer');
        if (
          ts.isIdentifier(node) &&
          node.text === 'withPersonalServiceCredentialBinding' &&
          relative !== 'libs/core/secret/personal-service-credential-broker.ts'
        )
          violations.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true));
      expect(violations, relative).toEqual([]);
    }
  });
});
