/**
 * Governed per-language enumeration rules for the code graph. The rules are
 * data (knowledge/product/governance/code-graph-enumeration-rules.json): adding
 * a language or a marker is a catalog change validated by its schema, not a
 * code change.
 */
import { defineCatalog } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import type { GrammarRef } from './grammar-loader.js';

export type ImportResolverKind =
  'relative_path' | 'python_module' | 'qualified_name' | 'namespace' | 'go_package' | 'rust_module';

export interface CodeGraphImportRule {
  resolver: ImportResolverKind;
  /** tree-sitter query; the import target is captured as `@source`. */
  query: string;
  /** relative_path only: how a specifier without ./ or ../ is read (default package). */
  bare_specifier?: 'package' | 'path';
  /** Path suffixes tried for relative_path resolution. */
  candidates?: string[];
  /** Namespace declarations (captured as `@namespace`) for the namespace resolver. */
  declarations?: string;
}

export interface CodeGraphMarkerRule {
  kind: 'entrypoint' | 'boundary';
  subtype: string;
  /** Route A: tree-sitter query capturing `@marker` (and optionally `@name`). */
  query: string;
  /** Route B: independent per-line regular expression for the same marker. */
  line_pattern: string;
}

export interface CodeGraphLanguageRule {
  id: string;
  grammar: GrammarRef;
  extensions: string[];
  exclude_suffixes?: string[];
  imports?: CodeGraphImportRule;
  markers: CodeGraphMarkerRule[];
}

export interface CodeGraphEnumerationRules {
  version: string;
  languages: CodeGraphLanguageRule[];
}

const catalog = defineCatalog<CodeGraphEnumerationRules>({
  id: 'code-graph-enumeration-rules',
  path: () => pathResolver.knowledge('product/governance/code-graph-enumeration-rules.json'),
  schema: pathResolver.knowledge('product/schemas/code-graph-enumeration-rules.schema.json'),
});

export function loadCodeGraphEnumerationRules(): CodeGraphEnumerationRules {
  return catalog.load();
}
