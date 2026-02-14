#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const chalk = require('chalk');

const rootDir = path.resolve(__dirname, '../..');
const portalDir = path.join(rootDir, 'tools/chronos-mirror');

function launch(mode = 'dev') {
  console.log(chalk.cyan(`\n\u23f3 Launching Chronos Mirror in ${mode} mode...`));
  console.log(chalk.dim(`    Directory: ${portalDir}\n`));

  const cmd = mode === 'build' ? 'npm run build' : 'npm run dev';

  try {
    // 依存関係のチェック
    if (!require('fs').existsSync(path.join(portalDir, 'node_modules'))) {
      console.log(chalk.yellow('    Installing dependencies first...'));
      execSync('npm install', { stdio: 'inherit', cwd: portalDir });
    }

    // Start Bridge Server in background
    const { spawn } = require('child_process');
    const bridgeScript = path.join(portalDir, 'bridge.cjs');
    console.log(chalk.yellow('    Starting Bridge Server...'));
    const bridgeProcess = spawn('node', [bridgeScript], { 
      detached: true, 
      stdio: 'inherit',
      cwd: portalDir
    });
    bridgeProcess.unref();

    execSync(cmd, { stdio: 'inherit', cwd: portalDir });
  } catch (err) {
    console.error(chalk.red(`Failed to launch portal: ${err.message}`));
  }
}

const args = process.argv.slice(2);
const mode = args.includes('--build') ? 'build' : 'dev';

launch(mode);
