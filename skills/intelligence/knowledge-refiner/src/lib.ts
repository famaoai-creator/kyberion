import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';

export interface KnowledgeFile {
  path: string;
  size: number;
  lines: number;
  words: number;
  modified: string;
  content: string;
}

export interface Duplicate {
  file1: string;
  file2: string;
  type: 'exact' | 'similar';
  similarity?: number;
}

export interface RefinementResult {
  directory: string;
  action: string;
  summary: {
    totalFiles: number;
    totalWords: number;
    totalLines: number;
  };
  duplicateCount: number;
  duplicates: Duplicate[];
  qualityIssues: any[];
  recommendations: string[];
}

export function scanKnowledge(dir: string): KnowledgeFile[] {
  const files: KnowledgeFile[] = [];
  const allFiles = getAllFiles(dir, { maxDepth: 5 });
  for (const full of allFiles) {
    if (['.md', '.json', '.yaml', '.yml', '.txt'].includes(path.extname(full).toLowerCase())) {
      try {
        const stat = fs.statSync(full);
        const content = fs.readFileSync(full, 'utf8');
        files.push({
          path: path.relative(dir, full),
          size: stat.size,
          lines: content.split(new RegExp('\\r?\\n')).length,
          words: content.split(new RegExp('\\s+')).length,
          modified: stat.mtime.toISOString(),
          content,
        });
      } catch (_e) {
        /* ignore */
      }
    }
  }
  return files;
}

export function findDuplicates(files: KnowledgeFile[]): Duplicate[] {
  const duplicates: Duplicate[] = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      if (files[i].content === files[j].content) {
        duplicates.push({ file1: files[i].path, file2: files[j].path, type: 'exact' });
      } else {
        const words1 = new Set(files[i].content.toLowerCase().split(new RegExp('\\s+')));
        const words2 = new Set(files[j].content.toLowerCase().split(new RegExp('\\s+')));
        const intersection = Array.from(words1).filter((w) => words2.has(w)).length;
        const similarity = intersection / Math.max(words1.size, words2.size);
        if (similarity > 0.8 && words1.size > 20) {
          duplicates.push({
            file1: files[i].path,
            file2: files[j].path,
            type: 'similar',
            similarity: Math.round(similarity * 100),
          });
        }
      }
    }
  }
  return duplicates;
}
