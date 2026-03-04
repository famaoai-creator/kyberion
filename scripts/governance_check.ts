import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { safeWriteFile } from '@agent/core';

interface GovernanceResult {
  name: string;
  status: 'passed' | 'failed';
  duration?: string;
  violations?: string[];
  error?: string;
  regressions?: any[];
  efficiency_alerts?: any[];
}

async function runStep(name: string, command: string): Promise<GovernanceResult> {
  process.stdout.write(chalk.cyan(`[Governance] Running ${name}... `));
  const start = Date.now();
  try {
    execSync(command, { stdio: 'ignore', cwd: process.cwd() });
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(chalk.green(`PASSED (${duration}s)`));
    return { name, status: 'passed', duration };
  } catch (err: any) {
    console.log(chalk.red('FAILED'));
    return { name, status: 'failed', error: err.message };
  }
}

async function runStaticAudit(): Promise<GovernanceResult> {
  process.stdout.write(chalk.cyan(`[Governance] Running Static API Audit... `));
  const start = Date.now();
  const violations: string[] = [];
  const rootDir = process.cwd();

  const RESTRICTED = [
    'fs.' + 'writeFileSync',
    'fs.' + 'appendFileSync',
    'fs.' + 'unlinkSync',
    'fs.' + 'renameSync',
  ];
  const EXEMPTIONS = [
    'scripts/bootstrap.ts',
    'scripts/setup_ecosystem.sh',
    'scripts/fix_shebangs.ts',
    'scripts/mass_refactor_governance.ts',
  ];

  // 1. Audit Skills (src/ and scripts/)
  const skillRoot = path.join(rootDir, 'skills');
  if (fs.existsSync(skillRoot)) {
    const categories = fs.readdirSync(skillRoot).filter(f => fs.lstatSync(path.join(skillRoot, f)).isDirectory());
    for (const cat of categories) {
      const catPath = path.join(skillRoot, cat);
      const skillDirs = fs.readdirSync(catPath).filter(f => fs.lstatSync(path.join(catPath, f)).isDirectory());
      
      for (const skillDir of skillDirs) {
        const fullSkillPath = path.join(catPath, skillDir);
        const searchDirs = ['scripts', 'src'];
        
        for (const sDir of searchDirs) {
          const targetPath = path.join(fullSkillPath, sDir);
          if (!fs.existsSync(targetPath)) continue;

          const files = fs.readdirSync(targetPath, { recursive: true } as any)
            .filter((f: any) => f.endsWith('.cjs') || f.endsWith('.js') || f.endsWith('.ts'))
            .filter((f: any) => !f.endsWith('.test.ts'));

          for (const file of files as string[]) {
            const content = fs.readFileSync(path.join(targetPath, file), 'utf8');
            RESTRICTED.forEach((api) => {
              if (content.includes(api)) {
                violations.push(`skills/${cat}/${skillDir}/${sDir}/${file}: uses restricted API '${api}'`);
              }
            });
          }
        }
      }
    }
  }

  // 2. Audit Core Scripts
  const coreScriptsPath = path.join(rootDir, 'scripts');
  if (fs.existsSync(coreScriptsPath)) {
    const coreFiles = fs.readdirSync(coreScriptsPath)
      .filter((f) => f.endsWith('.cjs') || f.endsWith('.js') || f.endsWith('.ts'));
    
    for (const file of coreFiles) {
      const relPath = `scripts/${file}`;
      if (EXEMPTIONS.includes(relPath)) continue;

      const content = fs.readFileSync(path.join(coreScriptsPath, file), 'utf8');
      RESTRICTED.forEach((api) => {
        if (content.includes(api)) {
          violations.push(`${relPath}: uses restricted API '${api}'`);
        }
      });
    }
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  if (violations.length > 0) {
    console.log(chalk.red(`FAILED (${violations.length} violations)`));
    violations.forEach((v) => console.log(chalk.dim(`  - ${v}`)));
    return { name: 'Static API Audit', status: 'failed', violations, duration };
  } else {
    console.log(chalk.green(`PASSED (${duration}s)`));
    return { name: 'Static API Audit', status: 'passed', duration };
  }
}

async function main() {
  const _argv = yargs(hideBin(process.argv))
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      default: false,
      describe: 'Show detailed audit info',
    })
    .help('help')
    .alias('h', 'help').parseSync();

  console.log(chalk.bold('\n=== Gemini Ecosystem Governance Check ===\n'));

  const results: GovernanceResult[] = [];
  results.push(await runStaticAudit());
  results.push(await runStep('Static Analysis (Lint)', 'npm run lint'));
  results.push(await runStep('Type Check', 'npm run typecheck'));
  results.push(await runStep('Unit Tests', 'npm run test:unit'));
  
  // Use the new TS health checker if it exists in dist, otherwise fallback to CJS
  const healthCheckCmd = fs.existsSync('dist/scripts/check_skills_health.js') 
    ? 'node dist/scripts/check_skills_health.js --fix'
    : 'node dist/scripts/check_skills_health.js';
  results.push(await runStep('Ecosystem Health', healthCheckCmd));

  const perfResult = await runStep(
    'Performance Regression',
    'node dist/scripts/check_performance.js --fail-on-regression'
  );

  const perfDir = path.resolve(process.cwd(), 'evidence/performance');
  if (fs.existsSync(perfDir)) {
    const perfFiles = fs.readdirSync(perfDir).filter((f) => f.endsWith('.json')).sort();
    if (perfFiles.length > 0) {
      try {
        const latestPerf = JSON.parse(fs.readFileSync(path.join(perfDir, perfFiles[perfFiles.length - 1]), 'utf8'));
        perfResult.regressions = latestPerf.regressions || [];
        perfResult.efficiency_alerts = latestPerf.efficiency_alerts || [];
      } catch (_) {}
    }
  }
  results.push(perfResult);

  const failed = results.filter((r) => r.status === 'failed');

  console.log('\n' + chalk.bold('--- Governance Summary ---'));
  results.forEach((r) => {
    const icon = r.status === 'passed' ? '✅' : '❌';
    console.log(`${icon} ${r.name.padEnd(25)} : ${r.status.toUpperCase()}`);
  });

  const reportPath = path.resolve(process.cwd(), 'active/shared/governance-report.json');
  const reportData = {
    timestamp: new Date().toISOString(),
    overall_status: failed.length === 0 ? 'compliant' : 'non-compliant',
    results,
  };

  safeWriteFile(reportPath, JSON.stringify(reportData, null, 2));

  if (failed.length > 0) {
    console.log(chalk.red(`\n[!] Governance check failed with ${failed.length} issues.`));
    process.exit(1);
  } else {
    console.log(chalk.green('\n[SUCCESS] Ecosystem is fully compliant with all quality gates.'));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
