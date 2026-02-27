#!/usr/bin/env node
/**
 * scripts/skill-sanitizer.cjs v2.0
 *
 * Advanced "Self-Healing Guard" for Gemini Skills.
 * - Context-aware patching (Regex with lookbehind to avoid process.argv)
 * - Parallel build capability (future optimization)
 * - Detailed error taxonomy
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');

const rootDir = path.resolve(__dirname, '..');
const skillsDir = path.join(rootDir, 'skills');
const IGNORE_DIRS = ['node_modules', 'dist', '.git', 'coverage', 'tests', 'config', 'scripts'];

console.log(chalk.bold.cyan('\n🛡️  Project Sanitas: Advanced Skill Guardian'));
console.log(chalk.dim('━'.repeat(60)));

function getSkillDirs(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (IGNORE_DIRS.includes(file)) continue;
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        if (
          fs.existsSync(path.join(filePath, 'package.json')) &&
          fs.existsSync(path.join(filePath, 'src'))
        ) {
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
let metrics = { scanned: 0, drift: 0, patched: 0, fixed: 0, failed: 0 };

allSkills.forEach((skillPath) => {
  metrics.scanned++;
  const skillName = path.relative(skillsDir, skillPath);
  const srcDir = path.join(skillPath, 'src');
  const distDir = path.join(skillPath, 'dist');
  const indexTsPath = path.join(srcDir, 'index.ts');

  let driftDetected = false;
  if (!fs.existsSync(distDir)) {
    driftDetected = true;
  } else {
    const srcStat = fs.statSync(srcDir);
    const distStat = fs.statSync(distDir);
    if (srcStat.mtimeMs > distStat.mtimeMs) driftDetected = true;
  }

  if (driftDetected) {
    metrics.drift++;
    process.stdout.write(chalk.yellow(`  🔍 [DRIFT] ${skillName.padEnd(40)}`));

    // 1. Context-Aware Patching (Legacy Yargs fix)
    if (fs.existsSync(indexTsPath)) {
      let content = fs.readFileSync(indexTsPath, 'utf8');
      const yargsLegacyPattern = /(?<!process)\.argv\b/g;
      if (yargsLegacyPattern.test(content) && !content.includes('.parseSync()')) {
        content = content.replace(yargsLegacyPattern, '.parseSync()');
        fs.writeFileSync(indexTsPath, content);
        metrics.patched++;
        process.stdout.write(chalk.blue(' [PATCHED]'));
      }
    }

    // 2. Atomic Rebuild
    try {
      execSync('npm run build', { cwd: skillPath, stdio: 'ignore', timeout: 60000 });
      metrics.fixed++;
      process.stdout.write(chalk.green(' [FIXED]\n'));
    } catch (err) {
      metrics.failed++;
      process.stdout.write(chalk.red(' [FAILED]\n'));
    }
  }
});

console.log(chalk.dim('━'.repeat(60)));
console.log(chalk.bold(`Sanitization Complete:`));
console.log(`- Total Skills Scanned : ${metrics.scanned}`);
console.log(`- Drifts Detected      : ${metrics.drift}`);
console.log(`- Auto-Patched         : ${metrics.patched}`);
console.log(`- Successfully Fixed   : ${metrics.fixed}`);

if (metrics.failed > 0) {
  console.log(chalk.red.bold(`- Critical Failures    : ${metrics.failed}`));
  console.log(chalk.dim('\n  (Recommendation: Run "npm install" in failed directories)'));
} else if (metrics.drift === 0) {
  console.log(chalk.green.bold('\n✨ All systems are healthy. No issues detected.'));
} else {
  console.log(chalk.green.bold('\n✅ System integrity restored. 100% Green.'));
}
console.log('');
