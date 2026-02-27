const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';
import * as path from 'node:path';

export function createSkillStructure(name: string, description: string, rootDir: string): string {
  const skillPath = path.join(rootDir, 'skills', 'custom', name);
  if (fs.existsSync(skillPath)) return skillPath;

  fs.mkdirSync(skillPath, { recursive: true });
  fs.mkdirSync(path.join(skillPath, 'src'), { recursive: true });
  fs.mkdirSync(path.join(skillPath, 'scripts'), { recursive: true });

  const pkg = { name, version: '0.1.0', private: true, description };
  safeWriteFile(path.join(skillPath, 'package.json'), JSON.stringify(pkg, null, 2));

  return skillPath;
}
