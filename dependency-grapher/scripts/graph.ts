/**
 * TypeScript version of the dependency-grapher skill.
 *
 * Parses package.json dependencies and builds a Mermaid-format
 * dependency graph.
 *
 * The CLI entry point remains in graph.cjs; this module exports
 * typed helper functions for the core graph-building logic.
 *
 * Usage:
 *   import { parseDependencies, buildGraph, buildGraphOutput } from './graph.js';
 *   const deps = parseDependencies(pkgJson);
 *   const mermaid = buildGraph(pkgJson.name, deps);
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single dependency entry parsed from package.json. */
export interface Dependency {
  /** Package name. */
  name: string;
  /** Semver version range string. */
  version: string;
  /** Whether this is a devDependency. */
  dev: boolean;
}

/** Complete dependency graph data. */
export interface DependencyGraph {
  /** Root package name. */
  root: string;
  /** List of all dependencies. */
  dependencies: Dependency[];
  /** Mermaid graph definition string. */
  mermaid: string;
}

/** Result of dependency graph generation. */
export interface GraphResult {
  /** File path where the graph was written, if applicable. */
  output?: string;
  /** The generated Mermaid content, if no output file was specified. */
  content?: string;
  /** Total number of nodes in the graph (root + dependencies). */
  nodeCount: number;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Parse dependencies from a package.json object.
 *
 * Extracts both `dependencies` and `devDependencies` into a unified
 * {@link Dependency} array.
 *
 * @param pkg - Parsed package.json object
 * @returns Array of dependency entries
 */
export function parseDependencies(pkg: Record<string, unknown>): Dependency[] {
  const deps: Dependency[] = [];

  const dependencies = (pkg.dependencies ?? {}) as Record<string, string>;
  for (const [name, version] of Object.entries(dependencies)) {
    deps.push({ name, version, dev: false });
  }

  const devDependencies = (pkg.devDependencies ?? {}) as Record<string, string>;
  for (const [name, version] of Object.entries(devDependencies)) {
    deps.push({ name, version, dev: true });
  }

  return deps;
}

/**
 * Build a Mermaid graph definition from a root package name and its dependencies.
 *
 * Matches the CJS implementation: produces a `graph TD` diagram with
 * the root node linking to each production dependency. Special characters
 * in package names (`@`, `/`, `.`) are replaced with underscores for
 * valid Mermaid node identifiers.
 *
 * @param rootName     - Name of the root package
 * @param dependencies - Array of dependencies to include in the graph
 * @returns Mermaid graph definition string
 */
export function buildGraph(rootName: string, dependencies: Dependency[]): string {
  let mermaid = 'graph TD\n';
  mermaid += `    Root[${rootName}]
`;

  const prodDeps = dependencies.filter((d) => !d.dev);
  for (const dep of prodDeps) {
    const nodeId = dep.name.replace(/@|\/|\./g, '_');
    mermaid += `    Root --> ${nodeId}[${dep.name}]
`;
  }

  return mermaid;
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the dependency-grapher skill.
 *
 * @param result  - Graph generation result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildGraphOutput(result: GraphResult, startMs: number): SkillOutput<GraphResult> {
  return {
    skill: 'dependency-grapher',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
