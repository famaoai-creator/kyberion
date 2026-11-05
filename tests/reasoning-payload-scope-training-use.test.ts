import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeReadFile } from '@agent/core/secure-io';

/**
 * Reasoning payload scope training_use gate.
 *
 * A `withReasoningPayloadScope` scope whose tier is `confidential` or
 * `personal` must declare `training_use`. An omitted posture defaults to
 * `local_only` inside the egress gate, which denies every external backend
 * (claude-cli included) — and several callers then reported that denial as a
 * generic "backend unavailable". `ReasoningPayloadScope` makes the field
 * required at the type level; this scan is the backstop for what the type
 * checker cannot see: untyped JS, `as` casts, and scopes assembled in ways that
 * widen the type.
 *
 * The scan is syntactic. It inspects the first argument of every call named
 * `withReasoningPayloadScope` (direct, `x.withReasoningPayloadScope`, or via a
 * dynamic import): an object literal, a conditional between literals, or an
 * identifier initialised with one in the same file. A literal is compliant when
 * it names `training_use`, when its tier is the literal `'public'`, or when it
 * carries no tier of its own and spreads a typed scope. Anything it cannot
 * resolve is left to the type checker in TS files and flagged in JS files.
 *
 * ALLOWED_UNDECLARED should stay empty: declare the posture instead
 * (`no_training` for tenant material sent to an attested provider,
 * `local_only` when the material must not leave this host).
 * Test files are exempt — they exercise the default on purpose.
 */
const ALLOWED_UNDECLARED: Record<string, string> = {};

const SCAN_ROOTS = ['libs', 'scripts', 'presence', 'satellites'];
const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const CALLEE = 'withReasoningPayloadScope';

type Finding = { line: number; detail: string };

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current))
      current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else return current;
  }
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function literalProblem(literal: ts.ObjectLiteralExpression): string | undefined {
  let tier: ts.Expression | undefined;
  let hasTier = false;
  let hasTrainingUse = false;
  let hasSpread = false;
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      hasSpread = true;
      continue;
    }
    const name = property.name ? propertyName(property.name) : undefined;
    if (name === 'training_use') hasTrainingUse = true;
    if (name === 'tier') {
      hasTier = true;
      tier = ts.isPropertyAssignment(property)
        ? unwrap(property.initializer)
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : undefined;
    }
  }
  if (hasTrainingUse) return undefined;
  if (hasTier && tier && ts.isStringLiteralLike(tier) && tier.text === 'public') return undefined;
  if (!hasTier && hasSpread) return undefined;
  const tierText = hasTier ? (tier ? tier.getText() : '(computed)') : '(absent)';
  return `scope literal with tier ${tierText} declares no training_use`;
}

function collectVariableInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression[]> {
  const initializers = new Map<string, ts.Expression[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = initializers.get(node.name.text) ?? [];
      list.push(node.initializer);
      initializers.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializers;
}

function scopeProblems(
  expression: ts.Expression,
  initializers: Map<string, ts.Expression[]>,
  typed: boolean,
  seen: Set<string> = new Set()
): string[] {
  const node = unwrap(expression);
  if (ts.isObjectLiteralExpression(node)) {
    const problem = literalProblem(node);
    return problem ? [problem] : [];
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...scopeProblems(node.whenTrue, initializers, typed, seen),
      ...scopeProblems(node.whenFalse, initializers, typed, seen),
    ];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [
      ...scopeProblems(node.left, initializers, typed, seen),
      ...scopeProblems(node.right, initializers, typed, seen),
    ];
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const found = initializers.get(node.text);
    if (found?.length) {
      seen.add(node.text);
      return found.flatMap((initializer) => scopeProblems(initializer, initializers, typed, seen));
    }
  }
  return typed ? [] : [`scope ${node.getText()} cannot be resolved in an untyped file`];
}

function isScopeCall(node: ts.CallExpression): boolean {
  const callee = unwrap(node.expression);
  if (ts.isIdentifier(callee)) return callee.text === CALLEE;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === CALLEE;
  return false;
}

/** Scan one source text; also exercised directly by the self-test below. */
function scanSource(fileName: string, text: string): Finding[] {
  if (!text.includes(CALLEE)) return [];
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const initializers = collectVariableInitializers(sourceFile);
  const typed = /\.(ts|tsx|mts|cts)$/.test(fileName);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isScopeCall(node) && node.arguments.length > 0) {
      for (const detail of scopeProblems(node.arguments[0], initializers, typed)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({ line: line + 1, detail });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

describe('Reasoning payload scope training_use gate', () => {
  it('flags non-public scopes without training_use and accepts declared ones', () => {
    const flagged = scanSource(
      'fixture.ts',
      [
        "withReasoningPayloadScope({ tier: 'confidential', tenant_slug: t }, run);",
        "const scope = { tier: plan.tier, purpose: 'x' } as const;",
        'withReasoningPayloadScope(scope, run);',
        "core.withReasoningPayloadScope(flag ? { tier: 'personal' } : { tier: 'public' }, run);",
        "withReasoningPayloadScope({ ...base, tier: 'personal' }, run);",
      ].join('\n')
    );
    expect(flagged.map((finding) => finding.line)).toEqual([1, 3, 4, 5]);
    expect(
      scanSource(
        'fixture.ts',
        [
          "withReasoningPayloadScope({ tier: 'confidential', training_use: 'no_training' }, run);",
          "withReasoningPayloadScope({ tier: 'public' }, run);",
          'withReasoningPayloadScope({ ...input.scope, attachment_count: 0 }, run);',
          'withReasoningPayloadScope(buildScope(), run);',
        ].join('\n')
      )
    ).toEqual([]);
    expect(scanSource('fixture.mjs', 'withReasoningPayloadScope(buildScope(), run);')).toHaveLength(
      1
    );
  });

  it('keeps every non-public withReasoningPayloadScope call declaring training_use', () => {
    const rootDir = process.cwd();
    const findings = SCAN_ROOTS.flatMap((directory) => getAllFiles(path.join(rootDir, directory)))
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => SOURCE_EXTENSION.test(relPath))
      .filter((relPath) => !/(^|\/)(node_modules|dist|\.next|coverage)\//.test(relPath))
      .filter((relPath) => !/\.test\.[cm]?[jt]sx?$/.test(relPath))
      .flatMap((relPath) => {
        const text = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
        return scanSource(relPath, text).map((finding) => ({ relPath, ...finding }));
      });
    const unexpected = findings
      .filter((finding) => !(finding.relPath in ALLOWED_UNDECLARED))
      .map((finding) => `${finding.relPath}:${finding.line} ${finding.detail}`);
    const stale = Object.keys(ALLOWED_UNDECLARED).filter(
      (relPath) => !findings.some((finding) => finding.relPath === relPath)
    );
    expect(
      unexpected,
      'A non-public reasoning payload scope declares no training_use — the egress gate would ' +
        'silently default it to local_only and deny every external backend (claude-cli included) | ' +
        "next: declare training_use on the scope ('no_training' for tenant material sent to an " +
        "attested provider, 'local_only' when it must not leave this host); do not add an " +
        'ALLOWED_UNDECLARED entry | evidence: the call sites listed below'
    ).toEqual([]);
    expect(
      stale,
      'ALLOWED_UNDECLARED lists a file with no remaining undeclared scope — remove the entry | ' +
        'next: delete it from tests/reasoning-payload-scope-training-use.test.ts'
    ).toEqual([]);
  }, 60000);
});
