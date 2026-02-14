#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { fileUtils, ui, logger } = require('./lib/core.cjs');

const rootDir = path.resolve(__dirname, '..');
const tasksDefPath = path.join(rootDir, 'knowledge/operations/routine-tasks.json');
const statusPath = path.join(rootDir, 'work/tasks/status.json');

function loadTasks() {
  if (!fs.existsSync(tasksDefPath)) return { tasks: [] };
  return JSON.parse(fs.readFileSync(tasksDefPath, 'utf8'));
}

function saveTasks(data) {
  fs.writeFileSync(tasksDefPath, JSON.stringify(data, null, 2));
}

async function getPendingTasks(currentRole) {
  const def = loadTasks();
  const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : {};
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentHHmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  return def.tasks.filter(t => {
    // 1. Role Check
    const roleMatch = t.required_role === 'all' || t.required_role === currentRole;
    if (!roleMatch) return false;

    // 2. Done Check
    const lastDone = status[t.id] || '';
    if (lastDone === today) return false;

    // 3. Time Schedule Check (HH:mm)
    if (t.schedule && t.schedule !== 'anytime') {
      if (currentHHmm < t.schedule) return false; // Still too early
    }

    return true;
  });
}

async function runTask(task) {
  console.log(chalk.cyan(`\n\u25b6 Executing Task: ${chalk.bold(task.name)}`));
  console.log(chalk.dim(`  Description: ${task.description}`));

  if (task.id === 'clock-in') {
    logger.success(`Clocked in at ${new Date().toLocaleTimeString()}`);
  } else if (task.id === 'clock-out') {
    logger.success(`Clocked out at ${new Date().toLocaleTimeString()}. Great work!`);
  } else if (task.id === 'integrity-check') {
    const { execSync } = require('child_process');
    try { execSync('node scripts/check_knowledge_integrity.cjs', { stdio: 'inherit', cwd: rootDir }); } catch (e) {}
  } else {
    console.log(chalk.dim('  (Executing generic logic...)'));
  }

  const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : {};
  status[task.id] = new Date().toISOString().split('T')[0];
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
  console.log(chalk.green(`\u2714 Task "${task.name}" completed.\n`));
}

async function listAllTasks() {
  const def = loadTasks();
  console.log(chalk.bold('\n--- Registered Routine Tasks ---'));
  def.tasks.forEach(t => {
    const layerColor = t.layer === 'Base' ? chalk.magenta : chalk.blue;
    console.log(`${chalk.cyan(t.id.padEnd(20))} | ${layerColor(t.layer.padEnd(6))} | ${t.name.padEnd(20)} | Role: ${t.required_role}`);
  });
  console.log('');
}

async function addTask() {
  console.log(chalk.bold('\n--- Add New Routine Task ---'));
  const id = await ui.ask('Enter Task ID (e.g. daily-report): ');
  const name = await ui.ask('Enter Task Name: ');
  const layer = (await ui.confirm('Is this a Base layer task (vs Role layer)?')) ? 'Base' : 'Role';
  const description = await ui.ask('Description: ');
  const role = layer === 'Base' ? 'all' : await ui.ask('Required Role (e.g. CEO): ');
  const frequency = await ui.ask('Frequency (daily/weekly): ') || 'daily';
  const schedule = await ui.ask('Schedule (anytime or HH:mm): ') || 'anytime';

  const def = loadTasks();
  if (def.tasks.find(t => t.id === id)) {
    logger.error(`Task with ID "${id}" already exists.`);
    return;
  }

  def.tasks.push({ id, name, layer, frequency, schedule, description, required_role: role });
  saveTasks(def);
  logger.success(`Task "${id}" added.`);
}

async function updateTask(id) {
  const def = loadTasks();
  const task = def.tasks.find(t => t.id === id);
  if (!task) {
    logger.error(`Task "${id}" not found.`);
    return;
  }

  console.log(chalk.bold(`\n--- Updating Task: ${id} ---`));
  task.name = await ui.ask(`Name [${task.name}]: `) || task.name;
  task.description = await ui.ask(`Description [${task.description}]: `) || task.description;
  task.required_role = await ui.ask(`Role [${task.required_role}]: `) || task.required_role;
  task.schedule = await ui.ask(`Schedule [${task.schedule || 'anytime'}]: `) || task.schedule;

  saveTasks(def);
  logger.success(`Task "${id}" updated.`);
}

function showHelp() {
  console.log(`
${chalk.bold('Task Manager CLI')}
  node scripts/task_manager.cjs [command] [options]

${chalk.bold('COMMANDS:')}
  (none)         List and run pending tasks for today
  list           List all registered tasks
  add            Add a new routine task interactively
  update <id>    Update an existing task
  remove <id>    Delete a task
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'list': await listAllTasks(); break;
    case 'add': await addTask(); break;
    case 'update': await updateTask(args[1]); break;
    case 'remove': await removeTask(args[1]); break;
    case '--help':
    case '-h': showHelp(); break;
    default:
      if (command && !command.startsWith('-')) {
        logger.error(`Unknown command: ${command}`);
        showHelp();
      } else {
        const role = fileUtils.getCurrentRole();
        const pending = await getPendingTasks(role);
        if (pending.length === 0) {
          console.log(chalk.dim('No pending routine tasks for today.'));
          return;
        }
        console.log(chalk.bold(`\nPending Tasks for ${chalk.yellow(role)}:`));
        pending.forEach(t => console.log(`  ${t.layer === 'Base' ? chalk.magenta(`[${t.layer}]`) : chalk.blue(`[${t.layer}]`)} ${t.name}`));
        if (await ui.confirm('Process tasks now?')) {
          for (const t of pending) {
            if (await ui.confirm(`Run "${t.name}"?`)) await runTask(t);
          }
        }
      }
  }
}

if (require.main === module) {
  main().catch(err => logger.error(err.message));
}

module.exports = { getPendingTasks, runTask };
