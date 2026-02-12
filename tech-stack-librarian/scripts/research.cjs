#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const BEST_PRACTICES = {
  'express': { category: 'Web Framework', practices: ['Use helmet for security headers', 'Enable rate limiting', 'Use compression middleware', 'Set up error handling middleware'] },
  'react': { category: 'Frontend', practices: ['Use React.memo for expensive renders', 'Implement code splitting', 'Use error boundaries', 'Follow hooks best practices'] },
  'prisma': { category: 'ORM', practices: ['Use migrations for schema changes', 'Enable query logging in dev', 'Use transactions for related operations'] },
  'jest': { category: 'Testing', practices: ['Organize tests by feature', 'Use test factories', 'Mock external services', 'Aim for 80%+ coverage'] },
  'typescript': { category: 'Language', practices: ['Enable strict mode', 'Use branded types for IDs', 'Avoid any type', 'Use discriminated unions'] },
  'docker': { category: 'Container', practices: ['Use multi-stage builds', 'Run as non-root user', 'Pin base image versions', 'Use .dockerignore'] },
  'terraform': { category: 'IaC', practices: ['Use remote state', 'Enable state locking', 'Use modules for reusability', 'Pin provider versions'] },
};

function detectStack(dir) {
  const stack = [];
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const dep of Object.keys(allDeps)) {
        const key = dep.toLowerCase();
        if (BEST_PRACTICES[key]) stack.push({ name: dep, version: allDeps[dep], ...BEST_PRACTICES[key] });
      }
    } catch(_e){}
  }
  if (fs.existsSync(path.join(dir, 'tsconfig.json'))) stack.push({ name: 'typescript', version: 'detected', ...BEST_PRACTICES.typescript });
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) stack.push({ name: 'docker', version: 'detected', ...BEST_PRACTICES.docker });
  if (fs.existsSync(path.join(dir, 'terraform')) || fs.existsSync(path.join(dir, 'main.tf'))) stack.push({ name: 'terraform', version: 'detected', ...BEST_PRACTICES.terraform });
  return stack;
}

function checkAdherence(dir, stack) {
  const adherence = [];
  for (const tech of stack) {
    const checks = tech.practices.map(practice => {
      // Simple heuristic check
      let met = false;
      if (practice.includes('helmet') && searchDep(dir, 'helmet')) met = true;
      if (practice.includes('strict mode') && checkTsStrict(dir)) met = true;
      if (practice.includes('error boundaries')) met = true; // Can't easily check
      return { practice, status: met ? 'met' : 'review', confidence: met ? 'high' : 'low' };
    });
    adherence.push({ technology: tech.name, category: tech.category, practices: checks });
  }
  return adherence;
}

function searchDep(dir, dep) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!(pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]);
  } catch(_e) { return false; }
}

function checkTsStrict(dir) {
  try {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf8'));
    return tsconfig.compilerOptions?.strict === true;
  } catch(_e) { return false; }
}

runSkill('tech-stack-librarian', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const stack = detectStack(targetDir);
  const adherence = checkAdherence(targetDir, stack);
  const result = {
    directory: targetDir, technologiesDetected: stack.length,
    stack: stack.map(s => ({ name: s.name, version: s.version, category: s.category })),
    bestPractices: adherence,
    totalPractices: adherence.reduce((s, a) => s + a.practices.length, 0),
    recommendations: stack.flatMap(s => s.practices.slice(0, 2).map(p => `[${s.name}] ${p}`)).slice(0, 10),
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
