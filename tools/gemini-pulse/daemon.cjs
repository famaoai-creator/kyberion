#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chalk = require('chalk');
const chokidar = require('chokidar');
const pulseGuard = require('../../scripts/lib/pulse-guard.cjs');
const pathResolver = require('../../scripts/lib/path-resolver.cjs');

const rootDir = path.resolve(__dirname, '../..');
const tasksPath = path.join(rootDir, 'knowledge/operations/routine-tasks.json');
const registryPath = pathResolver.shared('tasks/parallel_registry.json');
const inboxDir = pathResolver.shared('queue/inbox');

/**
 * Gemini Pulse Daemon v2.1
 * Now with Mission Isolation via pathResolver.
 */

// 1. 定期実行チェック (1分ごと)
function checkRoutineTasks() {
  if (!fs.existsSync(tasksPath)) return;
  const { tasks } = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  const now = new Date();
  const currentHHmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  for (const task of tasks) {
    if (task.schedule === currentHHmm) {
      console.log(chalk.blue(`[Pulse] Scheduled Task Triggered: ${task.name}`));
      dispatchAgent('task', task.id);
    }
  }
}

// 2. 即時キュー監視
const watcher = chokidar.watch(inboxDir, {
  ignored: /(^|[\/\\])\../,
  persistent: true
});

watcher.on('add', (filePath) => {
  if (filePath.endsWith('.json')) {
    console.log(chalk.yellow(`\n\ud83d\udce9 [Pulse] New Message Detected: ${path.basename(filePath)}`));
    dispatchAgent('queue');
  }
});

// 3. エージェント Dispatcher
function dispatchAgent(type, skillId = null) {
  const missionId = `MSN-${Date.now().toString(36).toUpperCase()}`;
  const mDir = pathResolver.missionDir(missionId);
  const logFile = path.join(mDir, 'execution.log');
  const out = fs.openSync(logFile, 'a');

  // --- Scoped Execution Logic ---
  const scope = {
    allowedDirs: [mDir, path.join(rootDir, 'knowledge')],
    allowedSkills: skillId ? [skillId] : ['all']
  };
  const token = pulseGuard.createToken(missionId, scope);

  const script = type === 'queue' ? 'scripts/process_portal_queue.cjs' : 'scripts/cli.cjs';
  const args = type === 'queue' ? [script] : ['run', skillId, '--token', token];

  console.log(chalk.cyan(`  [Dispatcher] Launching ${type} handler (Mission: ${missionId})`));

  const agentProcess = spawn('node', args, {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', out, out]
  });

  agentProcess.unref();
}

console.log(chalk.bold.green(`\n\u2661 Gemini Pulse v2.0 active.`));
console.log(chalk.dim(`    Watching: ${inboxDir}`));
console.log(chalk.dim(`    Heartbeat: 60s intervals\n`));

setInterval(checkRoutineTasks, 60000);
