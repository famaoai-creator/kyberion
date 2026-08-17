/**
 * DH-07: independent AST backstop for capability seam completeness.
 *
 * The generated seam graph intentionally has its own hand-maintained role
 * map. This checker does not import that map: it scans production TypeScript
 * declarations directly and verifies that every defineSeam declaration is
 * catalog-backed and represented in the generated graph.
 */
import * as path from 'node:path';
import * as ts from 'typescript';
import { pathResolver } from '../libs/core/path-resolver.js';
import { safeReadFile, safeReaddir, safeStat } from '../libs/core/secure-io.js';

const SOURCE_ROOT = pathResolver.rootResolve('libs/core');
const GRAPH_PATH = pathResolver.rootResolve('docs/developer/CAPABILITY_SEAMS.md');

interface SeamDeclaration {
  key: string;
  file: string;
  line: number;
  catalogBacked: boolean;
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

function scanDeclarations(): SeamDeclaration[] {
  const declarations: SeamDeclaration[] = [];
  for (const file of collectSourceFiles(SOURCE_ROOT)) {
    const source = String(safeReadFile(file, { encoding: 'utf8' }) || '');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineSeam'
      ) {
        const argument = node.arguments[0];
        if (!argument || !ts.isObjectLiteralExpression(argument)) return;
        const key = literalString(property(argument, 'key')?.initializer);
        if (!key) return;
        declarations.push({
          key,
          file: path.relative(pathResolver.rootDir(), file),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          catalogBacked: property(argument, 'catalog') !== undefined,
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
  const graph = String(safeReadFile(GRAPH_PATH, { encoding: 'utf8' }) || '');

  if (declarations.length === 0) findings.push('no production defineSeam declaration was found');
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
        `${declaration.key}: defineSeam declaration is not registered in a catalog (${declaration.file}:${declaration.line})`
      );
    }
    if (!graph.includes(`| ${declaration.key} |`)) {
      findings.push(
        `${declaration.key}: generated capability seam graph is missing the AST declaration`
      );
    }
  }

  const documentedKeys = new Set<string>();
  for (const line of graph.split('\n')) {
    const match = line.match(/^\| ([^|]+) \| (?:sole|named) \|/u);
    if (match?.[1]) documentedKeys.add(match[1].trim());
  }
  for (const key of documentedKeys) {
    if (!byKey.has(key)) findings.push(`${key}: generated graph documents no AST declaration`);
  }
  return findings;
}

const findings = check();
if (findings.length > 0) {
  console.error('[check:capability-seams-ast] FAILED');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`[check:capability-seams-ast] OK (${scanDeclarations().length} declarations)`);
}
