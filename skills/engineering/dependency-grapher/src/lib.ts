const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'fs';
import * as path from 'path';

export interface GraphResult {
  mermaid: string;
  skillCount: number;
}

/**
 * Generates a Mermaid dependency graph by scanning the given directory for skills.
 * Supports nested category directories.
 */
export function generateMermaidGraph(rootDir: string): GraphResult {
  let mermaid = `graph TD
    subgraph Shared_Library
        Lib[libs/core/]
    end

`;

  let skillCount = 0;

  function scan(dir: string) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      if (!fs.statSync(fullPath).isDirectory() || item === 'node_modules' || item === 'core')
        continue;

      if (fs.existsSync(path.join(fullPath, 'SKILL.md'))) {
        skillCount++;
        const skillId = item.replace(/-/g, '_');
        mermaid += `    ${skillId}[${item}]\n`;

        // Deep dependency check for @agent/core
        const srcDir = path.join(fullPath, 'src');
        if (fs.existsSync(srcDir)) {
          const files = fs.readdirSync(srcDir);
          for (const file of files) {
            if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.cjs')) {
              const content = safeReadFile(path.join(srcDir, file), 'utf8');
              if (content.includes('@agent/core')) {
                mermaid += `    ${skillId} --> Lib\n`;
                break;
              }
            }
          }
        }
      } else {
        // Recursive scan for category directories
        scan(fullPath);
      }
    }
  }

  scan(rootDir);
  return { mermaid, skillCount };
}
