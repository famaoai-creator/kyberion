#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

/**
 * Global Governance Check Tool
 * Orchestrates all quality gates: Lint, Unit Tests, Health Check, and Performance.
 */

async function runStep(name, command) {
  process.stdout.write(chalk.cyan(`[Governance] Running ${name}... `));
  const start = Date.now();
  try {
    execSync(command, { stdio: 'ignore', cwd: path.resolve(__dirname, '..') });
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(chalk.green(`PASSED (${duration}s)`));
    return { name, status: 'passed', duration };
  } catch (err) {
    console.log(chalk.red('FAILED'));
    return { name, status: 'failed', error: err.message };
  }
}

async function runStaticAudit() {
  process.stdout.write(chalk.cyan(`[Governance] Running Static API Audit... `));
  const start = Date.now();
  const violations = [];
  const rootDir = path.resolve(__dirname, '..');

  // Restricted APIs that bypass Sovereign Shield
  const RESTRICTED = ['fs.writeFileSync', 'fs.appendFileSync', 'fs.unlinkSync', 'fs.renameSync'];

  // Foundational scripts that are allowed to use raw APIs
  const EXEMPTIONS = [
    'scripts/bootstrap.cjs',
    'scripts/setup_ecosystem.sh',
    'scripts/lib/secure-io.cjs',
    'scripts/fix_shebangs.cjs',
    'scripts/mass_refactor_governance.cjs',
  ];

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const skillDirs = entries.filter(
    (e) =>
      e.isDirectory() &&
      !e.name.startsWith('.') &&
      !['node_modules', 'scripts', 'knowledge', 'work', 'templates'].includes(e.name)
  );

  // 1. Audit Skills
  for (const dir of skillDirs) {
    const scriptsPath = path.join(rootDir, dir.name, 'scripts');
    if (!fs.existsSync(scriptsPath)) continue;

    const files = fs
      .readdirSync(scriptsPath)
      .filter((f) => f.endsWith('.cjs') || f.endsWith('.js'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(scriptsPath, file), 'utf8');
      RESTRICTED.forEach((api) => {
        if (content.includes(api)) {
          violations.push(`${dir.name}/${file}: uses restricted API '${api}'`);
        }
      });
    }
  }

  // 2. Audit Core Scripts (respecting exemptions)
  const coreScriptsPath = path.join(rootDir, 'scripts');
  const coreFiles = fs
    .readdirSync(coreScriptsPath)
    .filter((f) => f.endsWith('.cjs') || f.endsWith('.js'));
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
  const _argv = require('yargs/yargs')(process.argv.slice(2))
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      default: false,
      describe: 'Show detailed audit info',
    })
    .help('help')
    .alias('h', 'help').argv;

  console.log(chalk.bold('\n=== Gemini Ecosystem Governance Check ===\n'));

  const results = [];
  results.push(await runStaticAudit());
  results.push(await runStep('Static Analysis (Lint)', 'npm run lint'));
  results.push(await runStep('Type Check', 'npm run typecheck'));
  results.push(await runStep('Unit Tests', 'npm run test:unit'));
  results.push(await runStep('Ecosystem Health', 'node scripts/check_skills_health.cjs'));

  const perfResult = await runStep(
    'Performance Regression',
    'node scripts/check_performance.cjs --fail-on-regression'
  );

  // Enrich performance result with trend data if available
  const perfDir = path.resolve(__dirname, '../evidence/performance');
  if (fs.existsSync(perfDir)) {
    const perfFiles = fs
      .readdirSync(perfDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    if (perfFiles.length > 0) {
      const latestPerf = JSON.parse(
        fs.readFileSync(path.join(perfDir, perfFiles[perfFiles.length - 1]), 'utf8')
      );
      perfResult.regressions = latestPerf.regressions || [];
      perfResult.efficiency_alerts = latestPerf.efficiency_alerts || [];
    }
  }
  results.push(perfResult);

  const failed = results.filter((r) => r.status === 'failed');

  console.log('\n' + chalk.bold('--- Governance Summary ---'));
  results.forEach((r) => {
    const icon = r.status === 'passed' ? '✅' : '❌';
    console.log(`${icon} ${r.name.padEnd(25)} : ${r.status.toUpperCase()}`);
  });

  const reportPath = path.resolve(__dirname, '../work/governance-report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        overall_status: failed.length === 0 ? 'compliant' : 'non-compliant',
        results,
      },
      null,
      2
    )
  );

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
