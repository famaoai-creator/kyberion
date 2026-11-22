import { describe, expect, it } from 'vitest';
import { loadCodeGraphEnumerationRules } from './enumeration-rules.js';
import { loadGrammar } from './grammar-loader.js';

describe('code-graph enumeration rules contract', () => {
  const rules = loadCodeGraphEnumerationRules();

  it('gives every language a unique id, unique extensions and at least one entrypoint marker', () => {
    const ids = rules.languages.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    const extensions = rules.languages.flatMap((rule) => rule.extensions);
    expect(new Set(extensions).size).toBe(extensions.length);
    for (const rule of rules.languages) {
      expect(
        rule.markers.some((marker) => marker.kind === 'entrypoint'),
        rule.id
      ).toBe(true);
    }
  });

  it('compiles every route-B line pattern as a unicode regular expression', () => {
    for (const rule of rules.languages) {
      for (const marker of rule.markers) {
        expect(
          () => new RegExp(marker.line_pattern, 'u'),
          `${rule.id}/${marker.subtype}`
        ).not.toThrow();
      }
    }
  });

  it('compiles every route-A query against its grammar', async () => {
    for (const rule of rules.languages) {
      const grammar = await loadGrammar(rule.grammar);
      const tree = grammar.parse('');
      try {
        for (const marker of rule.markers) {
          expect(
            () => grammar.captures(marker.query, tree, 'marker'),
            `${rule.id}/${marker.subtype}`
          ).not.toThrow();
        }
        if (rule.imports) {
          expect(
            () => grammar.captures(rule.imports!.query, tree, 'source'),
            `${rule.id}/imports`
          ).not.toThrow();
          if (rule.imports.declarations)
            expect(() =>
              grammar.captures(rule.imports!.declarations!, tree, 'namespace')
            ).not.toThrow();
        }
      } finally {
        grammar.release(tree);
      }
    }
  }, 60000);
});
