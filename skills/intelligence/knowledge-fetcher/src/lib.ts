const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface KnowledgeResult {
  path: string;
  content: string;
}

export interface SearchOptions {
  maxDepth?: number;
  maxFileSize?: number;
  maxResults?: number;
}

export function searchKnowledge(
  dir: string,
  query: string,
  options: SearchOptions = {},
  results: KnowledgeResult[] = [],
  depth = 0
): KnowledgeResult[] {
  const { maxDepth = 10, maxFileSize = 1024 * 1024, maxResults = 50 } = options;

  if (depth > maxDepth) return results;
  if (results.length >= maxResults) return results;
  if (!fs.existsSync(dir)) return results;

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (_e) {
    return results;
  }

  for (const file of files) {
    if (results.length >= maxResults) break;
    const fullPath = path.join(dir, file);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch (_e) {
      continue;
    }

    if (stat.isDirectory()) {
      searchKnowledge(fullPath, query, options, results, depth + 1);
    } else if (stat.isFile() && stat.size <= maxFileSize) {
      try {
        const content = safeReadFile(fullPath, 'utf8');
        if (
          file.toLowerCase().includes(query.toLowerCase()) ||
          content.toLowerCase().includes(query.toLowerCase())
        ) {
          results.push({ path: fullPath, content: content });
        }
      } catch (_e) {
        // Skip binary or unreadable files
      }
    }
  }
  return results;
}
