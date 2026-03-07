import * as path from 'node:path';
import { safeExec } from '@agent/core';

/**
 * codebase-mapper Core Library.
 * [SECURE-IO COMPLIANT VERSION]
 * Builds a tree-like text representation using safe system commands.
 */

export async function buildTreeLinesAsync(
  dirPath: string,
  maxDepth: number,
  _currentDepth: number = 0,
  _prefix: string = ''
): Promise<string[]> {
  try {
    // We use the system 'find' command to get structure safely
    // This avoids direct 'fs' usage while being highly performant
    const findArgs = [dirPath, '-maxdepth', String(maxDepth + 1), '-not', '-path', '*/.*'];
    const result = safeExec('find', findArgs);
    
    const lines = result.trim().split('\n').map(line => {
      const rel = path.relative(dirPath, line);
      if (!rel || rel === '.') return '';
      const depth = rel.split(path.sep).length;
      const indent = '  '.repeat(depth - 1);
      const isDir = line.endsWith('/') || !line.includes('.'); // Simple heuristic
      return `${indent}└── ${path.basename(line)}${isDir ? '/' : ''}`;
    }).filter(l => l !== '');

    return lines;
  } catch (err: any) {
    return [`⚠️ Error building tree: ${err.message}`];
  }
}

/**
 * Builds tree recursively using safeExec.
 */
export function buildTreeRecursive(dir: string, maxDepth: number, _depth = 0): string[] {
  try {
    const result = safeExec('find', [dir, '-maxdepth', String(maxDepth), '-not', '-path', '*/.*']);
    return result.trim().split('\n').map(line => {
      const rel = path.relative(dir, line);
      const d = rel.split(path.sep).length;
      return '  '.repeat(d) + '└── ' + path.basename(line);
    });
  } catch (_) {
    return [];
  }
}
