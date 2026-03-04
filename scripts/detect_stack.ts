/**
 * scripts/detect_stack.ts
 * Scans package.json and other markers to detect the technical stack.
 * Usage: npx tsx scripts/detect_stack.ts [directory]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const targetDir = process.argv[2] || '.';
const pkgPath = path.join(targetDir, 'package.json');

console.log(`--- Tech Stack Detection: [${targetDir}] ---`);

if (fs.existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    
    console.log('\n[Languages/Runtimes]:');
    if (deps['typescript']) console.log('- TypeScript');
    console.log('- Node.js');

    console.log('\n[Frameworks/Libraries]:');
    const common = ['react', 'next', 'express', 'fastify', 'vue', 'angular', 'svelte', 'vitest', 'jest'];
    Object.keys(deps).forEach(d => {
      if (common.includes(d.toLowerCase())) console.log(`- ${d} (${deps[d]})`);
    });

    console.log('\n[Tools/Config]:');
    if (fs.existsSync(path.join(targetDir, 'docker-compose.yml'))) console.log('- Docker Compose');
    if (fs.existsSync(path.join(targetDir, 'tsconfig.json'))) console.log('- TypeScript Config');
    if (fs.existsSync(path.join(targetDir, 'pnpm-workspace.yaml'))) console.log('- pnpm Workspace');

  } catch (err) {
    console.error('Failed to parse package.json');
  }
} else {
  console.log('No package.json found. Scanning for other markers...');
  if (fs.existsSync(path.join(targetDir, 'requirements.txt'))) console.log('- Python (requirements.txt)');
  if (fs.existsSync(path.join(targetDir, 'go.mod'))) console.log('- Go (go.mod)');
}
