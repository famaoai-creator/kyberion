import path from 'path';
import { walkAsync } from '@agent/core/fs-utils';

export async function buildTreeLinesAsync(dir: string, maxDepth: number = 3): Promise<string[]> {
  const lines: string[] = [];

  // 1. Collect all paths
  const paths: string[] = [];
  try {
    for await (const file of walkAsync(dir, { maxDepth })) {
      const relative = path.relative(dir, file);
      paths.push(relative);
    }
  } catch (error) {
    throw error;
  }

  // 2. Sort paths to ensure directory order
  paths.sort();

  // 3. Generate tree structure
  interface TreeNode {
    [key: string]: TreeNode;
  }
  const rootNode: TreeNode = {};

  for (const p of paths) {
    const parts = p.split(path.sep);
    let current = rootNode;
    for (const part of parts) {
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
  }

  // Recursive function to print the tree
  function printNode(node: TreeNode, prefix: string) {
    const keys = Object.keys(node).sort();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const isLastItem = i === keys.length - 1;
      const marker = isLastItem ? '└── ' : '├── ';

      lines.push(`${prefix}${marker}${key}`);

      const childPrefix = prefix + (isLastItem ? '    ' : '│   ');
      // Only recurse if not empty (it's a directory or has content)
      if (Object.keys(node[key]).length > 0) {
        printNode(node[key], childPrefix);
      }
    }
  }

  printNode(rootNode, '');

  if (lines.length === 0) {
    lines.push('(No files found)');
  }

  return lines;
}
