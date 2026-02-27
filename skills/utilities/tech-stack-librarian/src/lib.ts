const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';
import * as path from 'node:path';

export function detectStack(dir: string, bestPractices: any): any[] {
  const stack: any[] = [];
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(safeReadFile(pkgPath, 'utf8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const dep of Object.keys(allDeps)) {
        if (bestPractices[dep.toLowerCase()])
          stack.push({ name: dep, version: allDeps[dep], ...bestPractices[dep.toLowerCase()] });
      }
    } catch {}
  }
  return stack;
}
