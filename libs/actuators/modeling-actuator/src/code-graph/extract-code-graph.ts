/**
 * Code-graph extraction for reverse_spec missions (the coverage denominator).
 *
 * Route A parses every source file with web-tree-sitter and runs the marker
 * queries from the governed enumeration rules; route B scans the same files
 * line by line with each marker's independent line pattern (and, for modules,
 * lists files by extension). Both routes feed one registry: the denominator is
 * their union, and the per-kind reconciliation records counts and the element
 * difference so an operator resolves every disagreement instead of a silent
 * pick. Nothing is ever written to the analyzed source.
 */
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import {
  computeSourceFingerprint,
  listSourceTreeFiles,
  resolveWorkspaceSourceRoot,
  codeGraphLanguageFor,
  loadCodeGraphEnumerationRules,
  SOURCE_LIKE_EXTENSIONS,
  type CodeGraphLanguageRule,
  type CodeGraphMarkerRule,
} from '@agent/core/source-analysis';
import { loadGrammar, withGrammarSession, type LoadedGrammar } from './grammar-loader.js';
import { resolveImport, type ImportResolutionContext } from './import-resolution.js';

export type CodeGraphNodeKind = 'module' | 'entrypoint' | 'boundary';

export interface CodeGraphNode {
  id: string;
  kind: CodeGraphNodeKind;
  subtype: string;
  language: string;
  path: string;
  line: number;
  name?: string;
  routes: ('a' | 'b')[];
}

export interface CodeGraphEdge {
  from: string;
  to: string;
  kind: 'imports';
  path: string;
  line: number;
}

export interface CodeGraphReconciliationRow {
  node_kind: CodeGraphNodeKind;
  route_a: { definition: string; count: number };
  route_b: { definition: string; count: number };
  only_in_a: string[];
  only_in_b: string[];
  resolution: string;
}

export interface CodeGraphRegistry {
  kind: 'code-graph-registry';
  schema_version: 1;
  generated_by: {
    op: 'modeling:extract_code_graph';
    rules_version: string;
    languages: string[];
  };
  source_root: string;
  source_fingerprint: { algorithm: 'sha256'; value: string; file_count: number };
  excluded_paths: string[];
  languages: Record<string, { files: number; parsed: number; parse_errors: number }>;
  unanalyzed_extensions: Record<string, number>;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  external_dependencies: string[];
  unresolved_imports: { path: string; line: number; source: string }[];
  reconciliation: CodeGraphReconciliationRow[];
}

export interface ExtractCodeGraphOptions {
  sourceRoot: string;
  /** Restrict to these rule language ids (default: every language in the rules). */
  languages?: string[];
  /** Source-relative path prefixes left out of the graph (declare each as a scope exclusion). */
  exclude?: string[];
  maxFiles?: number;
}

const NODE_KINDS: CodeGraphNodeKind[] = ['module', 'entrypoint', 'boundary'];

interface MarkerHit {
  kind: CodeGraphNodeKind;
  subtype: string;
  line: number;
  name?: string;
}

/** Code-unit order: deterministic across machines and ICU locales. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function markerKey(hit: { subtype: string; line: number }, file: string): string {
  return `${hit.subtype}@${file}:${hit.line}`;
}

function nodeId(
  kind: CodeGraphNodeKind,
  file: string,
  hit?: { subtype: string; line: number }
): string {
  if (kind === 'module') return `MOD:${file}`;
  return `${kind === 'entrypoint' ? 'EP' : 'BND'}:${hit!.subtype}:${file}:${hit!.line}`;
}

const compiledPatterns = new Map<string, RegExp>();

function linePattern(source: string): RegExp {
  let pattern = compiledPatterns.get(source);
  if (!pattern) {
    pattern = new RegExp(source, 'u');
    compiledPatterns.set(source, pattern);
  }
  return pattern;
}

function scanLinePatterns(text: string, markers: CodeGraphMarkerRule[]): MarkerHit[] {
  const lines = text.split('\n');
  const hits: MarkerHit[] = [];
  for (const marker of markers) {
    const pattern = linePattern(marker.line_pattern);
    lines.forEach((line, index) => {
      if (pattern.test(line))
        hits.push({ kind: marker.kind, subtype: marker.subtype, line: index + 1 });
    });
  }
  return hits;
}

function runMarkerQueries(
  grammar: LoadedGrammar,
  tree: unknown,
  markers: CodeGraphMarkerRule[]
): MarkerHit[] {
  const hits: MarkerHit[] = [];
  for (const marker of markers) {
    const seen = new Set<number>();
    for (const capture of grammar.captures(marker.query, tree, 'marker')) {
      const line = capture.line;
      if (seen.has(line)) continue;
      seen.add(line);
      hits.push({
        kind: marker.kind,
        subtype: marker.subtype,
        line,
        ...(capture.name ? { name: capture.name } : {}),
      });
    }
  }
  return hits;
}

/** Extract the code-graph registry for a workspace source root. Read-only against the source. */
export function extractCodeGraph(options: ExtractCodeGraphOptions): Promise<CodeGraphRegistry> {
  // Parsers and compiled queries live only for the extraction (see grammar-loader lifetime).
  return withGrammarSession(() => extractCodeGraphInSession(options));
}

async function extractCodeGraphInSession(
  options: ExtractCodeGraphOptions
): Promise<CodeGraphRegistry> {
  const root = resolveWorkspaceSourceRoot(options.sourceRoot);
  const rules = loadCodeGraphEnumerationRules();
  const languageRules = options.languages?.length
    ? rules.languages.filter((rule) => options.languages!.includes(rule.id))
    : rules.languages;
  // Files of rule languages left out by the filter are a coverage gap, reported like any other.
  const filteredOut = rules.languages.filter((rule) => !languageRules.includes(rule));
  if (options.languages?.length) {
    const unknown = options.languages.filter(
      (id) => !rules.languages.some((rule) => rule.id === id)
    );
    if (unknown.length) {
      throw new Error(
        `[CODE_GRAPH] unknown language id(s): ${unknown.join(', ')} — known: ${rules.languages.map((rule) => rule.id).join(', ')}`
      );
    }
  }
  const files = listSourceTreeFiles(root.absolute, { maxFiles: options.maxFiles });
  // The fingerprint covers the whole tree (source intact); exclusions only narrow the graph.
  const fingerprint = computeSourceFingerprint(root.absolute, { files });
  const excluded = [
    ...new Set(
      (options.exclude ?? []).map((entry) => path.posix.normalize(entry).replace(/\/$/u, ''))
    ),
  ]
    .filter((entry) => entry && entry !== '.')
    .sort();
  const isExcluded = (file: string): boolean =>
    excluded.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));

  const byLanguage = new Map<CodeGraphLanguageRule, string[]>();
  const unanalyzed: Record<string, number> = {};
  for (const file of files) {
    if (isExcluded(file)) continue;
    const rule = codeGraphLanguageFor(file, languageRules);
    if (rule) {
      const list = byLanguage.get(rule) ?? [];
      list.push(file);
      byLanguage.set(rule, list);
      continue;
    }
    const ext = path.posix.extname(file).toLowerCase();
    if (SOURCE_LIKE_EXTENSIONS.has(ext) || codeGraphLanguageFor(file, filteredOut))
      unanalyzed[ext] = (unanalyzed[ext] ?? 0) + 1;
  }

  const nodes = new Map<string, CodeGraphNode>();
  const routeKeys: Record<CodeGraphNodeKind, { a: Set<string>; b: Set<string> }> = {
    module: { a: new Set(), b: new Set() },
    entrypoint: { a: new Set(), b: new Set() },
    boundary: { a: new Set(), b: new Set() },
  };
  const languages: CodeGraphRegistry['languages'] = {};
  const pendingImports: {
    from: string;
    rule: CodeGraphLanguageRule;
    line: number;
    source: string;
  }[] = [];
  const namespaceIndex = new Map<string, string[]>();

  const addNode = (node: Omit<CodeGraphNode, 'routes'>, route: 'a' | 'b'): void => {
    const existing = nodes.get(node.id);
    if (existing) {
      if (!existing.routes.includes(route)) existing.routes.push(route);
      if (!existing.name && node.name) existing.name = node.name;
      return;
    }
    nodes.set(node.id, { ...node, routes: [route] });
  };

  for (const [rule, ruleFiles] of byLanguage) {
    const grammar = await loadGrammar(rule.grammar);
    const stats = { files: ruleFiles.length, parsed: 0, parse_errors: 0 };
    for (const file of ruleFiles) {
      const text = String(
        safeReadFile(path.join(root.absolute, file), { encoding: 'utf8', maxSizeMB: 64 })
      );
      // Route B: the file exists with this extension; markers by line pattern.
      routeKeys.module.b.add(file);
      addNode(
        {
          id: nodeId('module', file),
          kind: 'module',
          subtype: 'source_file',
          language: rule.id,
          path: file,
          line: 1,
        },
        'b'
      );
      for (const hit of scanLinePatterns(text, rule.markers)) {
        routeKeys[hit.kind].b.add(markerKey(hit, file));
        addNode(
          {
            id: nodeId(hit.kind, file, hit),
            kind: hit.kind,
            subtype: hit.subtype,
            language: rule.id,
            path: file,
            line: hit.line,
          },
          'b'
        );
      }
      // Route A: a clean parse counts the module; marker queries over the tree.
      const tree = grammar.parse(text);
      try {
        if (grammar.hasError(tree)) stats.parse_errors += 1;
        else {
          stats.parsed += 1;
          routeKeys.module.a.add(file);
          addNode(
            {
              id: nodeId('module', file),
              kind: 'module',
              subtype: 'source_file',
              language: rule.id,
              path: file,
              line: 1,
            },
            'a'
          );
        }
        for (const hit of runMarkerQueries(grammar, tree, rule.markers)) {
          routeKeys[hit.kind].a.add(markerKey(hit, file));
          addNode(
            {
              id: nodeId(hit.kind, file, hit),
              kind: hit.kind,
              subtype: hit.subtype,
              language: rule.id,
              path: file,
              line: hit.line,
              ...(hit.name ? { name: hit.name } : {}),
            },
            'a'
          );
        }
        if (rule.imports) {
          for (const capture of grammar.captures(rule.imports.query, tree, 'source')) {
            pendingImports.push({ from: file, rule, line: capture.line, source: capture.text });
          }
          if (rule.imports.declarations) {
            for (const capture of grammar.captures(rule.imports.declarations, tree, 'namespace')) {
              const list = namespaceIndex.get(capture.text) ?? [];
              list.push(file);
              namespaceIndex.set(capture.text, list);
            }
          }
        }
      } finally {
        grammar.release(tree);
      }
    }
    languages[rule.id] = stats;
  }

  const fileSet = new Set(files.filter((file) => !isExcluded(file)));
  const context: ImportResolutionContext = {
    files: fileSet,
    namespaces: namespaceIndex,
    readText: (relative) =>
      String(safeReadFile(path.join(root.absolute, relative), { encoding: 'utf8', maxSizeMB: 4 })),
  };
  const edges = new Map<string, CodeGraphEdge>();
  const external = new Set<string>();
  const unresolved: CodeGraphRegistry['unresolved_imports'] = [];
  for (const item of pendingImports) {
    const result = resolveImport(item.rule.imports!, item.from, item.source, context);
    if (result.kind === 'internal') {
      for (const target of result.files) {
        if (target === item.from || !nodes.has(nodeId('module', target))) continue;
        const edge: CodeGraphEdge = {
          from: nodeId('module', item.from),
          to: nodeId('module', target),
          kind: 'imports',
          path: item.from,
          line: item.line,
        };
        edges.set(`${edge.from}->${edge.to}`, edges.get(`${edge.from}->${edge.to}`) ?? edge);
      }
    } else if (result.kind === 'external') external.add(result.name);
    else unresolved.push({ path: item.from, line: item.line, source: item.source });
  }

  const definitions: Record<CodeGraphNodeKind, { a: string; b: string }> = {
    module: {
      a: 'tree-sitter: rule-extension files that parse without syntax errors (a subset of route B; only_in_b lists unparsable files)',
      b: 'file listing by rule extensions after exclusions',
    },
    entrypoint: {
      a: 'tree-sitter marker queries (kind=entrypoint) from code-graph-enumeration-rules',
      b: 'line-pattern scan (kind=entrypoint) from code-graph-enumeration-rules',
    },
    boundary: {
      a: 'tree-sitter marker queries (kind=boundary) from code-graph-enumeration-rules',
      b: 'line-pattern scan (kind=boundary) from code-graph-enumeration-rules',
    },
  };
  const reconciliation = NODE_KINDS.map((kind): CodeGraphReconciliationRow => {
    const { a, b } = routeKeys[kind];
    return {
      node_kind: kind,
      route_a: { definition: definitions[kind].a, count: a.size },
      route_b: { definition: definitions[kind].b, count: b.size },
      only_in_a: [...a].filter((key) => !b.has(key)).sort(),
      only_in_b: [...b].filter((key) => !a.has(key)).sort(),
      resolution: '',
    };
  });

  const sortedNodes = [...nodes.values()].sort((left, right) => compareText(left.id, right.id));
  for (const node of sortedNodes) node.routes.sort();
  return {
    kind: 'code-graph-registry',
    schema_version: 1,
    generated_by: {
      op: 'modeling:extract_code_graph',
      rules_version: rules.version,
      languages: languageRules.map((rule) => rule.id).sort(),
    },
    source_root: root.relative,
    source_fingerprint: fingerprint,
    excluded_paths: excluded,
    languages,
    unanalyzed_extensions: unanalyzed,
    nodes: sortedNodes,
    edges: [...edges.values()].sort((left, right) =>
      compareText(`${left.from}->${left.to}`, `${right.from}->${right.to}`)
    ),
    external_dependencies: [...external].sort(),
    unresolved_imports: unresolved.sort(
      (left, right) =>
        compareText(`${left.path}:${left.line}`, `${right.path}:${right.line}`) ||
        left.line - right.line
    ),
    reconciliation,
  };
}
