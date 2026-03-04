import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
// chalk imported dynamically
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const skillsDir = path.join(rootDir, 'skills');
const IGNORE_DIRS = ['node_modules', 'dist', '.git', 'coverage', 'tests', 'config', 'scripts'];

/**
 * scripts/skill-sanitizer.ts v4.0
 * Sovereign Monorepo Health Guard - Advanced TS Edition
 */

interface SanitizerMetrics {
  scanned: number;
  drift: number;
  patched: number;
  fixed: number;
  failed: number;
  antiPatterns: number;
}

console.log(chalk.bold.cyan('\n🛡️  Project Sanitas: Advanced Skill Guardian v4.0'));
console.log(chalk.dim('━'.repeat(60)));

// 0. Infrastructure Pre-flight Check
const infraIssues: string[] = [];
if (!fs.existsSync(path.join(rootDir, 'pnpm-workspace.yaml'))) infraIssues.push('Missing pnpm-workspace.yaml');
if (!fs.existsSync(path.join(rootDir, 'libs/core/skill-wrapper.d.cts'))) infraIssues.push('Missing core type definitions (d.cts)');

if (infraIssues.length > 0) {
  console.log(chalk.red.bold('🚨 Critical Infrastructure Issues:'));
  infraIssues.forEach(i => console.log(chalk.red(`  - ${i}`)));
}

function getSkillDirs(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (IGNORE_DIRS.includes(file)) continue;
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        if (fs.existsSync(path.join(filePath, 'package.json')) && fs.existsSync(path.join(filePath, 'src'))) {
          results.push(filePath);
        } else {
          results = results.concat(getSkillDirs(filePath));
        }
      }
    } catch (_) {}
  }
  return results;
}

const allSkills = getSkillDirs(skillsDir);
const metrics: SanitizerMetrics = { scanned: 0, drift: 0, patched: 0, fixed: 0, failed: 0, antiPatterns: 0 };

allSkills.forEach((skillPath) => {
  metrics.scanned++;
  const skillName = path.relative(skillsDir, skillPath);
  const srcDir = path.join(skillPath, 'src');
  const distDir = path.join(skillPath, 'dist');
  const pkgPath = path.join(skillPath, 'package.json');

  const issues: string[] = [];

  // 1. Dependency Check
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const coreDep = (pkg.dependencies && pkg.dependencies['@agent/core']) || 
                    (pkg.devDependencies && pkg.devDependencies['@agent/core']);
    
    if (coreDep && coreDep === '*') {
      issues.push('CORE_DEP_DRIFT: Use "workspace:*" instead of "*" for local linking.');
    }
  } catch (_) {
    issues.push('PKG_PARSE_ERROR');
  }

  // 2. Build Drift Check
  let driftDetected = false;
  if (!fs.existsSync(distDir)) {
    driftDetected = true;
  } else {
    const srcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'));
    const distStat = fs.statSync(distDir);
    for (const f of srcFiles) {
      if (fs.statSync(path.join(srcDir, f)).mtimeMs > distStat.mtimeMs) {
        driftDetected = true;
        break;
      }
    }
  }
  if (driftDetected) issues.push('BUILD_STALE: src/ is newer than dist/ or missing artifacts.');

  // 3. Static Analysis
  const srcFiles = fs.readdirSync(srcDir, { recursive: true } as any).filter((f: any) => f.endsWith('.ts'));
  srcFiles.forEach((f: any) => {
    const content = fs.readFileSync(path.join(srcDir, f), 'utf8');
    if (content.includes('import.meta.url')) {
      issues.push(`ANTI_PATTERN: "import.meta.url" found in ${f}.`);
      metrics.antiPatterns++;
    }
  });

  if (issues.length > 0) {
    metrics.drift++;
    console.log(chalk.yellow(`\n🔍 [ISSUE] ${skillName}`));
    issues.forEach(i => console.log(chalk.dim(`   - ${i}`)));

    // Try Auto-Patch
    if (issues.some(i => i.includes('CORE_DEP_DRIFT'))) {
      let pkgContent = fs.readFileSync(pkgPath, 'utf8');
      pkgContent = pkgContent.replace(/"@agent\/core": "\*"/g, '"@agent/core": "workspace:*"');
      safeWriteFile(pkgPath, pkgContent);
    }

    process.stdout.write(chalk.dim('   Attempting recovery... '));
    try {
      execSync('pnpm run build', { cwd: skillPath, stdio: 'ignore', timeout: 60000 });
      metrics.fixed++;
      console.log(chalk.green('SUCCESS'));
    } catch (err) {
      metrics.failed++;
      console.log(chalk.red('FAILED'));
    }
  }
});

console.log(chalk.dim('\n' + '━'.repeat(60)));
console.log(chalk.bold('Sanitization Complete:'));
console.log(`- Total Skills Scanned : ${metrics.scanned}`);
console.log(`- Issues Found         : ${metrics.drift}`);
console.log(`- Fixed via Rebuild    : ${metrics.fixed}`);
console.log(`- Critical Failures    : ${metrics.failed}`);
console.log('');
