/**
 * web-tree-sitter grammar loading. WASM bytes (runtime and grammars) are read
 * through secure-io and handed to the runtime as buffers, so no file access
 * happens outside the governed reader. Grammar packages ship prebuilt WASM;
 * their native addons are never built (pnpm-workspace allowBuilds: false).
 *
 * Lifetime: a Language (compiled grammar module) cannot be unloaded and is cached for the
 * process — bounded by the rules catalog. Parsers and compiled queries hold WASM heap and are
 * released when the last open grammar session ends (`withGrammarSession`), so a long-running
 * actuator does not keep them alive between extractions.
 */
import { createRequire } from 'node:module';
import { safeReadFile } from '@agent/core/secure-io';
import type { CodeGraphGrammarRef } from '@agent/core/source-analysis';
import { Language, Parser, Query, type Tree } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export type GrammarRef = CodeGraphGrammarRef;

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

interface SessionGrammar extends LoadedGrammar {
  dispose(): void;
}

let runtimeReady: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();
const grammars = new Map<string, Promise<SessionGrammar>>();
let openSessions = 0;

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

function loadLanguage(ref: GrammarRef): Promise<Language> {
  const key = `${ref.package}/${ref.wasm}`;
  let language = languages.get(key);
  if (!language) {
    language = initRuntime().then(() =>
      Language.load(readPackageFile(`${ref.package}/${ref.wasm}`))
    );
    // A failed load (missing package, bad WASM) must not poison later attempts.
    language.catch(() => {
      if (languages.get(key) === language) languages.delete(key);
    });
    languages.set(key, language);
  }
  return language;
}

async function createGrammar(ref: GrammarRef): Promise<SessionGrammar> {
  const language = await loadLanguage(ref);
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
    dispose() {
      for (const query of queries.values()) query.delete();
      queries.clear();
      parser.delete();
    },
  };
}

/** Release every cached parser and compiled query (languages stay loaded). */
export async function disposeGrammars(): Promise<void> {
  const loaded = [...grammars.values()];
  grammars.clear();
  for (const result of await Promise.allSettled(loaded))
    if (result.status === 'fulfilled') result.value.dispose();
}

/**
 * Run `work` with grammars available; when the last concurrent session ends, parsers and
 * queries are freed. Trees obtained inside the session must be released before it ends.
 */
export async function withGrammarSession<T>(work: () => Promise<T>): Promise<T> {
  openSessions += 1;
  try {
    return await work();
  } finally {
    openSessions -= 1;
    if (openSessions === 0) await disposeGrammars();
  }
}

/** Number of grammars holding a live parser (for tests and diagnostics). */
export function cachedGrammarCount(): number {
  return grammars.size;
}

/**
 * Load the grammar named by a rules entry (shared until the last grammar session ends). Call it
 * inside `withGrammarSession`: outside one, the grammar may be freed when another session ends.
 */
export function loadGrammar(ref: GrammarRef): Promise<LoadedGrammar> {
  const key = `${ref.package}/${ref.wasm}`;
  let grammar = grammars.get(key);
  if (!grammar) {
    grammar = createGrammar(ref);
    // A failed load (missing package, bad WASM) must not poison later attempts.
    grammar.catch(() => {
      if (grammars.get(key) === grammar) grammars.delete(key);
    });
    grammars.set(key, grammar);
  }
  return grammar;
}
