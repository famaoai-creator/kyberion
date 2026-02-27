import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeWriteFile } from '@agent/core/secure-io';

export type ProjectType = 'node' | 'python' | 'generic';

export interface GenerationResult {
  name: string;
  type: ProjectType;
  files: string[];
  directory: string;
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, content);
}

export function generateNodeProject(name: string, outDir: string): string[] {
  const files: string[] = [];
  const pkg = {
    name,
    version: '1.0.0',
    main: 'src/index.js',
    scripts: { start: 'node src/index.js', test: 'jest', lint: 'eslint src/' },
    devDependencies: { jest: '^29.0.0', eslint: '^8.0.0' },
  };
  writeFile(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\\n');
  files.push('package.json');

  writeFile(path.join(outDir, 'README.md'), `# ${name}\\n\\nA Node.js project.\\n`);
  files.push('README.md');

  writeFile(path.join(outDir, '.gitignore'), `node_modules/\\ndist/\\n`);
  files.push('.gitignore');

  writeFile(
    path.join(outDir, 'src', 'index.js'),
    `'use strict';\\nconsole.log('Hello from ${name}!');\\n`
  );
  files.push('src/index.js');

  return files;
}

export function generatePythonProject(name: string, outDir: string): string[] {
  const files: string[] = [];
  const pyName = name.replace(/-/g, '_');
  const setupPy = `from setuptools import setup, find_packages\\nsetup(name='${name}', version='1.0.0', packages=find_packages(where='src'))\\n`;
  writeFile(path.join(outDir, 'setup.py'), setupPy);
  files.push('setup.py');

  writeFile(path.join(outDir, 'README.md'), `# ${name}\\n\\nA Python project.\\n`);
  files.push('README.md');

  return files;
}

export function generateGenericProject(name: string, outDir: string): string[] {
  const files: string[] = [];
  writeFile(path.join(outDir, 'README.md'), `# ${name}\\n\\nA project.\\n`);
  files.push('README.md');
  writeFile(
    path.join(outDir, 'Makefile'),
    `# ${name} Makefile\\nall: build\\nbuild:\\n\\t@echo "Building..."\\n`
  );
  files.push('Makefile');
  return files;
}
