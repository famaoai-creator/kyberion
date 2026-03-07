/**
 * scripts/mission_controller.ts
 * Advanced Mission Lifecycle Controller with Git Integration and Auto-Detection.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, pathResolver, safeWriteFile } from '@agent/core';

const ROOT_DIR = pathResolver.rootDir();
const REGISTRY_PATH = path.join(ROOT_DIR, 'active/missions/registry.json');
const MISSIONS_DIR = path.join(ROOT_DIR, 'active/missions');

interface Registry {
  last_updated: string;
  active_mission_id: string | null;
  missions: any[];
}

function getGitHash() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    return 'unknown';
  }
}

function getCurrentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    return 'unknown';
  }
}

function detectMissionId(): string | null {
  const branch = getCurrentBranch();
  if (branch.startsWith('mission/')) {
    return branch.replace('mission/', '').toUpperCase();
  }
  return null;
}

function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) return { last_updated: '', active_mission_id: null, missions: [] };
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function saveRegistry(registry: Registry) {
  registry.last_updated = new Date().toISOString();
  const content = JSON.stringify(registry, null, 2);
  fs.writeFileSync(REGISTRY_PATH, content);
  
  const mirrorPath = path.join(ROOT_DIR, 'presence/displays/chronos-mirror/public/mission_registry.json');
  if (fs.existsSync(path.dirname(mirrorPath))) {
    fs.writeFileSync(mirrorPath, content);
  }
}

import { validateFilePath, validateFileFreshness } from '../libs/core/validators.js';

// ... inside loadState or where applicable
function loadState(id: string) {
  const statePath = path.join(MISSIONS_DIR, id, 'mission-state.json');
  if (!fs.existsSync(statePath)) return null;
  
  try {
    // Enforce 1-hour freshness for active mission states
    validateFileFreshness(statePath, 60 * 60 * 1000);
  } catch (err: any) {
    if (err.message.includes('STALE_STATE_ERROR')) {
      logger.warn(`⚠️  CRITICAL: ${err.message}`);
      logger.warn(`To proceed, run 'mission_controller alignment ${id}' to verify current context.`);
    }
  }

  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveState(id: string, state: any) {
  const statePath = path.join(MISSIONS_DIR, id, 'mission-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function syncRegistry() {
  logger.info('🔄 Synchronizing Mission Registry...');
  const registry = loadRegistry();
  const folders = fs.readdirSync(MISSIONS_DIR).filter(f => fs.statSync(path.join(MISSIONS_DIR, f)).isDirectory());
  
  registry.missions = [];
  registry.active_mission_id = detectMissionId();
  
  for (const folder of folders) {
    const state = loadState(folder);
    if (state) {
      registry.missions.push({
        id: state.mission_id,
        status: state.status,
        priority: state.priority,
        persona: state.assigned_persona
      });
    }
  }
  
  saveRegistry(registry);
  logger.success('✅ Registry sync complete.');
}

async function startMission(id: string) {
  const state = loadState(id);
  if (!state) {
    logger.error(`Mission state ${id} not found.`);
    return;
  }
  const startHash = getGitHash();
  const branchName = `mission/${id.toLowerCase()}`;

  logger.info(`🛡️ Initializing mission branch: ${branchName}...`);
  try {
    execSync(`git checkout -b ${branchName}`, { stdio: 'inherit' });
    state.status = 'active';
    state.git = { branch: branchName, start_commit: startHash, latest_commit: startHash, checkpoints: [] };
    saveState(id, state);
    await syncRegistry();
    logger.success(`🚀 Mission ${id} is ACTIVE.`);
  } catch (err: any) {
    logger.error(`Activation failed: ${err.message}`);
  }
}

async function createCheckpoint(taskId: string, note: string, providedId?: string) {
  const missionId = providedId || detectMissionId();
  if (!missionId) {
    logger.error('No active mission detected from branch and no ID provided.');
    return;
  }

  const state = loadState(missionId);
  if (!state) {
    logger.error(`State for mission ${missionId} not found.`);
    return;
  }
  
  try {
    logger.info(`📸 Creating checkpoint for mission ${missionId}, task ${taskId}...`);
    execSync(`git add . && git commit -m "checkpoint(${missionId}): ${taskId} - ${note}"`, { stdio: 'inherit' });
    
    const newHash = getGitHash();
    state.git.latest_commit = newHash;
    state.git.checkpoints.push({ task_id: taskId, commit_hash: newHash, ts: new Date().toISOString() });
    saveState(missionId, state);
    logger.success(`✅ Checkpoint ${newHash} recorded.`);
  } catch (err: any) {
    logger.error(`Checkpoint failed: ${err.message}`);
  }
}

async function main() {
  const action = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];
  const arg3 = process.argv[5];

  switch (action) {
    case 'sync': await syncRegistry(); break;
    case 'activate': if (arg1) await startMission(arg1); break;
    case 'checkpoint': await createCheckpoint(arg1 || 'manual', arg2 || 'automated sync', arg3); break;
    case 'handoff': if (arg1 && arg2) await handoffMission(arg1, arg2, arg3); break;
    case 'exec': if (arg1) await executeWithRepair(arg1, arg2); break;
    default:
      console.log('Usage: npx tsx scripts/mission_controller.ts <action>');
      console.log('Actions:');
      console.log('  sync                             Sync registry with state files');
      console.log('  activate <id>                    Start mission branch and set to active');
      console.log('  checkpoint <task> [note] [id]    Commit and record checkpoint');
      console.log('  handoff <id> <persona> [note]    Handoff mission to another persona');
      console.log('  exec "<cmd>" [mission_id]        Execute command with auto-repair');
  }
}

async function executeWithRepair(command: string, missionId?: string) {
  const mid = missionId || process.env.MISSION_ID;
  const logFile = path.join(process.cwd(), 'scratch/last_execution.log');
  
  if (!fs.existsSync(path.dirname(logFile))) fs.mkdirSync(path.dirname(logFile), { recursive: true });

  logger.info(`⚡ Executing: ${command}`);
  
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    console.log(output);
    logger.success('✅ Command completed successfully.');
  } catch (err: any) {
    logger.error('❌ Command failed. Triggering Auto-Repair Loop...');
    
    const fullLog = `STDOUT:\n${err.stdout}\n\nSTDERR:\n${err.stderr}\n\nERROR:\n${err.message}`;
    fs.writeFileSync(logFile, fullLog);
    console.error(err.stderr);
    
    const repairCmd = `MISSION_ID=${mid || ''} npx tsx scripts/auto_repair.ts ${logFile}`;
    try {
      execSync(repairCmd, { stdio: 'inherit' });
    } catch (_) {
      logger.error('Failed to run auto-repair script.');
    }
    
    process.exit(1);
  }
}

async function handoffMission(missionId: string, nextPersona: string, note?: string) {
  const missionDir = pathResolver.missionDir(missionId);
  const statePath = path.join(missionDir, 'mission-state.json');
  
  if (!fs.existsSync(statePath)) {
    throw new Error(`Mission ${missionId} not found.`);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const prevPersona = state.assigned_persona;
  state.assigned_persona = nextPersona;
  state.status = 'paused'; // Pause during handoff
  
  state.history.push({
    ts: new Date().toISOString(),
    event: 'HANDOFF',
    note: `Handoff from ${prevPersona} to ${nextPersona}. ${note || ''}`
  });

  safeWriteFile(statePath, JSON.stringify(state, null, 2));
  logger.success(`🤝 Mission ${missionId} handed off to: ${nextPersona}`);
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
