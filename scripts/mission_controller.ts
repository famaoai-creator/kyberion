/**
 * scripts/mission_controller.ts
 * Kyberion Sovereign Mission Controller (KSMC) v2.0
 * [SECURE-IO COMPLIANT]
 * 
 * Objectives:
 * 1. Transactional Integrity (Git Branching & Checkpoints)
 * 2. Prerequisite Enforcement (Identity, Tiers, Build)
 * 3. Lifecycle Governance (Start, Alignment, Checkpoint, Finish, Archive)
 * 4. Role & Confidence Awareness (ACE Engine Integration)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { 
  logger, 
  pathResolver, 
  safeWriteFile, 
  safeReadFile, 
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync
} from '@agent/core';
import { validateFileFreshness } from '../libs/core/validators.js';

const ROOT_DIR = pathResolver.rootDir();
const REGISTRY_PATH = path.join(ROOT_DIR, 'active/missions/registry.json');
const MISSIONS_DIR = path.join(ROOT_DIR, 'active/missions');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'active/archive/missions');

interface MissionState {
  mission_id: string;
  status: 'planned' | 'active' | 'paused' | 'completed';
  priority: number;
  assigned_persona: string;
  confidence_score: number;
  git: {
    branch: string;
    start_commit: string;
    latest_commit: string;
    checkpoints: Array<{ task_id: string; commit_hash: string; ts: string }>;
  };
  history: Array<{ ts: string; event: string; note: string }>;
}

/**
 * 1. Prerequisite Validation (The Immune System)
 */
function checkPrerequisites() {
  logger.info('🛡️ Validating Sovereign Prerequisites...');
  
  const identityPath = path.join(ROOT_DIR, 'knowledge/personal/my-identity.json');
  if (!safeExistsSync(identityPath)) {
    throw new Error('CRITICAL: Sovereign Identity missing. Please run "pnpm onboard" first to establish your identity.');
  }

  const tiers = ['knowledge/personal', 'knowledge/confidential', 'knowledge/public'];
  tiers.forEach(tier => {
    if (!safeExistsSync(path.join(ROOT_DIR, tier))) {
      logger.warn(`Creating missing tier: ${tier}`);
      safeMkdir(path.join(ROOT_DIR, tier), { recursive: true });
    }
  });

  if (!safeExistsSync(path.join(ROOT_DIR, 'node_modules'))) {
    throw new Error("Missing dependencies. Run 'pnpm install' first.");
  }
  
  logger.success('✅ Prerequisites satisfied.');
}

/**
 * 2. Git Utilities
 */
function getGitHash() {
  return safeExec('git', ['rev-parse', 'HEAD']).trim();
}

function getCurrentBranch() {
  return safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/**
 * 3. State & Registry Management
 */
function loadState(id: string): MissionState | null {
  const statePath = path.join(MISSIONS_DIR, id, 'mission-state.json');
  if (!safeExistsSync(statePath)) return null;
  try {
    const content = safeReadFile(statePath, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  } catch (_) { return null; }
}

function saveState(id: string, state: MissionState) {
  const missionDir = path.join(MISSIONS_DIR, id);
  if (!safeExistsSync(missionDir)) safeMkdir(missionDir, { recursive: true });
  safeWriteFile(path.join(missionDir, 'mission-state.json'), JSON.stringify(state, null, 2));
}

/**
 * 4. Mission Commands
 */
async function createMission(id: string, tenantId: string = 'default', missionType: string = 'development', visionRef?: string, persona: string = 'Ecosystem Architect') {
  const upperId = id.toUpperCase();
  const missionDir = pathResolver.missionDir(upperId);
  const templatePath = path.join(ROOT_DIR, 'knowledge/public/governance/mission-templates.json');
  
  if (!safeExistsSync(missionDir)) safeMkdir(missionDir, { recursive: true });

  if (safeExistsSync(path.join(missionDir, 'mission-state.json'))) {
    logger.info(`Mission ${upperId} already exists.`);
    return;
  }

  const templates = JSON.parse(safeReadFile(templatePath, { encoding: 'utf8' }) as string).templates;
  const template = templates.find((t: any) => t.name === missionType) || templates[0];

  const gitBranch = getCurrentBranch();
  const gitHash = getGitHash();
  const now = new Date().toISOString();
  const owner = process.env.USER || 'famao';
  const resolvedVision = visionRef || '/knowledge/personal/my-vision.md';

  for (const file of template.files) {
    let content = file.content_template
      .replace(/{MISSION_ID}/g, upperId)
      .replace(/{TENANT_ID}/g, tenantId)
      .replace(/{TYPE}/g, missionType)
      .replace(/{VISION_REF}/g, resolvedVision)
      .replace(/{PERSONA}/g, persona)
      .replace(/{OWNER}/g, owner)
      .replace(/{BRANCH}/g, gitBranch)
      .replace(/{HASH}/g, gitHash)
      .replace(/{NOW}/g, now);
    
    safeWriteFile(path.join(missionDir, file.path), content);
  }

  logger.success(`🚀 Mission ${upperId} initialized from template "${template.name}" (ADF-driven).`);
}

async function startMission(id: string, persona: string = 'Ecosystem Architect', tenantId: string = 'default', missionType: string = 'development', visionRef?: string) {
  checkPrerequisites();
  const upperId = id.toUpperCase();
  const branchName = `mission/${id.toLowerCase()}`;
  
  logger.info(`🚀 Activating Mission: ${upperId}...`);
  
  try {
    // Branching logic
    const currentBranch = getCurrentBranch();
    if (currentBranch !== branchName) {
      try {
        safeExec('git', ['checkout', '-b', branchName]);
      } catch {
        safeExec('git', ['checkout', branchName]);
      }
    }

    let state = loadState(upperId);
    if (!state) {
      await createMission(upperId, tenantId, missionType, visionRef, persona);
      state = loadState(upperId);
    } else {
      state.status = 'active';
      state.history.push({ ts: new Date().toISOString(), event: 'RESUME', note: 'Mission resumed.' });
      saveState(upperId, state);
    }

    if (state) {
      state.status = 'active';
      saveState(upperId, state);
    }
    
    // Role Procedure Injection
    syncRoleProcedure(upperId, persona);

    logger.success(`✅ Mission ${upperId} is now ACTIVE on branch ${branchName}.`);
  } catch (err: any) {
    logger.error(`Failed to start mission: ${err.message}`);
  }
}

/**
 * Synchronizes the role-specific procedure to the active mission directory.
 */
function syncRoleProcedure(missionId: string, persona: string) {
  const roleSlug = persona.toLowerCase().replace(/\s+/g, '_');
  const sourcePath = path.join(ROOT_DIR, 'knowledge/roles', roleSlug, 'PROCEDURE.md');
  const targetDir = path.join(MISSIONS_DIR, missionId);
  const targetPath = path.join(targetDir, 'ROLE_PROCEDURE.md');

  if (safeExistsSync(sourcePath)) {
    const procedure = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
    safeWriteFile(targetPath, procedure);
    logger.info(`📋 [Governance] Mirrored procedure for role "${persona}" to mission context.`);
  } else {
    logger.warn(`⚠️ [Governance] No specific procedure found for role "${persona}" at ${sourcePath}. Using default.`);
  }
}

async function finishMission(id: string) {
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);

  logger.info(`🏁 Finishing Mission: ${upperId}...`);

  // 1. Commit final changes
  try {
    safeExec('git', ['add', '.']);
    safeExec('git', ['commit', '-m', `feat: complete mission ${upperId}`]);
    state.git.latest_commit = getGitHash();
  } catch (_) { logger.info('No changes to commit.'); }

  // 2. Update state
  state.status = 'completed';
  state.history.push({ ts: new Date().toISOString(), event: 'FINISH', note: 'Mission completed.' });
  saveState(upperId, state);

  // 3. Purge Scratch
  const scratchDir = path.join(ROOT_DIR, 'scratch');
  if (safeExistsSync(scratchDir)) {
    logger.info('🧹 Purging scratch files...');
  }

  // 4. Archive
  if (!safeExistsSync(ARCHIVE_DIR)) safeMkdir(ARCHIVE_DIR, { recursive: true });
  const missionDir = path.join(MISSIONS_DIR, upperId);
  const archivePath = path.join(ARCHIVE_DIR, upperId);
  
  if (safeExistsSync(archivePath)) safeExec('rm', ['-rf', archivePath]);
  safeExec('mv', [missionDir, archivePath]);
  
  logger.success(`📦 Mission ${upperId} archived and finalized.`);
}

async function createCheckpoint(taskId: string, note: string) {
  const branch = getCurrentBranch();
  if (!branch.startsWith('mission/')) {
    logger.error('Not on a mission branch. Checkpoint aborted.');
    return;
  }
  const id = branch.replace('mission/', '').toUpperCase();
  const state = loadState(id);
  if (!state) return;

  logger.info(`📸 Checkpoint: ${taskId}...`);
  try {
    safeExec('git', ['add', '.']);
    safeExec('git', ['commit', '-m', `checkpoint(${id}): ${taskId} - ${note}`]);
    const hash = getGitHash();
    state.git.latest_commit = hash;
    state.git.checkpoints.push({ task_id: taskId, commit_hash: hash, ts: new Date().toISOString() });
    saveState(id, state);
    logger.success(`✅ Recorded checkpoint ${hash}`);
  } catch (err: any) {
    logger.error(`Checkpoint failed: ${err.message}`);
  }
}

async function resumeMission(id?: string) {
  let targetId = id?.toUpperCase();
  
  if (!targetId) {
    // Auto-detect active mission from registry or directory
    if (!safeExistsSync(MISSIONS_DIR)) return;
    const missions = safeReaddir(MISSIONS_DIR);
    const active = missions.find(m => {
      const state = loadState(m);
      return state?.status === 'active';
    });
    if (!active) {
      logger.warn('No active mission found to resume.');
      return;
    }
    targetId = active;
  }

  const state = loadState(targetId);
  if (!state) throw new Error(`Mission ${targetId} not found.`);

  logger.info(`🔄 Resuming Mission: ${targetId}...`);
  
  // 1. Checkout to the correct branch
  const currentBranch = getCurrentBranch();
  if (currentBranch !== state.git.branch) {
    safeExec('git', ['checkout', state.git.branch]);
  }

  // 2. Check Flight Recorder for unfinished business
  const flightRecorderPath = path.join(MISSIONS_DIR, targetId, 'LATEST_TASK.json');
  if (safeExistsSync(flightRecorderPath)) {
    const content = safeReadFile(flightRecorderPath, { encoding: 'utf8' }) as string;
    const task = JSON.parse(content);
    logger.warn(`📍 FLIGHT RECORDER DETECTED: Last intended task was: ${task.description}`);
    logger.info('Please verify the physical state and continue from this point.');
  }

  state.history.push({ ts: new Date().toISOString(), event: 'RESUME', note: 'Session re-established.' });
  saveState(targetId, state);
  logger.success(`✅ Mission ${targetId} is back in focus.`);
}

async function recordTask(missionId: string, description: string, details: any = {}) {
  const upperId = missionId.toUpperCase();
  const missionDir = path.join(MISSIONS_DIR, upperId);
  if (!safeExistsSync(missionDir)) throw new Error(`Mission ${upperId} not found.`);

  const flightRecorderPath = path.join(missionDir, 'LATEST_TASK.json');
  const taskData = {
    ts: new Date().toISOString(),
    description,
    details
  };
  
  safeWriteFile(flightRecorderPath, JSON.stringify(taskData, null, 2));
  logger.info(`📝 [FlightRecorder] Intention recorded: ${description}`);
}

async function purgeMissions() {
  const adfPath = path.join(ROOT_DIR, 'knowledge/governance/mission-lifecycle.json');
  if (!safeExistsSync(adfPath)) {
    logger.error('Mission lifecycle ADF not found.');
    return;
  }

  const adf = JSON.parse(safeReadFile(adfPath, { encoding: 'utf8' }) as string);
  const missions = safeReaddir(MISSIONS_DIR).filter(m => fs.lstatSync(path.join(MISSIONS_DIR, m)).isDirectory());

  for (const mission of missions) {
    const missionDir = path.join(MISSIONS_DIR, mission);
    for (const policy of adf.policies) {
      let match = false;
      const { condition } = policy;

      if (condition.has_file) {
        if (safeExistsSync(path.join(missionDir, condition.has_file))) {
          match = true;
        }
      } else if (condition.max_age_days) {
        const stat = fs.statSync(missionDir);
        const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
        if (ageDays > condition.max_age_days) {
          match = true;
        }
      }

      if (match) {
        let targetPath = policy.target_dir;
        const now = new Date();
        targetPath = targetPath.replace('{YYYY-MM}', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
        targetPath = path.join(ROOT_DIR, targetPath, policy.naming_pattern.replace('{mission_id}', mission));

        logger.info(`Archiving mission ${mission} to ${targetPath} (Policy: ${policy.name})`);
        if (!safeExistsSync(path.dirname(targetPath))) {
          safeMkdir(path.dirname(targetPath), { recursive: true });
        }
        
        // Use cpSync and rmSync for directory move as safeExec mv might be cleaner but let's stick to Node if it's simpler
        fs.cpSync(missionDir, targetPath, { recursive: true });
        fs.rmSync(missionDir, { recursive: true, force: true });
        break; // One policy per mission
      }
    }
  }
}

/**
 * 5. Main Entry
 */
async function main() {
  const action = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];
  const arg3 = process.argv[5];
  const arg4 = process.argv[6];
  const arg5 = process.argv[7];

  switch (action) {
    case 'create': await createMission(arg1, arg2, arg3, arg4, arg5); break;
    case 'start': await startMission(arg1, arg2, arg3, arg4, arg5); break;
    case 'checkpoint': await createCheckpoint(arg1 || 'manual', arg2 || 'progress update'); break;
    case 'finish': await finishMission(arg1); break;
    case 'resume': await resumeMission(arg1); break;
    case 'record-task': await recordTask(arg1, arg2, JSON.parse(process.argv[5] || '{}')); break;
    case 'purge': await purgeMissions(); break;
    case 'sync': 
        logger.info('Syncing mission registry...');
        // logic for registry sync
        break;
    default:
      console.log('Usage: ts-node scripts/mission_controller.ts <create|start|checkpoint|finish|resume|record-task|purge|sync> <args>');
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
