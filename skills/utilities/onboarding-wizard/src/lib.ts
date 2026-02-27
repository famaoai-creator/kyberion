const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';
import * as path from 'node:path';

export function detectPrerequisites(dir: string): string[] {
  const prerequisites = [];
  const fileExists = (filename: string) => fs.existsSync(path.join(dir, filename));

  if (fileExists('package.json')) prerequisites.push('Node.js');
  if (fileExists('requirements.txt') || fileExists('setup.py')) prerequisites.push('Python');
  if (fileExists('go.mod')) prerequisites.push('Go');
  if (fileExists('Cargo.toml')) prerequisites.push('Rust / Cargo');
  if (fileExists('Dockerfile')) prerequisites.push('Docker');
  if (fileExists('Makefile')) prerequisites.push('Make');

  return prerequisites.length > 0 ? prerequisites : ['No specific prerequisites detected'];
}

export function generateSetupSteps(dir: string): string[] {
  const steps = ['1. Clone the repository'];
  const fileExists = (filename: string) => fs.existsSync(path.join(dir, filename));

  if (fileExists('.env.example')) {
    steps.push('2. Copy `.env.example` to `.env` and fill in required values');
  }

  if (fileExists('package.json')) {
    try {
      const pkg = JSON.parse(safeReadFile(path.join(dir, 'package.json'), 'utf8'));
      const manager = fileExists('pnpm-lock.yaml')
        ? 'pnpm'
        : fileExists('yarn.lock')
          ? 'yarn'
          : 'npm';
      steps.push(steps.length + 1 + '. Install dependencies: `' + manager + ' install`');
      if (pkg.scripts?.dev) {
        steps.push(steps.length + 1 + '. Start dev server: `npm run dev`');
      }
    } catch {}
  }

  return steps;
}
