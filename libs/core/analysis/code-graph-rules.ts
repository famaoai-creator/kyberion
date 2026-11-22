/**
 * Governed per-language enumeration rules for the reverse_spec code graph
 * (knowledge/product/governance/code-graph-enumeration-rules.json). Shared by
 * the extractor (modeling:extract_code_graph) and the code_graph gate, which
 * re-derives the module denominator from the source tree with the same rules.
 */
import { defineCatalog } from '../foundation/governed-catalog.js';
import * as pathResolver from '../path-resolver.js';

/** npm grammar package and the prebuilt WASM file it ships. */
export interface CodeGraphGrammarRef {
  package: string;
  wasm: string;
}

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
  grammar: CodeGraphGrammarRef;
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

/** Source extensions worth flagging when no rule covers them (coverage gap, not an error). */
export const SOURCE_LIKE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.kt',
  '.kts',
  '.swift',
  '.m',
  '.mm',
  '.dart',
  '.lua',
  '.pl',
  '.pm',
  '.r',
  '.jl',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.ml',
  '.fs',
  '.vb',
  '.cls',
  '.bas',
  '.frm',
  '.cbl',
  '.cob',
  '.cpy',
  '.pls',
  '.pks',
  '.pkb',
  '.sql',
  '.groovy',
  '.clj',
  '.vue',
  '.svelte',
]);

/** The rule that analyzes a source-relative file, if any (extension match minus excluded suffixes). */
export function codeGraphLanguageFor(
  file: string,
  rules: CodeGraphLanguageRule[]
): CodeGraphLanguageRule | undefined {
  const lower = file.toLowerCase();
  return rules.find(
    (rule) =>
      rule.extensions.some((ext) => lower.endsWith(ext)) &&
      !(rule.exclude_suffixes ?? []).some((suffix) => lower.endsWith(suffix))
  );
}
