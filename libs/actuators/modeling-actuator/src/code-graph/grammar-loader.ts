/**
 * web-tree-sitter grammar loading. WASM bytes (runtime and grammars) are read
 * through secure-io and handed to the runtime as buffers, so no file access
 * happens outside the governed reader. Grammar packages ship prebuilt WASM;
 * their native addons are never built (pnpm-workspace allowBuilds: false).
 */
import { createRequire } from 'node:module';
import { safeReadFile } from '@agent/core/secure-io';
import { Language, Parser, Query, type Tree } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export interface GrammarRef {
  package: string;
  wasm: string;
}

export interface GrammarCapture {
  line: number;
  text: string;
  name?: string;
}

export interface LoadedGrammar {
  parse(text: string): Tree;
  hasError(tree: unknown): boolean;
  /** Captures named `captureName`, with an optional sibling `@name` capture from the same match. */
  captures(query: string, tree: unknown, captureName: string): GrammarCapture[];
  release(tree: unknown): void;
}

let runtimeReady: Promise<void> | undefined;
const grammars = new Map<string, Promise<LoadedGrammar>>();

function readPackageFile(specifier: string): Uint8Array {
  let resolved: string;
  try {
    resolved = require.resolve(specifier);
  } catch (error) {
    throw new Error(
      `[CODE_GRAPH] grammar asset ${specifier} is not installed — why: ${error instanceof Error ? error.message : String(error)} | next: pnpm install`
    );
  }
  return new Uint8Array(safeReadFile(resolved, { encoding: null, maxSizeMB: 64 }) as Buffer);
}

function initRuntime(): Promise<void> {
  runtimeReady ??= Parser.init({
    wasmBinary: readPackageFile('web-tree-sitter/web-tree-sitter.wasm'),
  }).catch((error: unknown) => {
    runtimeReady = undefined;
    throw error;
  });
  return runtimeReady;
}

async function createGrammar(ref: GrammarRef): Promise<LoadedGrammar> {
  await initRuntime();
  const language = await Language.load(readPackageFile(`${ref.package}/${ref.wasm}`));
  const parser = new Parser();
  parser.setLanguage(language);
  const queries = new Map<string, Query>();
  const queryFor = (source: string): Query => {
    let query = queries.get(source);
    if (!query) {
      try {
        query = new Query(language, source);
      } catch (error) {
        throw new Error(
          `[CODE_GRAPH] invalid tree-sitter query for ${ref.wasm} — why: ${error instanceof Error ? error.message : String(error)} | next: fix code-graph-enumeration-rules.json`
        );
      }
      queries.set(source, query);
    }
    return query;
  };
  return {
    parse(text) {
      const tree = parser.parse(text);
      if (!tree) throw new Error(`[CODE_GRAPH] ${ref.wasm} parser returned no tree`);
      return tree;
    },
    hasError(tree) {
      return (tree as Tree).rootNode.hasError;
    },
    captures(source, tree, captureName) {
      const result: GrammarCapture[] = [];
      for (const match of queryFor(source).matches((tree as Tree).rootNode)) {
        const name = match.captures.find((capture) => capture.name === 'name')?.node.text;
        for (const capture of match.captures) {
          if (capture.name !== captureName) continue;
          result.push({
            line: capture.node.startPosition.row + 1,
            text: capture.node.text,
            ...(name ? { name } : {}),
          });
        }
      }
      return result;
    },
    release(tree) {
      (tree as Tree).delete();
    },
  };
}

/** Load (once per process) the grammar named by a rules entry. */
export function loadGrammar(ref: GrammarRef): Promise<LoadedGrammar> {
  const key = `${ref.package}/${ref.wasm}`;
  let grammar = grammars.get(key);
  if (!grammar) {
    grammar = createGrammar(ref);
    // A failed load (missing package, bad WASM) must not poison later attempts.
    grammar.catch(() => grammars.delete(key));
    grammars.set(key, grammar);
  }
  return grammar;
}
