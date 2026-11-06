import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import ts from 'typescript';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Provider structured-result redaction boundary.
 *
 * Typed result exits of provider backends (`runStructured<T>` and friends)
 * must redact through `redactProviderStructuredResult` (directly or via
 * `withRedactedProviderOutput`), which fails closed when the value exceeds the
 * walk bounds. The diagnostic `redactProviderOutputValue` replaces oversized
 * parts with marker strings, which silently breaks the caller's `T` shape, so
 * it may only feed diagnostic sinks (`this.lastHarnessSubagentInfo`).
 *
 * Rules, for every non-test file under libs/ that imports
 * provider-output-redaction:
 *   1. `redactProviderOutputValue(...)` only as the value assigned to a
 *      diagnostic sink (DIAGNOSTIC_SINKS) or inside an allowlisted function.
 *   2. A `runStructured*` function/method with a body (other than a raw
 *      `*Unredacted` inner) reaches a typed redaction exit (TYPED_EXITS) and
 *      never calls `redactProviderOutputValue`.
 *   3. A `this.*Unredacted(...)` call sits inside `withRedactedProviderOutput`.
 *   4. `withRedactedProviderOutput` itself uses the fail-closed redactor.
 */
const rootDir = process.cwd();
const REDACTION_MODULE = 'libs/core/provider/provider-output-redaction.ts';
const IMPORTS_REDACTION = /from ['"][./]*(?:provider\/)?provider-output-redaction\.js['"]/;

/** Assignment targets that only hold diagnostics, never a typed result. */
const DIAGNOSTIC_SINKS = new Set(['this.lastHarnessSubagentInfo']);
/** Functions that may call the marker-replacing redactor (not typed results). */
const ALLOWED_VALUE_REDACTION_FUNCTIONS: Readonly<Record<string, string>> = {
  [`${REDACTION_MODULE}#redactProviderOutputError`]:
    'a non-Error throwable is diagnostic text, never a typed result',
};
/**
 * Calls through which a typed result is redacted fail-closed. Delegation to
 * another typed exit (`this.runStructured`, `runCodexCliQuery`) and the shared
 * `runStructuredReasoningOp` (fed by the backend's redacted text exit) count.
 */
const TYPED_EXITS = new Set([
  'withRedactedProviderOutput',
  'redactProviderStructuredResult',
  'runStructuredReasoningOp',
  'runStructured',
  'runCodexCliQuery',
]);

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name &&
      (ts.isIdentifier(current.name) || ts.isPrivateIdentifier(current.name))
    ) {
      return current.name.text;
    }
  }
  return undefined;
}

function hasAncestorCall(node: ts.Node, name: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && calleeName(current) === name) return true;
  }
  return false;
}

function callsIn(body: ts.Node): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name) names.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}

function violationsIn(relPath: string, source: string): string[] {
  const file = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const at = (node: ts.Node) =>
    `${relPath}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === 'redactProviderOutputValue' && ts.isIdentifier(node.expression)) {
        const parent = node.parent;
        const sink =
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.right === node &&
          DIAGNOSTIC_SINKS.has(parent.left.getText(file));
        const fn = enclosingFunctionName(node);
        const allowed = fn !== undefined && `${relPath}#${fn}` in ALLOWED_VALUE_REDACTION_FUNCTIONS;
        if (!sink && !allowed) {
          out.push(
            `${at(node)} redactProviderOutputValue() outside a diagnostic sink — use redactProviderStructuredResult() for typed results`
          );
        }
      }
      if (
        name?.endsWith('Unredacted') &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        !hasAncestorCall(node, 'withRedactedProviderOutput')
      ) {
        out.push(`${at(node)} this.${name}() called outside withRedactedProviderOutput()`);
      }
    }
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.body &&
      node.name &&
      ts.isIdentifier(node.name) &&
      /^runStructured/.test(node.name.text) &&
      !node.name.text.endsWith('Unredacted')
    ) {
      const calls = callsIn(node.body);
      if (!calls.some((call) => TYPED_EXITS.has(call))) {
        out.push(
          `${at(node)} ${node.name.text}() returns a typed result without a fail-closed redaction exit (${[...TYPED_EXITS].join(' / ')})`
        );
      }
      if (calls.includes('redactProviderOutputValue')) {
        out.push(
          `${at(node)} ${node.name.text}() redacts its typed result with the marker-replacing redactProviderOutputValue()`
        );
      }
    }
    if (
      relPath === REDACTION_MODULE &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'withRedactedProviderOutput' &&
      node.body
    ) {
      const calls = callsIn(node.body);
      if (
        !calls.includes('redactProviderStructuredResult') ||
        calls.includes('redactProviderOutputValue')
      ) {
        out.push(
          `${at(node)} withRedactedProviderOutput() must redact via redactProviderStructuredResult()`
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

function scannedFiles(): string[] {
  return getAllFiles(path.join(rootDir, 'libs'))
    .map((filePath) => normalize(path.relative(rootDir, filePath)))
    .filter((relPath) => /\.(ts|mts|cts)$/.test(relPath) && !relPath.endsWith('.d.ts'))
    .filter((relPath) => !relPath.includes('/dist/') && !/\.(test|spec)\.[cm]?ts$/.test(relPath))
    .filter(
      (relPath) =>
        relPath === REDACTION_MODULE ||
        IMPORTS_REDACTION.test(
          String(safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }))
        )
    )
    .sort();
}

describe('Provider structured-result redaction boundary', () => {
  it('flags marker redaction of typed results and unwrapped raw exits', () => {
    const bad = [
      'class B {',
      '  async runStructured<T>(p: unknown): Promise<T> {',
      '    return redactProviderOutputValue(await this.raw(p));',
      '  }',
      '  run() { return this.runStructuredUnredacted(1); }',
      '}',
    ].join('\n');
    expect(violationsIn('libs/core/provider/x-backend.ts', bad)).toHaveLength(4);
    const good = [
      'class B {',
      '  async runStructured<T>(p: unknown): Promise<T> {',
      '    return withRedactedProviderOutput(() => this.runStructuredUnredacted(p));',
      '  }',
      '  note() { this.lastHarnessSubagentInfo = redactProviderOutputValue({ a: 1 }); }',
      '}',
    ].join('\n');
    expect(violationsIn('libs/core/provider/x-backend.ts', good)).toEqual([]);
  });

  it('typed-result exits of provider backends redact via redactProviderStructuredResult', () => {
    const files = scannedFiles();
    // The scan must cover the redaction module and the backends using it.
    expect(files).toContain(REDACTION_MODULE);
    expect(files).toContain('libs/core/provider/codex-cli-query.ts');
    const violations = files.flatMap((relPath) =>
      violationsIn(relPath, String(safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' })))
    );
    expect(
      violations,
      `typed provider result redacted with the marker-replacing redactor, or not at all — oversized parts would become marker strings and break the caller's T shape | next: return through redactProviderStructuredResult() / withRedactedProviderOutput(); keep redactProviderOutputValue() for diagnostic sinks | evidence:\n${violations.join('\n')}`
    ).toEqual([]);
  }, 60000);
});
