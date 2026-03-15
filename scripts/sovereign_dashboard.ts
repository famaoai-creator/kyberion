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
        const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
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

function drawRuntimeSurfaces() {
  const statePath = pathResolver.shared('runtime/surfaces/state.json');
  const manifestPath = pathResolver.knowledge('public/governance/active-surfaces.json');

  console.log(chalk.bold.blue(' 🛰️ RUNTIME SURFACES'));

  if (!safeExistsSync(manifestPath)) {
    console.log(chalk.dim('  (Surface manifest not found)'));
    console.log('');
    return;
  }

  const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string) as {
    surfaces: Array<{ id: string; kind: string; startupMode?: string }>;
  };
  const state = safeExistsSync(statePath)
    ? JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string) as { surfaces: Record<string, { pid: number }> }
    : { surfaces: {} };

  for (const surface of manifest.surfaces) {
    const record = state.surfaces?.[surface.id];
    const status = record?.pid ? chalk.green('RUNNING') : chalk.dim('STOPPED');
    const pid = record?.pid ? chalk.gray(` pid=${record.pid}`) : '';
    console.log(`  ${chalk.gray('•')} ${surface.id.padEnd(20)} [${status}] ${chalk.dim(surface.kind)}${pid}`);
  }
  console.log('');
}

function drawTrustBoard() {
  const ledgerPath = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
  console.log(chalk.bold.green(' 🤝 AGENT TRUST BOARD'));
  if (safeExistsSync(ledgerPath)) {
    const raw = JSON.parse(safeReadFile(ledgerPath, { encoding: 'utf8' }) as string);
    const ledger = raw?.agents ?? raw ?? {};
    Object.keys(ledger).forEach(a => {
      const score = ledger[a].current_score / 100;
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
  drawRuntimeSurfaces();
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
