/**
 * Dev tool: prune unused import specifiers from TypeScript sources.
 *
 * Removes named/default/namespace import bindings that are never referenced in
 * the file, and drops whole import declarations when none of their bindings are
 * used. Side-effect imports (`import './x.js'`) are always kept.
 *
 * Usage:
 *   node --import ./scripts/ts-loader.mjs scripts/refactor/prune_unused_imports.ts --dry-run
 *   node --import ./scripts/ts-loader.mjs scripts/refactor/prune_unused_imports.ts --write
 *
 * Flags:
 *   --dry-run        report only (default when --write is absent)
 *   --write          apply the edits
 *   --root <path>    repeatable; defaults to `libs` and `scripts`
 *   --filter <sub>   only consider files whose repo path contains <sub>
 *   --exclude <sub>  repeatable; skip files whose path contains <sub>
 *   --top <n>        number of files listed in the report (default 15)
 *   --json           emit the machine-readable report instead of the text one
 */
import * as path from 'node:path';
import ts from 'typescript';
import { safeReadFile, safeWriteFile, safeReaddir, safeLstat } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

const ROOT = pathResolver.rootDir();
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.git',
  '.turbo',
  '__snapshots__',
  'test-results',
]);

export interface PruneFileResult {
  /** Repo-relative path. */
  file: string;
  /** Import specifiers (named/default/namespace bindings) removed. */
  removedSpecifiers: number;
  /** Whole `import ... from '...'` statements removed. */
  removedDeclarations: number;
  /** Local binding names removed, in source order. */
  removedNames: string[];
  /** Original line count. */
  linesBefore: number;
  /** Line count after the edit. */
  linesAfter: number;
  /** Populated when the rewritten text failed to re-parse (file left untouched). */
  skippedReason?: string;
  nextText?: string;
}

interface TextEdit {
  start: number;
  end: number;
}

function isTargetFile(filePath: string): boolean {
  if (!filePath.endsWith('.ts')) return false;
  if (filePath.endsWith('.d.ts')) return false;
  if (filePath.endsWith('.generated.ts')) return false;
  return !/\.(?:test|spec)\.ts$/u.test(filePath);
}

export function collectSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = safeReaddir(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = safeLstat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectSourceFiles(full, out);
    } else if (stat.isFile() && isTargetFile(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Identifier positions that are declarations or member names, never references. */
function isReferencePosition(id: ts.Identifier): boolean {
  const parent = id.parent as ts.Node | undefined;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== id;
  if (ts.isQualifiedName(parent)) return parent.right !== id;
  if (ts.isPropertyAssignment(parent)) return parent.name !== id;
  if (ts.isBindingElement(parent)) return parent.propertyName !== id && parent.name !== id;
  if (ts.isExportSpecifier(parent)) {
    // `export { a }` references local `a`; `export { a as b }` references `a` only.
    return parent.propertyName ? parent.propertyName === id : parent.name === id;
  }
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  if (ts.isJsxAttribute(parent)) return parent.name !== id;
  if (
    ts.isPropertySignature(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent)
  ) {
    return parent.name !== id;
  }
  if (
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  ) {
    return false;
  }
  const named = parent as ts.NamedDeclaration;
  if (
    named.name === id &&
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isTypeParameterDeclaration(parent))
  ) {
    return false;
  }
  return true;
}

const JSDOC_BLOCK = /\/\*\*[\s\S]*?\*\//gu;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/gu;

/**
 * Names referenced anywhere outside of import declarations, plus every word that
 * appears in a JSDoc block (`{@link Foo}`, `@type {Foo}`, …) so documentation-only
 * references keep their import.
 */
export function collectReferencedNames(sourceFile: ts.SourceFile): Set<string> {
  const used = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    // `export { x } from './y.js'` is a re-export: it never references a local binding.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return;
    if (ts.isIdentifier(node)) {
      if (isReferencePosition(node)) used.add(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  const text = sourceFile.getFullText();
  for (const block of text.match(JSDOC_BLOCK) ?? []) {
    for (const word of block.match(WORD) ?? []) used.add(word);
  }
  return used;
}

function expandWholeStatement(text: string, node: ts.Node, sourceFile: ts.SourceFile): TextEdit {
  let start = node.getStart(sourceFile);
  let end = node.getEnd();
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart -= 1;
  if (text.slice(lineStart, start).trim() === '') start = lineStart;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
  if (text[end] === '\r') end += 1;
  if (text[end] === '\n') end += 1;
  return { start, end };
}

function planImportEdits(
  declaration: ts.ImportDeclaration,
  used: Set<string>,
  text: string,
  sourceFile: ts.SourceFile
): { edits: TextEdit[]; removedNames: string[]; wholeDeclaration: boolean } {
  const clause = declaration.importClause;
  // Side-effect import: always keep.
  if (!clause) return { edits: [], removedNames: [], wholeDeclaration: false };

  const defaultName = clause.name;
  const bindings = clause.namedBindings;
  const defaultUnused = Boolean(defaultName) && !used.has(defaultName!.text);

  if (bindings && ts.isNamespaceImport(bindings)) {
    const namespaceUnused = !used.has(bindings.name.text);
    if (namespaceUnused && (!defaultName || defaultUnused)) {
      const removed = [bindings.name.text];
      if (defaultName && defaultUnused) removed.unshift(defaultName.text);
      return {
        edits: [expandWholeStatement(text, declaration, sourceFile)],
        removedNames: removed,
        wholeDeclaration: true,
      };
    }
    if (defaultName && defaultUnused) {
      return {
        edits: [{ start: defaultName.getStart(sourceFile), end: bindings.getStart(sourceFile) }],
        removedNames: [defaultName.text],
        wholeDeclaration: false,
      };
    }
    return { edits: [], removedNames: [], wholeDeclaration: false };
  }

  const elements = bindings && ts.isNamedImports(bindings) ? bindings.elements : undefined;
  if (elements && elements.length === 0) {
    // `import {} from 'x'` behaves like a side-effect import; leave it alone.
    return { edits: [], removedNames: [], wholeDeclaration: false };
  }

  const unusedIndexes = new Set<number>();
  elements?.forEach((element, index) => {
    if (!used.has(element.name.text)) unusedIndexes.add(index);
  });
  const allNamedUnused = elements ? unusedIndexes.size === elements.length : true;

  if ((!defaultName || defaultUnused) && allNamedUnused) {
    const removed: string[] = [];
    if (defaultName && defaultUnused) removed.push(defaultName.text);
    for (const element of elements ?? []) removed.push(element.name.text);
    if (removed.length === 0) return { edits: [], removedNames: [], wholeDeclaration: false };
    return {
      edits: [expandWholeStatement(text, declaration, sourceFile)],
      removedNames: removed,
      wholeDeclaration: true,
    };
  }

  const edits: TextEdit[] = [];
  const removedNames: string[] = [];

  if (defaultName && defaultUnused && bindings) {
    edits.push({ start: defaultName.getStart(sourceFile), end: bindings.getStart(sourceFile) });
    removedNames.push(defaultName.text);
  }

  if (elements && unusedIndexes.size > 0) {
    if (allNamedUnused && defaultName && !defaultUnused) {
      edits.push({ start: defaultName.getEnd(), end: bindings!.getEnd() });
      for (const element of elements) removedNames.push(element.name.text);
    } else {
      // Collapse contiguous removals into runs so the separating commas go with
      // them and no `,,` or dangling comma is left behind.
      for (let index = 0; index < elements.length; index += 1) {
        if (!unusedIndexes.has(index)) continue;
        let last = index;
        while (last + 1 < elements.length && unusedIndexes.has(last + 1)) last += 1;
        const following = elements[last + 1];
        let start = elements[index].getStart(sourceFile);
        let end: number;
        if (following) {
          end = following.getStart(sourceFile);
        } else {
          // Trailing run: take the comma that separates it from the kept element
          // before it, plus any trailing comma after it.
          const previous = elements[index - 1];
          if (previous) start = previous.getEnd();
          end = elements[last].getEnd();
          let cursor = end;
          while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
          if (text[cursor] === ',') end = cursor + 1;
        }
        edits.push({ start, end });
        for (let cursor = index; cursor <= last; cursor += 1) {
          removedNames.push(elements[cursor].name.text);
        }
        index = last;
      }
    }
  }

  return { edits: edits, removedNames, wholeDeclaration: false };
}

function parse(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function parseDiagnosticCount(sourceFile: ts.SourceFile): number {
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  return Array.isArray(diagnostics) ? diagnostics.length : 0;
}

export function pruneFile(filePath: string, text: string): PruneFileResult {
  const repoPath = path.relative(ROOT, filePath).split(path.sep).join('/');
  const result: PruneFileResult = {
    file: repoPath,
    removedSpecifiers: 0,
    removedDeclarations: 0,
    removedNames: [],
    linesBefore: text.split('\n').length,
    linesAfter: text.split('\n').length,
  };

  const sourceFile = parse(filePath, text);
  const originalDiagnostics = parseDiagnosticCount(sourceFile);
  const used = collectReferencedNames(sourceFile);

  const edits: TextEdit[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const plan = planImportEdits(statement, used, text, sourceFile);
    if (plan.edits.length === 0) continue;
    edits.push(...plan.edits);
    result.removedNames.push(...plan.removedNames);
    result.removedSpecifiers += plan.removedNames.length;
    if (plan.wholeDeclaration) result.removedDeclarations += 1;
  }

  if (edits.length === 0) return result;

  let next = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + next.slice(edit.end);
  }

  const reparsed = parse(filePath, next);
  if (parseDiagnosticCount(reparsed) > originalDiagnostics) {
    if (process.env.PRUNE_DEBUG === '1') {
      console.error(`--- ${repoPath} rewrite rejected ---\n${next}\n--- end ---`);
    }
    return {
      ...result,
      removedSpecifiers: 0,
      removedDeclarations: 0,
      removedNames: [],
      skippedReason: 'rewritten source failed to re-parse',
    };
  }

  result.linesAfter = next.split('\n').length;
  result.nextText = next;
  return result;
}

interface CliOptions {
  write: boolean;
  json: boolean;
  top: number;
  roots: string[];
  filter?: string;
  exclude: string[];
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { write: false, json: false, top: 15, roots: [], exclude: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') options.write = true;
    else if (arg === '--dry-run') options.write = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--top') options.top = Number(argv[(index += 1)]);
    else if (arg === '--root') options.roots.push(argv[(index += 1)]);
    else if (arg === '--filter') options.filter = argv[(index += 1)];
    else if (arg === '--exclude') options.exclude.push(argv[(index += 1)]);
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
  }
  if (options.roots.length === 0) options.roots = ['libs', 'scripts'];
  return options;
}

function groupKey(repoPath: string): string {
  const segments = repoPath.split('/');
  return segments.length <= 1 ? '.' : segments.slice(0, -1).join('/');
}

function report(results: PruneFileResult[], options: CliOptions): void {
  const touched = results.filter((entry) => entry.removedSpecifiers > 0);
  const totals = {
    filesScanned: results.length,
    filesChanged: touched.length,
    removedSpecifiers: touched.reduce((sum, entry) => sum + entry.removedSpecifiers, 0),
    removedDeclarations: touched.reduce((sum, entry) => sum + entry.removedDeclarations, 0),
    lineDelta: touched.reduce((sum, entry) => sum + (entry.linesAfter - entry.linesBefore), 0),
    skipped: results.filter((entry) => entry.skippedReason).map((entry) => entry.file),
  };

  const byDirectory = new Map<string, { files: number; specifiers: number; declarations: number }>();
  for (const entry of touched) {
    const key = groupKey(entry.file);
    const bucket = byDirectory.get(key) ?? { files: 0, specifiers: 0, declarations: 0 };
    bucket.files += 1;
    bucket.specifiers += entry.removedSpecifiers;
    bucket.declarations += entry.removedDeclarations;
    byDirectory.set(key, bucket);
  }
  const directories = [...byDirectory.entries()].sort((a, b) => b[1].specifiers - a[1].specifiers);
  const topFiles = [...touched]
    .sort((a, b) => b.removedSpecifiers - a.removedSpecifiers)
    .slice(0, options.top);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          mode: options.write ? 'write' : 'dry-run',
          totals,
          directories: directories.map(([directory, bucket]) => ({ directory, ...bucket })),
          files: touched.map((entry) => ({
            file: entry.file,
            removedSpecifiers: entry.removedSpecifiers,
            removedDeclarations: entry.removedDeclarations,
            removedNames: entry.removedNames,
            lineDelta: entry.linesAfter - entry.linesBefore,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`mode: ${options.write ? 'write' : 'dry-run'}`);
  console.log(
    `files scanned: ${totals.filesScanned}  files changed: ${totals.filesChanged}  ` +
      `specifiers removed: ${totals.removedSpecifiers}  declarations removed: ${totals.removedDeclarations}  ` +
      `line delta: ${totals.lineDelta}`
  );
  if (totals.skipped.length > 0) {
    console.log(`skipped (re-parse guard): ${totals.skipped.join(', ')}`);
  }
  console.log('\nper directory (specifiers removed):');
  for (const [directory, bucket] of directories) {
    console.log(
      `  ${String(bucket.specifiers).padStart(5)}  ${String(bucket.declarations).padStart(4)} decls  ` +
        `${String(bucket.files).padStart(4)} files  ${directory}`
    );
  }
  console.log(`\ntop ${options.top} files:`);
  for (const entry of topFiles) {
    console.log(
      `  ${String(entry.removedSpecifiers).padStart(4)}  ${String(entry.removedDeclarations).padStart(3)} decls  ` +
        `${entry.linesAfter - entry.linesBefore} lines  ${entry.file}`
    );
  }
}

export function run(argv: string[]): void {
  const options = parseArgs(argv);
  const files: string[] = [];
  for (const root of options.roots) {
    collectSourceFiles(pathResolver.rootResolve(root), files);
  }
  const selected = files
    .filter((file) => (options.filter ? file.includes(options.filter) : true))
    .filter((file) => !options.exclude.some((pattern) => file.includes(pattern)));

  const results: PruneFileResult[] = [];
  for (const file of selected) {
    const text = String(safeReadFile(file, { encoding: 'utf8' }));
    if (!text.includes('import')) continue;
    const result = pruneFile(file, text);
    results.push(result);
    if (options.write && result.nextText !== undefined) {
      safeWriteFile(file, result.nextText);
    }
  }
  report(results, options);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('prune_unused_imports.ts')) {
  run(process.argv.slice(2));
}
