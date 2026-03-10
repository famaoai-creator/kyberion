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
  safeUnlinkSync,
  detectTier,
  ledger
} from '@agent/core';
import { validateFileFreshness } from '../libs/core/validators.js';

const ROOT_DIR = pathResolver.rootDir();
const REGISTRY_PATH = path.join(ROOT_DIR, 'active/missions/registry.json');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'active/archive/missions');

interface MissionState {
  mission_id: string;
  tier: 'personal' | 'confidential' | 'public';
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

  const tiers = [
    'knowledge/personal/missions', 
    'active/missions/confidential', 
    'active/missions/public'
  ];
  tiers.forEach(tier => {
    if (!safeExistsSync(path.join(ROOT_DIR, tier))) {
      logger.warn(`Creating missing tier directory: ${tier}`);
      safeMkdir(path.join(ROOT_DIR, tier), { recursive: true });
    }
  });

  if (!safeExistsSync(path.join(ROOT_DIR, 'node_modules'))) {
    throw new Error("Missing dependencies. Run 'pnpm install' first.");
  }
  
  logger.success('✅ Prerequisites satisfied.');
}

/**
 * 2. Tier & Git Utilities
 */
function calculateRequiredTier(injections: string[] = [], requestedTier?: string): 'personal' | 'confidential' | 'public' {
  const tierWeight: Record<string, number> = {
    'public': 1,
    'confidential': 3,
    'personal': 4
  };

  let maxWeight = requestedTier ? tierWeight[requestedTier] || 1 : 1;
  let currentTier: 'personal' | 'confidential' | 'public' = (requestedTier as any) || 'public';

  // Scan injections for highest tier
  for (const filePath of injections) {
    const tier = detectTier(filePath);
    if (tierWeight[tier] > (maxWeight || 0)) {
      maxWeight = tierWeight[tier];
      currentTier = tier as any;
    }
  }

  return currentTier;
}

function getGitHash(cwd: string = ROOT_DIR) {
  return safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim();
}

function initMissionRepo(missionDir: string) {
  if (!safeExistsSync(path.join(missionDir, '.git'))) {
    logger.info(`🌱 Initializing independent Git repo for mission at ${missionDir}...`);
    safeExec('git', ['init'], { cwd: missionDir });
    safeExec('git', ['config', 'user.name', 'Kyberion Sovereign Entity'], { cwd: missionDir });
    safeExec('git', ['config', 'user.email', 'sovereign@kyberion.local'], { cwd: missionDir });
    safeExec('git', ['add', '.'], { cwd: missionDir });
    safeExec('git', ['commit', '-m', 'chore: initial mission state'], { cwd: missionDir });
  }
}

function getCurrentBranch(cwd: string = ROOT_DIR) {
  try {
    return safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).trim();
  } catch (_) {
    return 'detached';
  }
}

/**
 * 3. State & Registry Management
 */
function loadState(id: string): MissionState | null {
  const missionPath = (pathResolver as any).findMissionPath(id);
  if (!missionPath) return null;
  const statePath = path.join(missionPath, 'mission-state.json');
  if (!safeExistsSync(statePath)) return null;
  try {
    const content = safeReadFile(statePath, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  } catch (_) { return null; }
}

function saveState(id: string, state: MissionState) {
  const missionDir = (pathResolver as any).findMissionPath(id) || (pathResolver as any).missionDir(id, state.tier);
  if (!safeExistsSync(missionDir)) safeMkdir(missionDir, { recursive: true });
  safeWriteFile(path.join(missionDir, 'mission-state.json'), JSON.stringify(state, null, 2));
}

/**
 * 4. Mission Commands
 */
async function createMission(id: string, tier: 'personal' | 'confidential' | 'public' = 'confidential', tenantId: string = 'default', missionType: string = 'development', visionRef?: string, persona: string = 'Ecosystem Architect') {
  const upperId = id.toUpperCase();
  const templatePath = path.join(ROOT_DIR, 'knowledge/public/governance/mission-templates.json');
  const templates = JSON.parse(safeReadFile(templatePath, { encoding: 'utf8' }) as string).templates;
  const template = templates.find((t: any) => t.name === missionType) || templates[0];

  // Auto-calculate tier based on template injections
  const finalTier = calculateRequiredTier(template.knowledge_injections || [], tier);
  const missionDir = (pathResolver as any).missionDir(upperId, finalTier);
  
  if (!safeExistsSync(missionDir)) safeMkdir(missionDir, { recursive: true });

  if (safeExistsSync(path.join(missionDir, 'mission-state.json'))) {
    logger.info(`Mission ${upperId} already exists at ${missionDir}.`);
    return;
  }

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

  // Create Evidence directory
  const evidenceDir = path.join(missionDir, 'evidence');
  if (!safeExistsSync(evidenceDir)) {
    safeMkdir(evidenceDir, { recursive: true });
    safeWriteFile(path.join(evidenceDir, '.gitkeep'), '');
    logger.info(`📁 [Architecture] Created evidence directory for mission ${upperId}.`);
  }

  // Initialize Micro-Repo
  initMissionRepo(missionDir);

  // Initial state with tier
  const missionGitHash = getGitHash(missionDir);

  // Initial state with tier
  const initialState: MissionState = {
    mission_id: upperId,
    tier: finalTier,
    status: 'planned',
    priority: 3,
    assigned_persona: persona,
    confidence_score: 1.0,
    git: {
      branch: 'main', // Missions always start on their own main branch
      start_commit: missionGitHash,
      latest_commit: missionGitHash,
      checkpoints: []
    },
    history: [{ ts: now, event: 'CREATE', note: `Mission created in ${finalTier} tier (Independent Micro-Repo).` }]
  };
  saveState(upperId, initialState);

  // Record to Hybrid Ledger
  ledger.record('MISSION_CREATE', {
    mission_id: upperId,
    tier: finalTier,
    type: missionType,
    persona: persona,
    owner: owner
  });

  logger.success(`🚀 Mission ${upperId} initialized in ${finalTier} tier from template "${template.name}" (ADF-driven).`);
}

async function startMission(id: string, tier: 'personal' | 'confidential' | 'public' = 'confidential', persona: string = 'Ecosystem Architect', tenantId: string = 'default', missionType: string = 'development', visionRef?: string) {
  checkPrerequisites();
  const upperId = id.toUpperCase();
  
  // Try to find existing mission first
  let state = loadState(upperId);
  const finalTier = state ? state.tier : tier; // Use existing tier if found, otherwise use requested
  
  logger.info(`🚀 Activating Mission: ${upperId} (Tier: ${finalTier})...`);
  
  try {
    if (!state) {
      await createMission(upperId, finalTier, tenantId, missionType, visionRef, persona);
      state = loadState(upperId);
    } else {
      state.status = 'active';
      state.history.push({ ts: new Date().toISOString(), event: 'RESUME', note: 'Mission resumed.' });
      saveState(upperId, state);
    }

    const missionDir = (pathResolver as any).findMissionPath(upperId);
    if (missionDir) {
      // Ensure it's a repo
      initMissionRepo(missionDir);
    }
    
    // Role Procedure Injection
    syncRoleProcedure(upperId, persona);

    // Record to Hybrid Ledger
    ledger.record('MISSION_ACTIVATE', {
      mission_id: upperId,
      branch: state?.git.branch || 'main',
      persona: persona
    });

    logger.success(`✅ Mission ${upperId} is now ACTIVE (Independent History).`);
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
  const targetDir = (pathResolver as any).findMissionPath(missionId);
  
  if (!targetDir) {
    logger.warn(`⚠️ [Governance] Mission directory not found for ${missionId}.`);
    return;
  }
  
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

  // Record to Hybrid Ledger before archival
  ledger.record('MISSION_FINISH', {
    mission_id: upperId,
    status: 'completed',
    archive_path: ARCHIVE_DIR
  });

  // 3. Purge Scratch
  const scratchDir = path.join(ROOT_DIR, 'scratch');
  if (safeExistsSync(scratchDir)) {
    logger.info('🧹 Purging scratch files...');
  }

  // 4. Archive
  if (!safeExistsSync(ARCHIVE_DIR)) safeMkdir(ARCHIVE_DIR, { recursive: true });
  const missionDir = (pathResolver as any).findMissionPath(upperId);
  if (!missionDir) return;
  
  const archivePath = path.join(ARCHIVE_DIR, upperId);
  
  if (safeExistsSync(archivePath)) safeExec('rm', ['-rf', archivePath]);
  // Use shell cp and rm to handle potential cross-device move if tier is in knowledge/
  safeExec('cp', ['-r', missionDir, archivePath]);
  safeExec('rm', ['-rf', missionDir]);
  
  logger.success(`📦 Mission ${upperId} archived and finalized.`);
}

async function createCheckpoint(taskId: string, note: string) {
  // Find current active mission by scanning tiers
  const configPath = path.join(ROOT_DIR, 'knowledge/public/governance/mission-management-config.json');
  let searchDirs = [path.join(ROOT_DIR, 'active/missions')];
  if (safeExistsSync(configPath)) {
    try {
      const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
      searchDirs = Object.values(config.directories || {}).map(d => path.join(ROOT_DIR, String(d)));
    } catch (_) {}
  }

  let activeMissionId: string | null = null;
  let missionPath: string | null = null;

  for (const dir of searchDirs) {
    if (!safeExistsSync(dir) || !fs.lstatSync(dir).isDirectory()) continue;
    const missions = safeReaddir(dir).filter(m => {
      try {
        return fs.lstatSync(path.join(dir, m)).isDirectory();
      } catch (_) { return false; }
    });
    for (const m of missions) {
      const state = loadState(m);
      if (state?.status === 'active') {
        activeMissionId = m;
        missionPath = path.join(dir, m);
        break;
      }
    }
    if (activeMissionId) break;
  }

  if (!activeMissionId || !missionPath) {
    logger.error('No active mission found. Checkpoint aborted.');
    return;
  }

  const state = loadState(activeMissionId);
  if (!state) return;

  logger.info(`📸 Checkpoint for ${activeMissionId}: ${taskId}...`);
  try {
    safeExec('git', ['add', '.'], { cwd: missionPath });
    safeExec('git', ['commit', '-m', `checkpoint(${activeMissionId}): ${taskId} - ${note}`], { cwd: missionPath });
    const hash = getGitHash(missionPath);
    state.git.latest_commit = hash;
    state.git.checkpoints.push({ task_id: taskId, commit_hash: hash, ts: new Date().toISOString() });
    saveState(activeMissionId, state);

    // Record to Hybrid Ledger
    ledger.record('MISSION_CHECKPOINT', {
      mission_id: activeMissionId,
      task_id: taskId,
      commit_hash: hash,
      note: note
    });

    logger.success(`✅ Recorded checkpoint ${hash} in mission repo.`);
  } catch (err: any) {
    logger.error(`Checkpoint failed: ${err.message}`);
  }
}

async function resumeMission(id?: string) {
  let targetId = id?.toUpperCase();
  
  if (!targetId) {
    // Scan all tiers for active mission
    const configPath = path.join(ROOT_DIR, 'knowledge/public/governance/mission-management-config.json');
    let searchDirs = [path.join(ROOT_DIR, 'active/missions')];
    if (safeExistsSync(configPath)) {
      try {
        const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
        searchDirs = Object.values(config.directories || {}).map(d => path.join(ROOT_DIR, String(d)));
      } catch (_) {}
    }

    for (const dir of searchDirs) {
      if (!safeExistsSync(dir) || !fs.lstatSync(dir).isDirectory()) continue;
      const missions = safeReaddir(dir).filter(m => {
        try {
          return fs.lstatSync(path.join(dir, m)).isDirectory();
        } catch (_) { return false; }
      });
      const active = missions.find(m => {
        const state = loadState(m);
        return state?.status === 'active';
      });
      if (active) {
        targetId = active;
        break;
      }
    }
    
    if (!targetId) {
      logger.warn('No active mission found to resume.');
      return;
    }
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
  const missionPath = (pathResolver as any).findMissionPath(targetId);
  const flightRecorderPath = path.join(missionPath!, 'LATEST_TASK.json');
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
  const missionDir = (pathResolver as any).findMissionPath(upperId);
  if (!missionDir) throw new Error(`Mission ${upperId} not found.`);

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
  
  // Need to scan all tiers
  const configPath = path.join(ROOT_DIR, 'knowledge/public/governance/mission-management-config.json');
  let searchDirs = [path.join(ROOT_DIR, 'active/missions')];
  if (safeExistsSync(configPath)) {
    try {
      const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
      searchDirs = Object.values(config.directories || {}).map(d => path.join(ROOT_DIR, String(d)));
    } catch (_) {}
  }

  for (const dir of searchDirs) {
    if (!safeExistsSync(dir)) continue;
    const missions = safeReaddir(dir).filter(m => {
      try {
        return fs.lstatSync(path.join(dir, m)).isDirectory();
      } catch (_) { return false; }
    });

    for (const mission of missions) {
      const missionDir = path.join(dir, mission);
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
          
          fs.cpSync(missionDir, targetPath, { recursive: true });
          fs.rmSync(missionDir, { recursive: true, force: true });
          break; // One policy per mission
        }
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
  const arg6 = process.argv[8];

  switch (action) {
    case 'create': await createMission(arg1, arg2 as any, arg3, arg4, arg5, arg6); break;
    case 'start': await startMission(arg1, arg2 as any, arg3, arg4, arg5, arg6); break;
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
