import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, pathResolver, safeExistsSync, safeReaddir, safeReadFile } from '../libs/core/index.js';
import chalk from 'chalk';

/**
 * Kyberion Sovereign Dashboard v1.0
 * Pure ANSI-based TUI for real-time ecosystem observability.
 */

const ROOT_DIR = pathResolver.rootDir();

function clearScreen() {
  process.stdout.write('\x1Bc');
}

function drawHeader() {
  console.log(chalk.bold.cyan(' 🌌 KYBERION SOVEREIGN ECOSYSTEM | CEO DASHBOARD v1.0 '));
  console.log(chalk.dim(' --------------------------------------------------- '));
  console.log(` Status: ${chalk.green('OPERATIONAL')} | User: ${chalk.bold('famao')} | Time: ${new Date().toLocaleTimeString()}\n`);
}

function drawMissions() {
  const missionDirs = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions')
  ];

  console.log(chalk.bold.yellow(' 📋 ACTIVE MISSIONS'));
  let count = 0;
  for (const dir of missionDirs) {
    if (!safeExistsSync(dir)) continue;
    const items = safeReaddir(dir);
    for (const item of items) {
      const statePath = path.join(dir, item, 'mission-state.json');
      if (safeExistsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.status === 'active') {
          const color = state.tier === 'personal' ? chalk.magenta : chalk.blue;
          console.log(`  ${chalk.gray('•')} ${color(state.mission_id.padEnd(25))} [${chalk.green('ACTIVE')}]`);
          count++;
        }
      }
    }
  }
  if (count === 0) console.log(chalk.dim('  (No active missions)'));
  console.log('');
}

function drawA2ATraffic() {
  const inbox = pathResolver.rootResolve('active/shared/runtime/a2a/inbox');
  const outbox = pathResolver.rootResolve('active/shared/runtime/a2a/outbox');
  
  console.log(chalk.bold.magenta(' 📡 A2A TRAFFIC'));
  
  const inCount = safeExistsSync(inbox) ? safeReaddir(inbox).length : 0;
  const outCount = safeExistsSync(outbox) ? safeReaddir(outbox).length : 0;

  console.log(`  Inbox:  ${inCount > 0 ? chalk.bold.green(inCount) : chalk.dim(0)} pending`);
  console.log(`  Outbox: ${outCount > 0 ? chalk.bold.yellow(outCount) : chalk.dim(0)} sending\n`);
}

function drawTrustBoard() {
  const ledgerPath = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
  console.log(chalk.bold.green(' 🤝 AGENT TRUST BOARD'));
  if (safeExistsSync(ledgerPath)) {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    Object.keys(ledger.agents).forEach(a => {
      const score = ledger.agents[a].current_score;
      const bar = '█'.repeat(Math.floor(score)) + '░'.repeat(10 - Math.floor(score));
      console.log(`  ${a.padEnd(15)} [${chalk.cyan(bar)}] ${score.toFixed(1)}`);
    });
  } else {
    console.log(chalk.dim('  (Trust ledger not found)'));
  }
  console.log('');
}

function render() {
  clearScreen();
  drawHeader();
  drawMissions();
  drawA2ATraffic();
  drawTrustBoard();
  console.log(chalk.dim(' Press Ctrl+C to exit. Refreshing every 5s...'));
}

if (process.argv.includes('--once')) {
  render();
} else {
  render();
  setInterval(render, 5000);
}
