/** KS-16: semantic static checks for knowledge scope choke points. */
import * as path from 'node:path';
import ts from 'typescript';
import { readTextFile } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { loadKnowledgeScopeCheckPolicy } from '@agent/core/knowledge/knowledge-scope-check-policy';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export interface KnowledgeScopeCheckConfig {
  max_direct_tenant_env_reads: number;
  confidential_scope_allowlist?: string[];
  scoped_runtime_writer_files?: string[];
}

const root = process.cwd();
const roots = ['libs', 'scripts', 'presence', 'satellites'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const DEFAULT_CONFIG: KnowledgeScopeCheckConfig = { max_direct_tenant_env_reads: 26 };
const CONFIG_PATH = path.join(root, 'knowledge/product/governance/knowledge-scope-check.json');

export function readKnowledgeScopeTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

function loadConfig(): KnowledgeScopeCheckConfig {
  const parsed = loadKnowledgeScopeCheckPolicy(CONFIG_PATH);
  if (!parsed) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    max_direct_tenant_env_reads: parsed.max_direct_tenant_env_reads,
    confidential_scope_allowlist: parsed.confidential_scope_allowlist,
    scoped_runtime_writer_files: parsed.scoped_runtime_writer_files,
  };
}

function removeComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function isAllowlisted(file: string, config: KnowledgeScopeCheckConfig): boolean {
  return (config.confidential_scope_allowlist || []).some((entry) => file === entry);
}

export function countDirectTenantEnvReads(source: string): number {
  return [...source.matchAll(/process\.env\.KYBERION_TENANT\b/g)].length;
}

/** Check one source file; exported for hermetic fixture tests. */
export function findKnowledgeScopeViolations(
  source: string,
  relativeFile: string,
  config: KnowledgeScopeCheckConfig = DEFAULT_CONFIG
): string[] {
  const withoutComments = removeComments(source);
  const fileFindings: string[] = [];
  for (const match of withoutComments.matchAll(/\bbuildScopedIndex\s*\(([^)]*)\)/g)) {
    const args = match[1].trim();
    if (!args || args.startsWith(',')) {
      fileFindings.push(`${relativeFile}: unscoped buildScopedIndex call`);
    }
  }
  for (const match of withoutComments.matchAll(/\bgetSurfaceQueryProviderConfig\s*\(([^)]*)\)/g)) {
    if (!match[1].trim()) {
      fileFindings.push(`${relativeFile}: surface-query provider resolved without scope context`);
    }
  }
  // A confidential scope literal must carry a tenant. Dynamic scopes are
  // accepted only when they come from currentScope()/a typed scope variable;
  // the static bypass this catches is an inline confidential object with no
  // tenant_slug at all.
  if (!isAllowlisted(relativeFile, config)) {
    for (const match of withoutComments.matchAll(
      /\b(?:scope|scope_context)\s*:\s*\{[^{}]{0,400}\btier\s*:\s*['"]confidential['"][^{}]{0,400}\}/g
    )) {
      if (!/\btenant_slug\s*:/u.test(match[0]) && !/\.\.\.(?:input\.)?scope\b/u.test(match[0])) {
        fileFindings.push(
          `${relativeFile}: confidential scope literal requires tenant_slug or a governed scope resolver`
        );
      }
    }
  }
  if (
    /(?:rootResolve|knowledge|path\.join)\s*\([^\n)]*["']knowledge\/confidential["']/.test(
      withoutComments
    ) &&
    !relativeFile.includes('/actuators/') &&
    !relativeFile.endsWith('/tenant-design-resolver.ts') &&
    !relativeFile.endsWith('/creative-design-resolver.ts')
  ) {
    fileFindings.push(
      `${relativeFile}: direct confidential root read requires a governed scope reader`
    );
  }
  return fileFindings;
}

export function scanKnowledgeScopeBoundaries(
  fileSources: Array<{ file: string; source: string }>,
  config: KnowledgeScopeCheckConfig = DEFAULT_CONFIG
): string[] {
  const findings = fileSources.flatMap(({ file, source }) =>
    findKnowledgeScopeViolations(source, file, config)
  );
  const directReads = fileSources.reduce(
    (total, { source }) => total + countDirectTenantEnvReads(source),
    0
  );
  if (directReads > config.max_direct_tenant_env_reads) {
    findings.push(
      `process.env.${'KYBERION_TENANT'} direct reads increased beyond baseline: ${directReads} > ${config.max_direct_tenant_env_reads}`
    );
  }
  return findings;
}

/**
 * Runtime writer ratchet for the knowledge loop. A listed writer may retain a
 * legacy/global fallback, but it must also contain the physical namespace
 * helper or the scoped registry's physical result. This checks a real imported
 * call, not a helper name in a comment/string. It is a mechanical adoption
 * gate; storage scope correctness remains covered by domain boundary tests.
 */
export function findKnowledgeRuntimeWriterViolations(
  fileSources: Array<{ file: string; source: string }>,
  config: KnowledgeScopeCheckConfig = DEFAULT_CONFIG
): string[] {
  const sources = new Map(fileSources.map((entry) => [entry.file, entry.source]));
  return (config.scoped_runtime_writer_files || []).flatMap((file) => {
    const source = sources.get(file);
    if (source === undefined) return [`${file}: scoped runtime writer was not scanned`];
    return usesScopedRuntimePlacement(source, file)
      ? []
      : [
          `${file}: scoped runtime writer must use physicalScopedPath or scoped runtimeStatePath physicalPath`,
        ];
  });
}

function usesScopedRuntimePlacement(source: string, filename: string): boolean {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const physicalImports = new Set<string>();
  const registryImports = new Set<string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier))
      continue;
    const clause = statement.importClause;
    if (
      !clause ||
      clause.isTypeOnly ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    )
      continue;
    const module = statement.moduleSpecifier.text;
    for (const binding of clause.namedBindings.elements) {
      if (binding.isTypeOnly) continue;
      const exported = binding.propertyName?.text ?? binding.name.text;
      if (exported === 'physicalScopedPath' && /(?:^|\/)physical-namespace(?:\.js)?$/.test(module))
        physicalImports.add(binding.name.text);
      if (
        exported === 'runtimeStatePath' &&
        /(?:^|\/)foundation\/runtime-state-roots(?:\.js)?$/.test(module)
      )
        registryImports.add(binding.name.text);
    }
  }
  const hasScope = (argument: ts.Expression | undefined): boolean =>
    !!argument &&
    argument.kind !== ts.SyntaxKind.NullKeyword &&
    !(ts.isIdentifier(argument) && argument.text === 'undefined');
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      physicalImports.has(node.expression.text) &&
      hasScope(node.arguments[1])
    )
      found = true;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'physicalPath' &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      registryImports.has(node.expression.expression.text) &&
      hasScope(node.expression.arguments[1]) &&
      node.expression.arguments[0] &&
      ts.isStringLiteralLike(node.expression.arguments[0]) &&
      node.expression.arguments[0].text === 'memory.promotionQueue'
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function collectSources(): Array<{ file: string; source: string }> {
  const files: Array<{ file: string; source: string }> = [];
  for (const relativeRoot of roots) {
    const absoluteRoot = path.join(root, relativeRoot);
    for (const file of getAllFiles(absoluteRoot)) {
      const relativeFile = path.relative(root, file).replace(/\\/g, '/');
      if (!sourceExtensions.has(path.extname(file)) || relativeFile.includes('/dist/')) continue;
      if (relativeFile.endsWith('.test.ts') || relativeFile.endsWith('.test.tsx')) continue;
      if (relativeFile === 'scripts/check_knowledge_scope_boundaries.ts') continue;
      files.push({
        file: relativeFile,
        source: readKnowledgeScopeTextFile(file),
      });
    }
  }
  return files;
}

export function scan(): string[] {
  const sources = collectSources();
  const config = loadConfig();
  return [
    ...scanKnowledgeScopeBoundaries(sources, config),
    ...findKnowledgeRuntimeWriterViolations(sources, config),
  ];
}

export const runCheckKnowledgeScopeBoundaries = defineScript({
  name: 'check:knowledge-scope-boundaries',
  flags: [],
  run(context) {
    const findings = scan();
    if (findings.length > 0) {
      throw new ScriptExitError(
        1,
        ['FAILED', ...findings.map((finding) => `- ${finding}`)].join('\n')
      );
    }
    context.print('[check_knowledge_scope_boundaries] OK');
    return { findings };
  },
});

if (
  isDirectScript(import.meta.url, 'check_knowledge_scope_boundaries.ts') ||
  isDirectScript(import.meta.url, 'check_knowledge_scope_boundaries.js')
)
  void runCheckKnowledgeScopeBoundaries();
