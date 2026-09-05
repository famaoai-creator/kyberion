/** KS-16: semantic static checks for knowledge scope choke points. */
import * as path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';
import { loadKnowledgeScopeCheckPolicy } from '@agent/core/knowledge-scope-check-policy';
import { safeReadFile } from '@agent/core/secure-io';
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
 * helper so a tenant-scoped write cannot silently fall back to one shared
 * file. The list is governed in knowledge-scope-check.json and reviewed with
 * the storage layout.
 */
export function findKnowledgeRuntimeWriterViolations(
  fileSources: Array<{ file: string; source: string }>,
  config: KnowledgeScopeCheckConfig = DEFAULT_CONFIG
): string[] {
  const sources = new Map(fileSources.map((entry) => [entry.file, entry.source]));
  return (config.scoped_runtime_writer_files || []).flatMap((file) => {
    const source = sources.get(file);
    if (source === undefined) return [`${file}: scoped runtime writer was not scanned`];
    return source.includes('physicalScopedPath')
      ? []
      : [`${file}: scoped runtime writer must use physicalScopedPath`];
  });
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
        source: String(safeReadFile(file, { encoding: 'utf8' }) || ''),
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
