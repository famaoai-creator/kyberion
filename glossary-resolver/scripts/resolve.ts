/**
 * TypeScript version of the glossary-resolver skill.
 *
 * Resolves glossary terms in document content by appending definitions
 * inline wherever a term is found.
 *
 * The CLI entry point remains in resolve.cjs; this module exports
 * typed helper functions for the core resolution logic.
 *
 * Usage:
 *   import { resolveGlossary } from './resolve.js';
 *   const result = resolveGlossary(content, { API: 'Application Programming Interface' });
 */

import * as fs from 'node:fs';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A glossary mapping term names to their definitions. */
export type Glossary = Record<string, string>;

/** Result when output is written to a file. */
export interface ResolveFileResult {
  output: string;
  resolvedTerms: number;
}

/** Result when output is returned inline. */
export interface ResolveInlineResult {
  content: string;
  resolvedTerms: number;
}

/** Union of possible resolve results. */
export type ResolveResult = ResolveFileResult | ResolveInlineResult;

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

/**
 * Resolve glossary terms in content by appending definitions inline.
 *
 * Each term is matched as a word boundary (`\bterm\b`) and replaced
 * with `term (definition)`. The replacement is applied globally.
 *
 * @param content  - The document text to process
 * @param glossary - Map of term to definition
 * @returns Object with resolved content and count of terms that had matches
 */
export function resolveGlossary(
  content: string,
  glossary: Glossary
): { content: string; resolvedTerms: number } {
  let result = content;
  let resolvedCount = 0;

  for (const [term, def] of Object.entries(glossary)) {
    const regex = new RegExp(`\\b${term}\\b`, 'g');
    const before = result;
    result = result.replace(regex, `${term} (${def})`);
    if (result !== before) resolvedCount++;
  }

  return { content: result, resolvedTerms: resolvedCount };
}

/**
 * Resolve glossary terms in a file and optionally write the result to disk.
 *
 * @param inputPath   - Path to the input document
 * @param glossary    - Map of term to definition
 * @param outPath     - Optional output file path; if omitted, content is returned inline
 * @returns Resolve result (file or inline)
 */
export function resolveGlossaryFile(
  inputPath: string,
  glossary: Glossary,
  outPath?: string
): ResolveResult {
  const content = fs.readFileSync(inputPath, 'utf8');
  const resolved = resolveGlossary(content, glossary);

  if (outPath) {
    fs.writeFileSync(outPath, resolved.content);
    return { output: outPath, resolvedTerms: resolved.resolvedTerms };
  }

  return { content: resolved.content, resolvedTerms: resolved.resolvedTerms };
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the glossary-resolver skill.
 *
 * @param result  - Resolve result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildResolveOutput(
  result: ResolveResult,
  startMs: number
): SkillOutput<ResolveResult> {
  return {
    skill: 'glossary-resolver',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
