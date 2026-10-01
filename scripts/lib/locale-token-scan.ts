// IT-05: AST scans for locale/colour hardcoding that the Hiragana/Katakana
// literal ratchet (check_i18n_hardcoding.ts) cannot see. Pure functions — the
// ratchet owns file discovery, baselines and reporting.
//
// Rules (each counted per offending node, per file):
//   intent_regex    — a regex literal containing Japanese characters that is
//                     used as a matcher (`.test()` / `.exec()` / `.match()` /
//                     `.matchAll()` / `.search()`). Intent phrases belong in
//                     knowledge/product/governance/intent-phrase-lexicon.json
//                     (libs/core/intent/intent-phrase-lexicon.ts).
//   locale_compare  — `=== 'ja'` / `!== 'en'` style comparisons. Branch on
//                     the locale through pickByLocale / t() instead.
//   locale_literal  — hardcoded 'ja-JP' / 'en-US' tags. Use localeToBcp47().
//   engine_hex      — raw hex / rgb() colour literals in the artifact-engine
//                     directories. Engines read semantic design tokens.
// A flagged node is exempt when `// i18n-exempt: <reason>` is on the same or
// the previous line (the same directive the Japanese-literal ratchet uses).
import ts from 'typescript';

export const LOCALE_TOKEN_RULES = [
  'intent_regex',
  'locale_compare',
  'locale_literal',
  'engine_hex',
] as const;
export type LocaleTokenRule = (typeof LOCALE_TOKEN_RULES)[number];

export type LocaleTokenScanResult = {
  counts: Record<LocaleTokenRule, number>;
  exemptions: number;
};

/** Hiragana, Katakana and CJK ideographs, written as \u escapes so this file stays ASCII. */
const CJK_PATTERN = /[぀-ヿ一-鿿]/u;
const EXEMPT_PATTERN = /\/\/\s*i18n-exempt:\s*(.*)$/u;
const HEX_COLOUR_PATTERN = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*\d/u;
const LOCALE_COMPARE_VALUES = new Set(['ja', 'en', 'ja-JP', 'en-US']);
const LOCALE_TAG_LITERALS = new Set(['ja-JP', 'en-US']);
const MATCHER_METHODS = new Set(['test', 'exec', 'match', 'matchAll', 'search']);

/**
 * Files where these rules do not apply:
 *  - the locale modules own locale tags and comparisons;
 *  - the phrase lexicon module owns phrase matching;
 *  - generated vocabulary output.
 */
const LOCALE_RULE_ALLOWLIST: RegExp[] = [
  /^libs\/core\/locale[^/]*\.ts$/u,
  /^libs\/core\/knowledge\/vocabulary-keys\.generated\.ts$/u,
  // this scanner names the tags it forbids
  /^scripts\/lib\/locale-token-scan\.ts$/u,
];
const INTENT_REGEX_ALLOWLIST: RegExp[] = [/^libs\/core\/intent\/intent-phrase-lexicon\.ts$/u];

/** Artifact-engine directories: colours resolve through semantic design tokens. */
const ENGINE_DIR_PATTERNS: RegExp[] = [
  /^libs\/core\/(?:media|video)\//u,
  /^libs\/actuators\/(?:media|media-generation|video-composition)-actuator\/src\//u,
];

export function isEngineColourScoped(repoRelativePath: string): boolean {
  return ENGINE_DIR_PATTERNS.some((pattern) => pattern.test(repoRelativePath));
}

function emptyCounts(): Record<LocaleTokenRule, number> {
  return { intent_regex: 0, locale_compare: 0, locale_literal: 0, engine_hex: 0 };
}

function stringValue(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function isMatcherUse(node: ts.RegularExpressionLiteral): boolean {
  const parent = node.parent;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return MATCHER_METHODS.has(parent.name.text);
  }
  if (parent && ts.isCallExpression(parent) && parent.arguments.includes(node)) {
    const callee = parent.expression;
    return ts.isPropertyAccessExpression(callee) && MATCHER_METHODS.has(callee.name.text);
  }
  return false;
}

export function scanFileForLocaleTokens(
  text: string,
  repoRelativePath: string
): LocaleTokenScanResult {
  const counts = emptyCounts();
  let exemptions = 0;
  if (!/\.(?:ts|tsx)$/u.test(repoRelativePath)) return { counts, exemptions };

  const localeRulesApply = !LOCALE_RULE_ALLOWLIST.some((p) => p.test(repoRelativePath));
  const intentRuleApplies = !INTENT_REGEX_ALLOWLIST.some((p) => p.test(repoRelativePath));
  const hexRuleApplies = isEngineColourScoped(repoRelativePath);

  const sourceFile = ts.createSourceFile(
    repoRelativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    repoRelativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const lines = text.split('\n');

  const isExemptAt = (node: ts.Node): boolean => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return [lines[line] || '', line > 0 ? lines[line - 1] || '' : ''].some((candidate) => {
      const match = EXEMPT_PATTERN.exec(candidate);
      return Boolean(match && match[1].trim().length > 0);
    });
  };
  const record = (rule: LocaleTokenRule, node: ts.Node): void => {
    if (isExemptAt(node)) exemptions += 1;
    else counts[rule] += 1;
  };

  const visit = (node: ts.Node): void => {
    if (intentRuleApplies && ts.isRegularExpressionLiteral(node)) {
      if (CJK_PATTERN.test(node.text) && isMatcherUse(node)) record('intent_regex', node);
    } else if (localeRulesApply && ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        const left = stringValue(node.left);
        const right = stringValue(node.right);
        if (
          (left !== undefined && LOCALE_COMPARE_VALUES.has(left)) ||
          (right !== undefined && LOCALE_COMPARE_VALUES.has(right))
        ) {
          record('locale_compare', node);
        }
      }
    }

    const literal = stringValue(node);
    if (literal !== undefined) {
      if (localeRulesApply && LOCALE_TAG_LITERALS.has(literal)) record('locale_literal', node);
      if (hexRuleApplies && HEX_COLOUR_PATTERN.test(literal)) record('engine_hex', node);
    } else if (
      hexRuleApplies &&
      (node.kind === ts.SyntaxKind.TemplateHead ||
        node.kind === ts.SyntaxKind.TemplateMiddle ||
        node.kind === ts.SyntaxKind.TemplateTail) &&
      HEX_COLOUR_PATTERN.test((node as ts.TemplateLiteralToken).text)
    ) {
      record('engine_hex', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { counts, exemptions };
}
