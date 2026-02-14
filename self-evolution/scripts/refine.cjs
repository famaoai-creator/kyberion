#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { execSync } = require('child_process');
const { runAsyncSkill, createStandardYargs } = require('../../scripts/lib/skill-wrapper.cjs');
const pathResolver = require('../../scripts/lib/path-resolver.cjs');

const argv = createStandardYargs()
  .option('target', { alias: 't', type: 'string', default: 'GEMINI.md' })
  .option('reason', { alias: 'r', type: 'string', demandOption: true })
  .argv;

runAsyncSkill('self-evolution', async () => {
  const rootDir = path.resolve(__dirname, '../..');
  const targetFile = path.resolve(rootDir, argv.target);
  const backupDir = pathResolver.shared('archive/backups');

  if (!fs.existsSync(targetFile)) {
    throw new Error(`Target file ${argv.target} not found.`);
  }

  console.log(chalk.cyan(`\n\u2699\ufe0f  Self-Refinement triggered for: ${argv.target}`));
  console.log(chalk.dim(`    Reason: ${argv.reason}`));

  // 1. Mandatory Backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${argv.target}.${timestamp}.bak`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(targetFile, backupPath);
  console.log(chalk.green(`  \u2714 Backup created: ${path.relative(rootDir, backupPath)}`));

  // 2. Propose refinement via PR (Simulation of thinking)
  const branchName = `feat/self-refinement-${timestamp.substring(0, 10)}`;
  console.log(chalk.yellow(`\n\ud83d\udea7  Creating proposal branch: ${branchName}`));
  
  try {
    execSync(`git checkout -b ${branchName}`, { cwd: rootDir });
    // In a real scenario, the agent would use the 'replace' tool here to edit the target.
    // For now, we record the intent.
    const proposalMsg = `Self-Refinement: ${argv.reason}`;
    console.log(chalk.bold.magenta(`  \u2728 Draft PR ready for Lord's review: "${proposalMsg}"`));
  } catch (e) {
    console.error(chalk.red(`  [!] Failed to create branch: ${e.message}`));
  }

  return {
    target: argv.target,
    backup: backupPath,
    branch: branchName,
    reason: argv.reason
  };
});
