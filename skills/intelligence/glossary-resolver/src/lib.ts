const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';

export type Glossary = Record<string, string>;

export interface ResolveFileResult {
  output: string;
  resolvedTerms: number;
}

export interface ResolveInlineResult {
  content: string;
  resolvedTerms: number;
}

export type ResolveResult = ResolveFileResult | ResolveInlineResult;

export function resolveGlossary(
  content: string,
  glossary: Glossary
): { content: string; resolvedTerms: number } {
  let result = content;
  let resolvedCount = 0;

  for (const [term, def] of Object.entries(glossary)) {
    // Escape term for regex safely
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Using string concatenation to avoid literal issues
    const regex = new RegExp('\\b' + escapedTerm + '\\b', 'g');
    const before = result;
    result = result.replace(regex, `${term} (${def})`);
    if (result !== before) resolvedCount++;
  }

  return { content: result, resolvedTerms: resolvedCount };
}

export function resolveGlossaryFile(
  inputPath: string,
  glossary: Glossary,
  outPath?: string
): ResolveResult {
  const content = safeReadFile(inputPath, 'utf8');
  const resolved = resolveGlossary(content, glossary);

  if (outPath) {
    safeWriteFile(outPath, resolved.content);
    return { output: outPath, resolvedTerms: resolved.resolvedTerms };
  }

  return { content: resolved.content, resolvedTerms: resolved.resolvedTerms };
}
