import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readTextFile } from './foundation/text.js';
import './secure-io.js';
import { pathResolver } from './path-resolver.js';

const domains = ['ocr', 'media/image-generation', 'media/music-generation'];

describe('provider composition boundaries', () => {
  for (const domain of domains) {
    it(`${domain}: registry and routing cannot reach concrete providers or their facade`, () => {
      const seen = new Set<string>();
      const violations: string[] = [];
      const prefix = pathResolver.rootResolve(`libs/core/${domain}`);
      const facade = pathResolver.rootResolve(`libs/core/${domain}-bridge.ts`);
      const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = ts.createSourceFile(file, readTextFile(file), ts.ScriptTarget.Latest, true);
        for (const statement of source.statements) {
          if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
          const specifier = statement.moduleSpecifier;
          if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.'))
            continue;
          const target = path.resolve(path.dirname(file), specifier.text.replace(/\.js$/, '.ts'));
          if (
            target === facade ||
            target.startsWith(path.join(prefix, 'providers') + path.sep) ||
            target === path.join(prefix, 'builtin-providers.ts')
          ) {
            violations.push(`${path.relative(prefix, file)} -> ${specifier.text}`);
          } else if (target.startsWith(prefix + path.sep)) {
            visit(target);
          }
        }
      };
      visit(path.join(prefix, 'provider-registry.ts'));
      visit(path.join(prefix, 'router.ts'));
      expect(violations).toEqual([]);
    });
  }
});
