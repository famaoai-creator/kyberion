/**
 * DH-07: independent AST backstop for capability seam completeness.
 *
 * The generated seam graph intentionally has its own hand-maintained role
 * map. This checker does not import that map: it scans production TypeScript
 * declarations directly and verifies that every createSeam declaration is
 * catalog-backed and represented in the generated graph.
 */
import * as path from 'node:path';
import * as ts from 'typescript';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir, safeStat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

const LIBS_ROOT = pathResolver.rootResolve('libs');

/** libs/core plus every libs/shared-* package source tree (packages split out of core). */
function sourceRoots(): string[] {
  const shared = safeReaddir(LIBS_ROOT)
    .filter((entry) => entry.startsWith('shared-'))
    .sort()
    .map((entry) => path.join(LIBS_ROOT, entry, 'src'))
    .filter((root) => safeExistsSync(root) && safeStat(root).isDirectory());
  return [path.join(LIBS_ROOT, 'core'), ...shared];
}
const GRAPH_PATH = pathResolver.rootResolve('docs/developer/CAPABILITY_SEAMS.md');

interface SeamDeclaration {
  key: string;
  file: string;
  line: number;
  catalogBacked: boolean;
}

const SEAM_CONSTRUCTORS = new Set(['createSeam', 'defineSeam', 'createProviderRegistry']);

export function readCapabilitySeamsTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of safeReaddir(directory).sort()) {
    if (entry.startsWith('.')) continue;
    const absolute = path.join(directory, entry);
    if (safeStat(absolute).isDirectory()) {
      files.push(...collectSourceFiles(absolute));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) &&
      ((ts.isIdentifier(entry.name) && entry.name.text === name) ||
        (ts.isStringLiteral(entry.name) && entry.name.text === name))
  );
}

function literalString(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text.trim() : undefined;
}

/** Resolve `const NAME = 'literal'` declarations so `seam: NAME` reads as its literal. */
function constStringLiterals(sourceFile: ts.SourceFile): Map<string, string> {
  const literals = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
      const decl = node.declarationList.declarations[0];
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isStringLiteralLike(decl.initializer)
      ) {
        literals.set(decl.name.text, decl.initializer.text.trim());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

function scanDeclarations(): SeamDeclaration[] {
  const declarations: SeamDeclaration[] = [];
  for (const file of sourceRoots().flatMap((root) => collectSourceFiles(root))) {
    const source = readCapabilitySeamsTextFile(file);
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const consts = constStringLiterals(sourceFile);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        SEAM_CONSTRUCTORS.has(node.expression.text)
      ) {
        const argument = node.arguments[0];
        if (!argument || !ts.isObjectLiteralExpression(argument)) return;
        const factoryBacked = node.expression.text === 'createProviderRegistry';
        // createProviderRegistry takes { seam } instead of { key } and always
        // registers with coreSeamCatalog inside the factory.
        const keyExpression = property(argument, factoryBacked ? 'seam' : 'key')?.initializer;
        let key = literalString(keyExpression);
        if (!key && keyExpression && ts.isIdentifier(keyExpression)) {
          key = consts.get(keyExpression.text);
        }
        if (!key) return;
        declarations.push({
          key,
          file: path.relative(pathResolver.rootDir(), file),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          catalogBacked: factoryBacked || property(argument, 'catalog') !== undefined,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return declarations;
}

function check(): string[] {
  const findings: string[] = [];
  const declarations = scanDeclarations();
  const byKey = new Map<string, SeamDeclaration>();
  const graph = readCapabilitySeamsTextFile(GRAPH_PATH);
  // Prettier pads Markdown table cells to a common width, so compare the
  // trimmed first cell instead of relying on the exact substring
  // `| key |`.
  const documentedKeys = new Set<string>();
  for (const line of graph.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length >= 2 && cells[1] && cells[1] !== 'Seam' && !/^[-:]+$/u.test(cells[1])) {
      documentedKeys.add(cells[1]);
    }
  }

  if (declarations.length === 0) findings.push('no production createSeam declaration was found');
  for (const declaration of declarations) {
    const previous = byKey.get(declaration.key);
    if (previous) {
      findings.push(
        `duplicate AST seam key '${declaration.key}' (${previous.file}:${previous.line}, ${declaration.file}:${declaration.line})`
      );
    }
    byKey.set(declaration.key, declaration);
    if (!declaration.catalogBacked) {
      findings.push(
        `${declaration.key}: createSeam declaration is not registered in a catalog (${declaration.file}:${declaration.line})`
      );
    }
    if (!documentedKeys.has(declaration.key)) {
      findings.push(
        `${declaration.key}: generated capability seam graph is missing the AST declaration`
      );
    }
  }

  for (const key of documentedKeys) {
    if (!byKey.has(key)) findings.push(`${key}: generated graph documents no AST declaration`);
  }
  return findings;
}

export const runCheckCapabilitySeamsAst = defineScript({
  name: 'check:capability-seams-ast',
  flags: [],
  run(context): void {
    const findings = check();
    if (findings.length > 0) {
      throw new ScriptExitError(1, findings.map((finding) => `- ${finding}`).join('\n'));
    }
    context.print(`[check:capability-seams-ast] OK (${scanDeclarations().length} declarations)`);
  },
});

if (
  isDirectScript(import.meta.url, 'check_capability_seams_ast.ts') ||
  isDirectScript(import.meta.url, 'check_capability_seams_ast.js')
)
  void runCheckCapabilitySeamsAst();
