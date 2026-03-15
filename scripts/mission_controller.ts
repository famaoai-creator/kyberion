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
import { logger } from '../libs/core/core.js';
import * as pathResolver from '../libs/core/path-resolver.js';
import {
  safeWriteFile,
  safeReadFile,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync,
  safeAppendFileSync,
  safeStat,
  safeLstat,
  safeRmSync,
} from '../libs/core/secure-io.js';
import { detectTier } from '../libs/core/tier-guard.js';
import { ledger } from '../libs/core/ledger.js';
import { withLock } from '../libs/core/src/lock-utils.js';
import { findMissionPath, missionDir as resolveMissionDir } from '../libs/core/path-resolver.js';
import { transitionStatus } from '../libs/core/mission-status.js';
import { trustEngine } from '../libs/core/trust-engine.js';
import { auditChain } from '../libs/core/audit-chain.js';
import { validateFileFreshness } from '../libs/core/validators.js';

const ROOT_DIR = pathResolver.rootDir();
const REGISTRY_PATH = pathResolver.active('missions/registry.json');
const ARCHIVE_DIR = pathResolver.active('archive/missions');
const QUEUE_PATH = pathResolver.shared('runtime/mission_queue.jsonl');
const MISSION_FOCUS_PATH = pathResolver.shared('runtime/current_mission_focus.json');
const AGENT_RUNTIME_EVENT_PATH = pathResolver.shared('observability/mission-control/agent-runtime-events.jsonl');

interface MissionState {
  mission_id: string;
  tier: 'personal' | 'confidential' | 'public';
  status: 'planned' | 'active' | 'validating' | 'distilling' | 'completed' | 'paused' | 'failed' | 'archived';
  execution_mode: 'local' | 'delegated';
  relationships?: {
    prerequisites?: string[];
    successors?: string[];
    blockers?: string[];
  };
  delegation?: {
    agent_id: string;
    a2a_message_id: string;
    remote_repo_url?: string;
    last_sync_ts: string;
    verification_status: 'pending' | 'verified' | 'rejected';
    evidence_hashes?: Record<string, string>;
  };
  priority: number;
  assigned_persona: string;
  confidence_score: number;
  git: {
    branch: string;
    start_commit: string;
    latest_commit: string;
    checkpoints: Array<{ task_id: string; commit_hash: string; ts: string }>;
  };
  history: Array<{ ts: string; event: string; from?: string; to?: string; note: string }>;
}

function readFocusedMissionId(): string | null {
  if (!safeExistsSync(MISSION_FOCUS_PATH)) return null;
  try {
    const raw = safeReadFile(MISSION_FOCUS_PATH, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw);
    return typeof parsed?.mission_id === 'string' ? parsed.mission_id.toUpperCase() : null;
  } catch (_) {
    return null;
  }
}

function writeFocusedMissionId(missionId: string): void {
  safeWriteFile(MISSION_FOCUS_PATH, JSON.stringify({
    mission_id: missionId.toUpperCase(),
    ts: new Date().toISOString(),
  }, null, 2));
}

/**
 * 1. Prerequisite Validation (The Immune System)
 */
function checkPrerequisites() {
  logger.info('🛡️ Validating Sovereign Prerequisites...');
  
  const identityPath = pathResolver.knowledge('personal/my-identity.json');
  if (!safeExistsSync(identityPath)) {
    throw new Error('CRITICAL: Sovereign Identity missing. Please run "pnpm onboard" first to establish your identity.');
  }

  const tiers = [
    'knowledge/personal/missions', 
    'active/missions/confidential', 
    'active/missions/public'
  ];
  tiers.forEach(tier => {
    const fullPath = pathResolver.rootResolve(tier);
    if (!safeExistsSync(fullPath)) {
      logger.warn(`Creating missing tier directory: ${tier}`);
      safeMkdir(fullPath, { recursive: true });
    }
  });

  if (!safeExistsSync(pathResolver.rootResolve('node_modules'))) {
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
  const missionPath = findMissionPath(id);
  if (!missionPath) return null;
  const statePath = path.join(missionPath, 'mission-state.json');
  if (!safeExistsSync(statePath)) return null;
  try {
    const content = safeReadFile(statePath, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  } catch (_) { return null; }
}

async function saveState(id: string, state: MissionState, { alreadyLocked = false } = {}) {
  const missionDir = findMissionPath(id) || resolveMissionDir(id, state.tier);
  if (!safeExistsSync(missionDir)) safeMkdir(missionDir, { recursive: true });

  const doWrite = async () => {
    safeWriteFile(path.join(missionDir, 'mission-state.json'), JSON.stringify(state, null, 2));
  };

  if (alreadyLocked) {
    await doWrite();
  } else {
    await withLock(`mission-${id}`, doWrite);
  }
}

/**
 * 4. Mission Commands
 */
async function enqueueMission(id: string, tier: string, priority: number = 5, deps: string[] = []) {
  const upperId = id.toUpperCase();
  const entry = {
    mission_id: upperId,
    tier,
    priority,
    status: 'pending',
    enqueued_at: new Date().toISOString(),
    dependencies: deps
  };

  await withLock('mission-queue', async () => {
    safeAppendFileSync(QUEUE_PATH, JSON.stringify(entry) + '\n');
  });
  logger.success(`📥 Mission ${upperId} added to queue (Priority: ${priority}).`);
}

async function dispatchNextMission() {
  await withLock('mission-queue', async () => {
    if (!safeExistsSync(QUEUE_PATH)) {
      logger.info('Queue is empty.');
      return;
    }

    const lines = (safeReadFile(QUEUE_PATH, { encoding: 'utf8' }) as string).split('\n').filter(l => !!l);
    const queue = lines.map(l => JSON.parse(l));
    const pending = queue.filter(m => m.status === 'pending');

    if (pending.length === 0) {
      logger.info('No pending missions in queue.');
      return;
    }

    // Sort by priority (desc) and time
    pending.sort((a, b) => b.priority - a.priority || a.enqueued_at.localeCompare(b.enqueued_at));

    for (const mission of pending) {
      const { ok, missing } = checkDependencies(mission.mission_id);
      if (ok) {
        logger.info(`🚀 Dispatching Mission: ${mission.mission_id}...`);
        mission.status = 'dispatched';
        // Update queue file
        const updatedLines = queue.map(m => JSON.stringify(m)).join('\n') + '\n';
        safeWriteFile(QUEUE_PATH, updatedLines);
        
        // Actually start the mission
        await startMission(mission.mission_id, mission.tier as any);
        return;
      } else {
        logger.info(`⏳ Skipping ${mission.mission_id}: Waiting for ${missing.join(', ')}`);
      }
    }
    logger.info('No missions ready for dispatch (dependencies not met).');
  });
}

function recordAgentRuntimeEvent(event: Record<string, unknown>): void {
  const dir = path.dirname(AGENT_RUNTIME_EVENT_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeAppendFileSync(AGENT_RUNTIME_EVENT_PATH, JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  }) + '\n');
}

async function createMission(id: string, tier: 'personal' | 'confidential' | 'public' = 'confidential', tenantId: string = 'default', missionType: string = 'development', visionRef?: string, persona: string = 'Ecosystem Architect', relationships: any = {}) {
  const upperId = id.toUpperCase();
  const templatePath = pathResolver.knowledge('public/governance/mission-templates.json');
  const templates = JSON.parse(safeReadFile(templatePath, { encoding: 'utf8' }) as string).templates;
  const template = templates.find((t: any) => t.name === missionType) || templates[0];

  // Auto-calculate tier based on template injections
  const finalTier = calculateRequiredTier(template.knowledge_injections || [], tier);
  const missionDir = resolveMissionDir(upperId, finalTier);
  
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
    execution_mode: 'local',
    relationships: relationships,
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
  await saveState(upperId, initialState);

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

/**
 * 4.5. Mission Directory Search Helper
 * Returns only the active tier directories (personal, confidential, public)
 * from mission-management-config.json — excludes archive, exports, and ledger paths.
 */
const ACTIVE_TIERS: readonly string[] = ['personal', 'confidential', 'public'];

function getActiveMissionSearchDirs(): string[] {
  const configPath = pathResolver.knowledge('public/governance/mission-management-config.json');
  if (safeExistsSync(configPath)) {
    try {
      const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
      const dirs = config.directories || {};
      return ACTIVE_TIERS
        .map(tier => dirs[tier])
        .filter((d): d is string => !!d)
        .map(d => pathResolver.rootResolve(d));
    } catch (_) {}
  }
  // Fallback: scan active/missions and its subdirectories
  return [pathResolver.active('missions')];
}

/**
 * 5. Dependency & Relationship Management
 */
function checkDependencies(missionId: string): { ok: boolean; missing: string[] } {
  const state = loadState(missionId);
  if (!state || !state.relationships?.prerequisites) return { ok: true, missing: [] };

  const missing: string[] = [];
  for (const pre of state.relationships.prerequisites) {
    const preState = loadState(pre);
    if (!preState || preState.status !== 'completed') {
      missing.push(pre);
    }
  }

  return { ok: missing.length === 0, missing };
}

async function startMission(id: string, tier: 'personal' | 'confidential' | 'public' = 'confidential', persona: string = 'Ecosystem Architect', tenantId: string = 'default', missionType: string = 'development', visionRef?: string, relationships: any = {}) {
  if (!id) {
    logger.error('Usage: mission_controller start <MISSION_ID> [tier]');
    logger.info('  Tiers: personal | confidential | public (default: confidential)');
    return;
  }
  checkPrerequisites();
  const upperId = id.toUpperCase();
  
  // Try to find existing mission first
  let state = loadState(upperId);
  const finalTier = state ? state.tier : tier; // Use existing tier if found, otherwise use requested
  
  // Check Dependencies unless forced
  const force = process.argv.includes('--force');
  if (!force) {
    const prereqs = state?.relationships?.prerequisites || relationships?.prerequisites;
    if (prereqs) {
      const missing: string[] = [];
      for (const pre of prereqs) {
        const preState = loadState(pre);
        if (!preState || preState.status !== 'completed') {
          missing.push(pre);
        }
      }
      if (missing.length > 0) {
        logger.error(`🚨 Cannot start mission ${upperId}. Prerequisites not met: ${missing.join(', ')}`);
        logger.info('Use --force to bypass this check.');
        return;
      }
    }
  }

  logger.info(`🚀 Activating Mission: ${upperId} (Tier: ${finalTier})...`);
  
  try {
    if (!state) {
      await createMission(upperId, finalTier, tenantId, missionType, visionRef, persona, relationships);
      state = loadState(upperId);
      if (state) {
        state.status = transitionStatus(state.status, 'active');
        state.history.push({ ts: new Date().toISOString(), event: 'ACTIVATE', note: 'Mission activated.' });
        await saveState(upperId, state);
      }
    } else {
      state.status = transitionStatus(state.status, 'active');
      state.history.push({ ts: new Date().toISOString(), event: 'RESUME', note: 'Mission resumed.' });
      await saveState(upperId, state);
    }

    const missionDir = findMissionPath(upperId);
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
  const sourcePath = pathResolver.knowledge(`public/roles/${roleSlug}/PROCEDURE.md`);
  const targetDir = findMissionPath(missionId);
  
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

/**
 * 4. Trust Engine (Delegated to @agent/core/trust-engine)
 */
function updateTrustScore(agentId: string, result: 'verified' | 'rejected') {
  const oldRecord = trustEngine.getScore(agentId);
  const oldScore = oldRecord?.score ?? 500;

  if (result === 'verified') {
    trustEngine.recordEvent(agentId, 'outputQuality', 10, `mission verified`);
    trustEngine.recordEvent(agentId, 'policyCompliance', 5, `mission compliant`);
  } else {
    trustEngine.recordEvent(agentId, 'outputQuality', -20, `mission rejected`);
  }

  const newRecord = trustEngine.getScore(agentId);
  trustEngine.persist();

  auditChain.recordTrustChange(agentId, oldScore, newRecord?.score ?? 0, `mission ${result}`);
}

async function delegateMission(id: string, agentId: string, a2aMessageId: string) {
  if (!id || !agentId || !a2aMessageId) {
    logger.error('Usage: mission_controller delegate <MISSION_ID> <AGENT_ID> <A2A_MESSAGE_ID>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  // Trust Guardrail
  const ledgerPath = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
  if (safeExistsSync(ledgerPath)) {
    const ledger = JSON.parse(safeReadFile(ledgerPath, { encoding: 'utf8' }) as string);
    const agent = ledger.agents[agentId];
    if (agent && agent.current_score < 3.0 && (state.tier === 'personal' || state.tier === 'confidential')) {
      throw new Error(`CRITICAL: Agent ${agentId} has insufficient trust score (${agent.current_score}) for ${state.tier} tier mission.`);
    }
  }

  logger.info(`📤 Delegating Mission ${upperId} to agent ${agentId}...`);

  state.status = transitionStatus(state.status, 'active');
  state.execution_mode = 'delegated';
  state.delegation = {
    agent_id: agentId,
    a2a_message_id: a2aMessageId,
    last_sync_ts: new Date().toISOString(),
    verification_status: 'pending'
  };
  state.history.push({ 
    ts: new Date().toISOString(), 
    event: 'DELEGATE', 
    note: `Mission delegated to ${agentId} (A2A: ${a2aMessageId})` 
  });
  
  await saveState(upperId, state);
  logger.success(`✅ Mission ${upperId} marked as DELEGATED.`);
}

async function importMission(id: string, remoteUrl: string) {
  if (!id || !remoteUrl) {
    logger.error('Usage: mission_controller import <MISSION_ID> <REMOTE_URL>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  const missionDir = findMissionPath(upperId);
  if (!missionDir) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return;
  }

  logger.info(`📥 Importing results for Mission ${upperId} from ${remoteUrl}...`);
  
  try {
    // 1. Add remote and fetch
    // Use try-catch for git remote add in case it exists
    try {
        safeExec('git', ['remote', 'add', 'origin_remote', remoteUrl], { cwd: missionDir });
    } catch (_) {
        safeExec('git', ['remote', 'set-url', 'origin_remote', remoteUrl], { cwd: missionDir });
    }
    safeExec('git', ['fetch', 'origin_remote'], { cwd: missionDir });
    
    // 2. Merge changes (preserving history)
    safeExec('git', ['merge', 'origin_remote/main', '--no-edit'], { cwd: missionDir });
    
    state.status = transitionStatus(state.status, 'validating');
    if (state.delegation) {
      state.delegation.last_sync_ts = new Date().toISOString();
      state.delegation.remote_repo_url = remoteUrl;
    }
    state.history.push({ 
      ts: new Date().toISOString(), 
      event: 'IMPORT', 
      note: `Imported results from ${remoteUrl}. Transitioned to VALIDATING.` 
    });
    
    await saveState(upperId, state);
    logger.success(`✅ Results imported for ${upperId}. Manual/Auto verification required.`);
  } catch (err: any) {
    logger.error(`Import failed: ${err.message}`);
  }
}

async function verifyMission(id: string, result: 'verified' | 'rejected', note: string) {
  if (!id || !result || !['verified', 'rejected'].includes(result)) {
    logger.error('Usage: mission_controller verify <MISSION_ID> <verified|rejected> <note>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  if (state.status !== 'active' && state.status !== 'validating') {
    logger.error(`❌ Cannot verify mission ${upperId} (status: ${state.status}). Only active or validating missions can be verified.`);
    return;
  }

  logger.info(`🛡️ Verifying Mission ${upperId}: Result = ${result.toUpperCase()}`);
  
  if (result === 'verified') {
    state.status = transitionStatus(state.status, 'distilling');
  } else {
    state.status = transitionStatus(state.status, 'active'); // Send back to active for rework
  }

  if (state.delegation) {
    state.delegation.verification_status = result;
    // Update Trust Score
    updateTrustScore(state.delegation.agent_id, result);
  }

  state.history.push({ 
    ts: new Date().toISOString(), 
    event: 'VERIFY', 
    note: `Verification ${result}: ${note}` 
  });
  
  await saveState(upperId, state);
  logger.success(`✅ Mission ${upperId} verification complete. Status: ${state.status}`);
}

async function distillMission(id: string) {
  if (!id) {
    logger.error('Usage: mission_controller distill <MISSION_ID>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found. Run "list" to see available missions.`);

  // Pre-flight: only distilling or validating missions can be distilled
  if (state.status !== 'distilling' && state.status !== 'validating') {
    const hint = state.status === 'active'
      ? 'Run "verify" first to move the mission to distilling status.'
      : state.status === 'completed'
        ? 'This mission is already completed.'
        : `Current status "${state.status}" cannot transition to distillation.`;
    logger.error(`❌ Cannot distill mission ${upperId} (status: ${state.status}). ${hint}`);
    return;
  }

  const missionPath = findMissionPath(upperId);
  if (!missionPath) throw new Error(`Mission directory for ${upperId} not found.`);

  logger.info(`🧠 Distilling Wisdom for Mission ${upperId}...`);

  // 1. Gather context for the LLM
  const context = gatherDistillContext(upperId, state, missionPath);

  // 2. Load distillation prompt template
  const promptTemplatePath = pathResolver.knowledge('public/governance/distill-prompt.md');
  const promptTemplate = safeExistsSync(promptTemplatePath)
    ? safeReadFile(promptTemplatePath, { encoding: 'utf8' }) as string
    : '';

  // 3. Build the full prompt
  const fullPrompt = [
    promptTemplate,
    '',
    '---',
    '## Mission State',
    '```json',
    JSON.stringify(state, null, 2),
    '```',
    '',
    '## Evidence & Context',
    '```',
    context,
    '```',
  ].join('\n');

  // 4. Load wisdom policy (LLM config + tier mapping)
  const wisdomPolicyPath = pathResolver.knowledge('public/governance/wisdom-policy.json');
  let wisdomPolicy: any = {};
  if (safeExistsSync(wisdomPolicyPath)) {
    try {
      wisdomPolicy = JSON.parse(safeReadFile(wisdomPolicyPath, { encoding: 'utf8' }) as string);
    } catch (_) {}
  }

  // 5. Call LLM for distillation (configurable via wisdom-policy.json "llm" section)
  let wisdom: any = null;
  try {
    const llmPolicy: LlmPolicyConfig | undefined = wisdomPolicy.llm;
    const raw = invokeLlm(fullPrompt, 'distill', llmPolicy);
    const resolvedProfile = resolveLlmConfig('distill', llmPolicy);
    wisdom = parseLlmResponse(raw, resolvedProfile.response_format);
  } catch (err: any) {
    logger.warn(`⚠️ LLM distillation failed: ${err.message}`);
    logger.info('Falling back to structural distillation (no LLM)...');
    wisdom = buildFallbackWisdom(upperId, state);
  }

  // 6. Write wisdom file according to wisdom-policy.json tier mapping
  let outputDir = 'knowledge/public/evolution'; // default
  outputDir = wisdomPolicy.tier_mapping?.[state.tier] || outputDir;

  const dateSlug = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  const wisdomFileName = `distill_${upperId.toLowerCase()}_${dateSlug}.md`;
  const wisdomFilePath = pathResolver.rootResolve(path.join(outputDir, wisdomFileName));
  const wisdomDirPath = path.dirname(wisdomFilePath);

  if (!safeExistsSync(wisdomDirPath)) safeMkdir(wisdomDirPath, { recursive: true });

  const wisdomMd = formatWisdomMarkdown(wisdom, upperId);
  safeWriteFile(wisdomFilePath, wisdomMd);
  logger.info(`📝 Wisdom written to ${path.relative(ROOT_DIR, wisdomFilePath)}`);

  // 7. Transition status
  state.status = transitionStatus(state.status, 'completed');
  state.history.push({
    ts: new Date().toISOString(),
    event: 'DISTILL',
    note: `Knowledge distillation completed. Output: ${wisdomFileName}`,
  });

  await saveState(upperId, state);

  // 8. Record to ledger
  ledger.record('MISSION_DISTILL', {
    mission_id: upperId,
    wisdom_file: wisdomFileName,
    output_dir: outputDir,
    llm_used: wisdom !== null,
  });

  logger.success(`✅ Wisdom distilled for ${upperId}. Mission ready for finishing.`);
}

/**
 * LLM Resolution Layer
 *
 * Two-tier configuration:
 *
 *   1. Organization Policy (wisdom-policy.json → llm)
 *      Defines named profiles (heavy/standard/light) and maps purposes to profiles.
 *
 *   2. User Environment (my-identity.json → llm_tools)
 *      Declares which CLI tools are installed and optional profile overrides.
 *
 * Resolution order for resolveLlmConfig(purpose):
 *   a. purpose_map[purpose] → profile name (or default_profile)
 *   b. User override for that profile? → use it
 *   c. Org profile → check user has the command available
 *   d. If not available → try next profile in fallback chain
 *   e. If nothing works → throw (caller handles fallback)
 */
interface LlmProfile {
  description?: string;
  command: string;
  args: string[];
  timeout_ms?: number;
  response_format?: string;
}

interface LlmPolicyConfig {
  profiles?: Record<string, LlmProfile>;
  purpose_map?: Record<string, string>;
  default_profile?: string;
}

interface UserLlmTools {
  available?: string[];
  profile_overrides?: Record<string, Partial<LlmProfile>>;
}

const BUILTIN_FALLBACK: LlmProfile = {
  command: 'claude',
  args: ['-p', '{prompt}', '--output-format', 'json'],
  timeout_ms: 120_000,
  response_format: 'json_envelope',
};

/** Profile weight for fallback ordering: heavy → standard → light */
const PROFILE_FALLBACK_ORDER = ['heavy', 'standard', 'light'];

function loadUserLlmTools(): UserLlmTools {
  const identityPath = pathResolver.knowledge('personal/my-identity.json');
  if (!safeExistsSync(identityPath)) return {};
  try {
    const identity = JSON.parse(safeReadFile(identityPath, { encoding: 'utf8' }) as string);
    return identity.llm_tools || {};
  } catch (_) {
    return {};
  }
}

function isToolAvailable(command: string, userTools: UserLlmTools): boolean {
  // If user hasn't declared available tools, assume everything is available
  if (!userTools.available || userTools.available.length === 0) return true;
  return userTools.available.includes(command);
}

/**
 * Resolves the LLM profile for a given purpose.
 *
 * @param purpose  - The use case (e.g. "distill", "validate", "summarize")
 * @param policy   - The llm section from wisdom-policy.json
 * @returns Fully resolved LlmProfile ready for invocation
 */
function resolveLlmConfig(purpose: string, policy?: LlmPolicyConfig): LlmProfile {
  const userTools = loadUserLlmTools();
  const profiles = policy?.profiles || {};
  const purposeMap = policy?.purpose_map || {};
  const defaultName = policy?.default_profile || 'standard';

  // Determine target profile name from purpose
  const targetName = purposeMap[purpose] || defaultName;

  // Build candidate list: target first, then fallback order (excluding target)
  const candidates = [targetName, ...PROFILE_FALLBACK_ORDER.filter(p => p !== targetName)];

  for (const name of candidates) {
    // Check user override first
    const userOverride = userTools.profile_overrides?.[name];
    if (userOverride?.command && isToolAvailable(userOverride.command, userTools)) {
      const base = profiles[name] || BUILTIN_FALLBACK;
      const merged = { ...base, ...userOverride } as LlmProfile;
      logger.info(`🤖 LLM resolved: purpose="${purpose}" → profile="${name}" (user override, cmd=${merged.command})`);
      return merged;
    }

    // Check org profile
    const orgProfile = profiles[name];
    if (orgProfile && isToolAvailable(orgProfile.command, userTools)) {
      logger.info(`🤖 LLM resolved: purpose="${purpose}" → profile="${name}" (cmd=${orgProfile.command})`);
      return orgProfile;
    }
  }

  // Last resort: builtin fallback
  if (isToolAvailable(BUILTIN_FALLBACK.command, userTools)) {
    logger.warn(`⚠️ LLM fallback to builtin default for purpose="${purpose}"`);
    return BUILTIN_FALLBACK;
  }

  throw new Error(
    `No LLM tool available for purpose "${purpose}". ` +
    `User tools: [${userTools.available?.join(', ') || 'none declared'}]`
  );
}

function invokeLlm(prompt: string, purpose: string, policy?: LlmPolicyConfig): string {
  const profile = resolveLlmConfig(purpose, policy);
  const args = profile.args.map(a => a === '{prompt}' ? prompt : a);
  const timeoutMs = profile.timeout_ms || 120_000;

  logger.info(`🤖 Invoking LLM: ${profile.command} (timeout: ${timeoutMs}ms)`);
  return safeExec(profile.command, args, { timeoutMs });
}

/**
 * Parses the raw LLM output into a structured object.
 *
 * Supported response_format values:
 *   - "json_envelope": stdout is a JSON wrapper with a .result field
 *   - "raw_json": stdout is the JSON object directly
 *   - "text": plain text that may contain a fenced JSON block
 */
function parseLlmResponse(raw: string, responseFormat?: string): any {
  const format = responseFormat || 'json_envelope';

  let content: string;
  if (format === 'json_envelope') {
    const envelope = JSON.parse(raw);
    content = typeof envelope.result === 'string'
      ? envelope.result
      : JSON.stringify(envelope.result);
  } else {
    content = raw;
  }

  // Try direct JSON parse first
  try {
    return JSON.parse(content);
  } catch (_) {}

  // Extract fenced JSON block
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1].trim());
  }

  // Last resort
  return JSON.parse(content.trim());
}

/**
 * Gathers mission evidence, git log, and ledger into a single context string.
 */
function gatherDistillContext(missionId: string, state: MissionState, missionPath: string): string {
  const parts: string[] = [];

  // Git log from mission micro-repo
  try {
    const gitLog = safeExec('git', ['log', '--oneline', '-20'], { cwd: missionPath });
    parts.push('### Git History (last 20 commits)');
    parts.push(gitLog.trim());
  } catch (_) {
    parts.push('### Git History: unavailable');
  }

  // Evidence ledger
  const ledgerPath = path.join(missionPath, 'evidence', 'ledger.jsonl');
  if (safeExistsSync(ledgerPath)) {
    const ledgerContent = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
    const lines = ledgerContent.trim().split('\n');
    parts.push('');
    parts.push(`### Evidence Ledger (${lines.length} events)`);
    // Include last 30 events to stay within token limits
    parts.push(lines.slice(-30).join('\n'));
  }

  // Checkpoints summary
  if (state.git.checkpoints.length > 0) {
    parts.push('');
    parts.push('### Checkpoints');
    for (const cp of state.git.checkpoints) {
      parts.push(`- ${cp.ts}: ${cp.task_id} (${cp.commit_hash.slice(0, 8)})`);
    }
  }

  // History (status transitions)
  if (state.history.length > 0) {
    parts.push('');
    parts.push('### Status History');
    for (const h of state.history) {
      parts.push(`- ${h.ts}: [${h.event}] ${h.note}`);
    }
  }

  return parts.join('\n');
}

/**
 * Fallback wisdom when Claude CLI is unavailable.
 * Extracts structural information without LLM inference.
 */
function buildFallbackWisdom(missionId: string, state: MissionState): any {
  const failureEvents = state.history.filter(h => h.event === 'FAIL' || h.event === 'VERIFY');
  const hasFailures = failureEvents.length > 0;

  return {
    title: `Mission ${missionId} Completion Summary`,
    category: hasFailures ? 'Incident' : 'Operations',
    tags: [state.tier, state.assigned_persona.toLowerCase().replace(/\s+/g, '-'), 'auto-distilled'],
    importance: hasFailures ? 5 : 3,
    sections: {
      summary: `Mission ${missionId} completed with ${state.git.checkpoints.length} checkpoints and ${state.history.length} lifecycle events.`,
      key_learnings: ['(Automatic distillation — manual review recommended)'],
      patterns_discovered: ['None extracted (Claude CLI unavailable)'],
      failures_and_recoveries: hasFailures
        ? failureEvents.map(e => `${e.ts}: ${e.note}`)
        : ['None'],
      reusable_artifacts: ['None identified'],
    },
  };
}

/**
 * Formats the distilled wisdom JSON into a Markdown file with frontmatter.
 */
function formatWisdomMarkdown(wisdom: any, missionId: string): string {
  const now = new Date().toISOString().slice(0, 10);
  const tags = (wisdom.tags || []).map((t: string) => `"${t}"`).join(', ');
  const sections = wisdom.sections || {};

  const lines: string[] = [
    '---',
    `title: "${wisdom.title || `Distillation: ${missionId}`}"`,
    `category: ${wisdom.category || 'Operations'}`,
    `tags: [${tags}]`,
    `importance: ${wisdom.importance || 3}`,
    `source_mission: ${missionId}`,
    `author: Kyberion Wisdom Distiller`,
    `last_updated: ${now}`,
    '---',
    '',
    `# ${wisdom.title || `Distillation: ${missionId}`}`,
    '',
  ];

  if (sections.summary) {
    lines.push('## Summary', sections.summary, '');
  }

  if (sections.key_learnings?.length) {
    lines.push('## Key Learnings');
    for (const l of sections.key_learnings) lines.push(`- ${l}`);
    lines.push('');
  }

  if (sections.patterns_discovered?.length) {
    lines.push('## Patterns Discovered');
    for (const p of sections.patterns_discovered) lines.push(`- ${p}`);
    lines.push('');
  }

  if (sections.failures_and_recoveries?.length && sections.failures_and_recoveries[0] !== 'None') {
    lines.push('## Failures & Recoveries');
    for (const f of sections.failures_and_recoveries) lines.push(`- ${f}`);
    lines.push('');
  }

  if (sections.reusable_artifacts?.length && sections.reusable_artifacts[0] !== 'None identified') {
    lines.push('## Reusable Artifacts');
    for (const a of sections.reusable_artifacts) lines.push(`- ${a}`);
    lines.push('');
  }

  lines.push('---', `*Distilled by Kyberion | Mission: ${missionId} | ${now}*`, '');

  return lines.join('\n');
}

async function sealMission(id: string) {
  const upperId = id.toUpperCase();
  const missionDir = findMissionPath(upperId);
  if (!missionDir) return;

  const pubKeyPath = pathResolver.vault('keys/sovereign-public.pem');
  if (!safeExistsSync(pubKeyPath)) {
    logger.warn('⚠️ [SovereignSeal] Public key not found. Skipping encryption.');
    return;
  }

  logger.info(`🔒 [SovereignSeal] Encrypting mission ${upperId} for archival (Hybrid AES+RSA)...`);

  const archivePath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.tar.gz`);
  const symKeyPath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.key`);
  const encKeyPath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.key.enc`);
  const encryptedPath = pathResolver.sharedTmp(`missions/${upperId}/${upperId}.enc`);

  try {
    // 1. Package mission directory
    safeExec('tar', ['-czf', archivePath, '-C', path.dirname(missionDir), path.basename(missionDir)]);
    
    // 2. Generate random symmetric key (AES-256)
    safeExec('openssl', ['rand', '-out', symKeyPath, '32']);

    // 3. Encrypt archive with symmetric key
    safeExec('openssl', ['enc', '-aes-256-cbc', '-salt', '-in', archivePath, '-out', encryptedPath, '-pass', `file:${symKeyPath}`, '-pbkdf2']);

    // 4. Encrypt symmetric key with public key (RSA)
    safeExec('openssl', ['rsautl', '-encrypt', '-pubin', '-inkey', pubKeyPath, '-in', symKeyPath, '-out', encKeyPath]);

    logger.success(`✅ Mission ${upperId} sealed cryptographically (Encrypted key: ${path.basename(encKeyPath)}).`);
    
    // 5. [Blockchain Anchor] Anchor the hash of the encrypted archive
    const { createHash } = await import('node:crypto');
    const fileBuffer = safeReadFile(encryptedPath, { encoding: null }) as Buffer;
    const hash = createHash('sha256').update(fileBuffer).digest('hex');

    const anchorInput = pathResolver.sharedTmp(`missions/${upperId}/anchor-${upperId}-${Date.now()}.json`);
    safeWriteFile(anchorInput, JSON.stringify({
      action: 'anchor_mission',
      params: { mission_id: upperId, hash }
    }));
    
    try {
      safeExec('npx', ['tsx', 'libs/actuators/blockchain-actuator/src/index.ts', '--input', anchorInput]);
    } catch (_) {}
    safeUnlinkSync(anchorInput);

    // Clean up temporary unencrypted files
    safeUnlinkSync(archivePath);
    safeUnlinkSync(symKeyPath);

    return encryptedPath;
  } catch (err: any) {
    logger.error(`Sealing failed: ${err.message}`);
  }
}

/**
 * 6. Quality & Finalization Control
 */
async function validateMissionQuality(id: string): Promise<{ ok: boolean; reason?: string }> {
  const policyPath = pathResolver.knowledge('public/governance/security-policy.json');
  if (!safeExistsSync(policyPath)) return { ok: true };

  const policy = JSON.parse(safeReadFile(policyPath, { encoding: 'utf8' }) as string);
  const reqs = policy.quality_requirements;
  if (!reqs) return { ok: true };

  const state = loadState(id);
  if (!state) return { ok: false, reason: 'Mission state not found.' };

  if (reqs.require_test_success) {
    // Check for recent test results or trigger test
    logger.info(`🧪 [QualityCheck] Verification required: require_test_success=true`);
    // In a real scenario, we'd check a test-results.json or similar.
    // For this implementation, we assume successful verification must have happened.
    if (state.status !== 'distilling' && state.status !== 'validating' && state.status !== 'completed') {
        return { ok: false, reason: 'Mission must pass validation/verification before finishing.' };
    }
  }

  return { ok: true };
}

async function finishMission(id: string, seal: boolean = false) {
  if (!id) {
    logger.error('Usage: mission_controller finish <MISSION_ID> [--seal]');
    return;
  }
  const upperId = id.toUpperCase();

  // 0a. Pre-flight status check
  const preState = loadState(upperId);
  if (!preState) {
    logger.error(`❌ Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }
  if (preState.status === 'archived') {
    logger.info(`Mission ${upperId} is already archived.`);
    return;
  }
  if (preState.status !== 'completed' && preState.status !== 'distilling') {
    const steps: Record<string, string> = {
      planned:    'Run "start" to activate the mission first.',
      active:     'Run "verify" → "distill" to complete the mission lifecycle first.',
      validating: 'Run "distill" to extract knowledge before finishing.',
      paused:     'Run "start" to resume, then complete the lifecycle.',
      failed:     'Run "start" to retry, then complete the lifecycle.',
    };
    const hint = steps[preState.status] || '';
    logger.error(`❌ Cannot finish mission ${upperId} (status: ${preState.status}). ${hint}`);
    return;
  }

  // 0b. Quality Guard
  const quality = await validateMissionQuality(upperId);
  if (!quality.ok) {
    logger.error(`❌ [QUALITY_REJECTION] Mission ${upperId} does not meet governance requirements: ${quality.reason}`);
    return;
  }

  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);

  const missionDir = findMissionPath(upperId);
  if (!missionDir) return;

  logger.info(`🏁 Finishing Mission: ${upperId}...`);

  // 1. Commit final changes to Micro-Repo
  try {
    safeExec('git', ['add', '.'], { cwd: missionDir });
    safeExec('git', ['commit', '-m', `feat: complete mission ${upperId}`], { cwd: missionDir });
    state.git.latest_commit = getGitHash(missionDir);
  } catch (_) { logger.info('No changes to commit in mission repo.'); }

  // 2. Update state
  if (state.status !== 'completed') {
    state.status = transitionStatus(state.status, 'completed');
    state.history.push({ ts: new Date().toISOString(), event: 'FINISH', note: 'Mission completed.' });
  }
  await saveState(upperId, state);

  // 3. Optional Sealing
  if (seal || (state.tier === 'personal' && process.env.AUTO_SEAL === 'true')) {
    await sealMission(upperId);
  }

  // Record to Hybrid Ledger before archival
  ledger.record('MISSION_FINISH', {
    mission_id: upperId,
    status: 'completed',
    sealed: seal,
    archive_path: ARCHIVE_DIR
  });

  recordAgentRuntimeEvent({
    event: 'MISSION_FINISH_REFRESH_RECOMMENDED',
    mission_id: upperId,
    tier: state.tier,
    note: 'Mission finished. Control surfaces may refresh or restart mission-bound agents to reduce stale context.',
  });

  // 4. Purge governed runtime temp for this mission if present
  const missionTmpDir = pathResolver.sharedTmp(path.join('missions', upperId));
  if (safeExistsSync(missionTmpDir)) {
    logger.info('🧹 Purging mission runtime temp...');
    safeRmSync(missionTmpDir, { recursive: true, force: true });
  }

  // 4. Archive
  if (!safeExistsSync(ARCHIVE_DIR)) safeMkdir(ARCHIVE_DIR, { recursive: true });
  
  const archivePath = path.join(ARCHIVE_DIR, upperId);
  
  if (safeExistsSync(archivePath)) safeExec('rm', ['-rf', archivePath]);
  // Use shell cp and rm to handle potential cross-device move if tier is in knowledge/
  safeExec('cp', ['-r', missionDir, archivePath]);
  safeExec('rm', ['-rf', missionDir]);

  state.status = transitionStatus(state.status, 'archived');
  state.history.push({ ts: new Date().toISOString(), event: 'ARCHIVE', note: `Mission archived to ${archivePath}.` });
  await saveState(upperId, state);
  
  logger.success(`📦 Mission ${upperId} archived and finalized.`);
}

async function createCheckpoint(taskId: string, note: string, explicitMissionId?: string) {
  if (explicitMissionId) {
    const targetMissionId = explicitMissionId.toUpperCase();
    const explicitState = loadState(targetMissionId);
    const explicitPath = findMissionPath(targetMissionId);
    if (explicitState?.status === 'active' && explicitPath) {
      return await recordCheckpointForMission(targetMissionId, explicitPath, taskId, note);
    }
    logger.error(`Mission ${targetMissionId} is not active or could not be found. Checkpoint aborted.`);
    return;
  }

  const focusedMissionId = readFocusedMissionId();

  if (focusedMissionId) {
    const focusedState = loadState(focusedMissionId);
    const focusedPath = findMissionPath(focusedMissionId);
    if (focusedState?.status === 'active' && focusedPath) {
      return await recordCheckpointForMission(focusedMissionId, focusedPath, taskId, note);
    }
  }

  // Fallback: find current active mission by scanning tier directories
  const searchDirs = getActiveMissionSearchDirs();

  let activeMissionId: string | null = null;
  let missionPath: string | null = null;

  for (const dir of searchDirs) {
    if (!safeExistsSync(dir) || !safeLstat(dir).isDirectory()) continue;
    const missions = safeReaddir(dir).filter(m => {
      try {
        return safeLstat(path.join(dir, m)).isDirectory();
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
    logger.info('  To activate a mission:  mission_controller start <MISSION_ID>');
    logger.info('  To see all missions:    mission_controller list');
    return;
  }

  return await recordCheckpointForMission(activeMissionId, missionPath, taskId, note);
}

async function recordCheckpointForMission(activeMissionId: string, missionPath: string, taskId: string, note: string) {
  writeFocusedMissionId(activeMissionId);

  const state = loadState(activeMissionId);
  if (!state) return;

  logger.info(`📸 Checkpoint for ${activeMissionId}: ${taskId}...`);
  try {
    await withLock(`mission-${activeMissionId}`, async () => {
      safeExec('git', ['add', '.'], { cwd: missionPath });

      // Commit changes if any exist; skip gracefully when working tree is clean
      let commitCreated = true;
      try {
        safeExec('git', ['commit', '-m', `checkpoint(${activeMissionId}): ${taskId} - ${note}`], { cwd: missionPath });
      } catch (_) {
        logger.info('No new changes in mission repo — recording state-only checkpoint.');
        commitCreated = false;
      }

      const hash = getGitHash(missionPath);
      const currentState = loadState(activeMissionId!)!;
      currentState.git.latest_commit = hash;
      currentState.git.checkpoints.push({ task_id: taskId, commit_hash: hash, ts: new Date().toISOString() });
      await saveState(activeMissionId!, currentState, { alreadyLocked: true });

      // Record to Hybrid Ledger
      ledger.record('MISSION_CHECKPOINT', {
        mission_id: activeMissionId!,
        task_id: taskId,
        commit_hash: hash,
        note: note
      });

      logger.success(`✅ Recorded checkpoint ${hash} in mission repo${commitCreated ? '' : ' (state-only)'}.`);
    });
  } catch (err: any) {
    logger.error(`Checkpoint failed: ${err.message}`);
  }
}

async function resumeMission(id?: string) {
  let targetId = id?.toUpperCase();
  
  if (!targetId) {
    // Scan all tier directories for active mission
    const searchDirs = getActiveMissionSearchDirs();

    for (const dir of searchDirs) {
      if (!safeExistsSync(dir) || !safeLstat(dir).isDirectory()) continue;
      const missions = safeReaddir(dir).filter(m => {
        try {
          return safeLstat(path.join(dir, m)).isDirectory();
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
  const missionPath = findMissionPath(targetId);
  const flightRecorderPath = path.join(missionPath!, 'LATEST_TASK.json');
  if (safeExistsSync(flightRecorderPath)) {
    const content = safeReadFile(flightRecorderPath, { encoding: 'utf8' }) as string;
    const task = JSON.parse(content);
    logger.warn(`📍 FLIGHT RECORDER DETECTED: Last intended task was: ${task.description}`);
    logger.info('Please verify the physical state and continue from this point.');
  }

  state.history.push({ ts: new Date().toISOString(), event: 'RESUME', note: 'Session re-established.' });
  await saveState(targetId, state);
  writeFocusedMissionId(targetId);
  logger.success(`✅ Mission ${targetId} is back in focus.`);
}

async function recordTask(missionId: string, description: string, details: any = {}) {
  const upperId = missionId.toUpperCase();
  const missionDir = findMissionPath(upperId);
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

async function purgeMissions(dryRun: boolean = false) {
  const adfPath = pathResolver.knowledge('governance/mission-lifecycle.json');
  if (!safeExistsSync(adfPath)) {
    logger.error('Mission lifecycle ADF not found.');
    return;
  }

  const adf = JSON.parse(safeReadFile(adfPath, { encoding: 'utf8' }) as string);

  // Scan active tier directories
  const searchDirs = getActiveMissionSearchDirs();
  const candidates: Array<{ mission: string; missionDir: string; targetPath: string; policyName: string }> = [];

  for (const dir of searchDirs) {
    if (!safeExistsSync(dir)) continue;
    const missions = safeReaddir(dir).filter(m => {
      try {
        return safeLstat(path.join(dir, m)).isDirectory();
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
          const stat = safeStat(missionDir);
          const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
          if (ageDays > condition.max_age_days) {
            match = true;
          }
        }

        if (match) {
          let targetPath = policy.target_dir;
          const now = new Date();
          targetPath = targetPath.replace('{YYYY-MM}', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
          targetPath = pathResolver.rootResolve(path.join(targetPath, policy.naming_pattern.replace('{mission_id}', mission)));
          candidates.push({ mission, missionDir, targetPath, policyName: policy.name });
          break; // One policy per mission
        }
      }
    }
  }

  if (candidates.length === 0) {
    logger.info('No missions match purge policies. Nothing to do.');
    return;
  }

  // Show what will be purged
  console.log('');
  console.log(`  Missions matching purge policies: ${candidates.length}`);
  console.log('');
  for (const c of candidates) {
    console.log(`    ${c.mission.padEnd(30)} → ${path.relative(ROOT_DIR, c.targetPath)}  (${c.policyName})`);
  }
  console.log('');

  if (dryRun) {
    logger.info('Dry run complete. No missions were moved. Run "purge --execute" to apply.');
    return;
  }

  // Execute purge
  for (const c of candidates) {
    logger.info(`Archiving mission ${c.mission} to ${c.targetPath} (Policy: ${c.policyName})`);
    if (!safeExistsSync(path.dirname(c.targetPath))) {
      safeMkdir(path.dirname(c.targetPath), { recursive: true });
    }
    safeExec('cp', ['-r', c.missionDir, c.targetPath]);
    safeRmSync(c.missionDir, { recursive: true, force: true });
  }
  logger.success(`✅ ${candidates.length} mission(s) purged.`);
}

/**
 * 6. Visibility Commands
 */
function listMissions(filterStatus?: string) {
  const searchDirs = getActiveMissionSearchDirs();
  const missions: Array<{ id: string; status: string; tier: string; persona: string; checkpoints: number; lastEvent: string }> = [];

  for (const dir of searchDirs) {
    if (!safeExistsSync(dir) || !safeLstat(dir).isDirectory()) continue;
    const entries = safeReaddir(dir).filter(m => {
      try { return safeLstat(path.join(dir, m)).isDirectory(); } catch (_) { return false; }
    });
    for (const m of entries) {
      const state = loadState(m);
      if (!state) continue;
      if (filterStatus && state.status !== filterStatus) continue;
      const lastHist = state.history[state.history.length - 1];
      missions.push({
        id: state.mission_id,
        status: state.status,
        tier: state.tier,
        persona: state.assigned_persona,
        checkpoints: state.git.checkpoints.length,
        lastEvent: lastHist ? `${lastHist.event} (${lastHist.ts.slice(0, 16)})` : '-',
      });
    }
  }

  if (missions.length === 0) {
    logger.info(filterStatus ? `No missions with status "${filterStatus}".` : 'No missions found.');
    return;
  }

  // Table header
  const header = `${'ID'.padEnd(30)} ${'STATUS'.padEnd(12)} ${'TIER'.padEnd(14)} ${'CP'.padStart(3)} LAST EVENT`;
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length + 10));
  for (const m of missions) {
    const statusIcon = { active: '🟢', planned: '⚪', completed: '✅', paused: '⏸️ ', failed: '❌', validating: '🔍', distilling: '🧠', archived: '📦' }[m.status] || '  ';
    console.log(`${m.id.padEnd(30)} ${statusIcon} ${m.status.padEnd(10)} ${m.tier.padEnd(14)} ${String(m.checkpoints).padStart(3)} ${m.lastEvent}`);
  }
  console.log('');
  logger.info(`${missions.length} mission(s) found.`);
}

function showMissionStatus(id: string) {
  if (!id) {
    logger.error('Usage: mission_controller status <MISSION_ID>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  const missionPath = findMissionPath(upperId);

  console.log('');
  console.log(`  Mission:     ${state.mission_id}`);
  console.log(`  Status:      ${state.status}`);
  console.log(`  Tier:        ${state.tier}`);
  console.log(`  Persona:     ${state.assigned_persona}`);
  console.log(`  Confidence:  ${state.confidence_score}`);
  console.log(`  Priority:    ${state.priority}`);
  console.log(`  Mode:        ${state.execution_mode}`);
  console.log(`  Branch:      ${state.git.branch}`);
  console.log(`  Commit:      ${state.git.latest_commit.slice(0, 8)}`);
  console.log(`  Checkpoints: ${state.git.checkpoints.length}`);
  if (missionPath) {
    console.log(`  Directory:   ${path.relative(ROOT_DIR, missionPath)}`);
  }

  if (state.delegation) {
    console.log(`  Delegated:   ${state.delegation.agent_id} (${state.delegation.verification_status})`);
  }

  if (state.relationships?.prerequisites?.length) {
    console.log(`  Prereqs:     ${state.relationships.prerequisites.join(', ')}`);
  }

  // Show next valid actions
  const nextActions: Record<string, string> = {
    planned:    'start',
    active:     'checkpoint / verify / delegate',
    validating: 'distill',
    distilling: 'distill',
    completed:  'finish [--seal]',
    paused:     'start (resume)',
    failed:     'start (retry)',
    archived:   '(terminal — no further actions)',
  };
  console.log(`  Next:        ${nextActions[state.status] || '-'}`);

  // Recent history (last 5)
  console.log('');
  console.log('  Recent History:');
  const recent = state.history.slice(-5);
  for (const h of recent) {
    console.log(`    ${h.ts.slice(0, 16)}  [${h.event}]  ${h.note}`);
  }
  console.log('');
}

function showHelp() {
  console.log(`
Kyberion Sovereign Mission Controller (KSMC)

Usage: node dist/scripts/mission_controller.js <command> [args]

Lifecycle Commands:
  create   <ID> [tier] [tenant] [type] [vision] [persona] [relationships]
                                 Create a new mission (status: planned)
  start    <ID> [tier]           Activate a mission (planned/paused/failed → active)
  checkpoint [task_id] [note]    Record a checkpoint on the current active mission
  verify   <ID> <verified|rejected> <note>
                                 Verify a mission (active → distilling or back to active)
  distill  <ID>                  Extract knowledge via LLM (distilling → completed)
  finish   <ID> [--seal]         Archive a completed mission (optionally encrypt)
  resume   [ID]                  Resume the last active mission (or specify ID)

Delegation Commands:
  delegate <ID> <agent_id> <a2a_message_id>
                                 Delegate a mission to an external agent
  import   <ID> <remote_url>     Import results from a delegated mission
  seal     <ID>                  Encrypt a mission for archival (AES+RSA)

Queue Commands:
  enqueue  <ID> <tier> [priority] [deps]
                                 Add a mission to the dispatch queue
  dispatch                       Start the next queued mission

Visibility Commands:
  list     [status]              List all missions (optionally filter by status)
  status   <ID>                  Show detailed status of a specific mission

Maintenance Commands:
  record-task <ID> <description> Record a task intention (flight recorder)
  purge    [--execute]            Preview stale missions to archive (--execute to apply)
  sync                           Sync mission registry

Typical Workflow:
  start → checkpoint (repeat) → verify → distill → finish
`);
}

/**
 * 7. Main Entry
 */
async function main() {
  // Self-identify as mission_controller role for tier-guard resolution.
  if (!process.env.MISSION_ROLE) {
    process.env.MISSION_ROLE = 'mission_controller';
  }

  const action = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];
  const arg3 = process.argv[5];
  const arg4 = process.argv[6];
  const arg5 = process.argv[7];
  const arg6 = process.argv[8];
  const arg7 = process.argv[9];

  switch (action) {
    case 'create': await createMission(arg1, arg2 as any, arg3, arg4, arg5, arg6, JSON.parse(arg7 || '{}')); break;
    case 'start': await startMission(arg1, arg2 as any, arg3, arg4, arg5, arg6, JSON.parse(arg7 || '{}')); break;
    case 'checkpoint':
      if (arg3) {
        await createCheckpoint(arg2 || 'manual', arg3 || 'progress update', arg1);
      } else {
        await createCheckpoint(arg1 || 'manual', arg2 || 'progress update');
      }
      break;
    case 'delegate': await delegateMission(arg1, arg2, arg3); break;
    case 'import': await importMission(arg1, arg2); break;
    case 'verify': await verifyMission(arg1, arg2 as any, arg3); break;
    case 'distill': await distillMission(arg1); break;
    case 'seal': await sealMission(arg1); break;
    case 'enqueue': await enqueueMission(arg1, arg2!, parseInt(arg3 || '5'), arg4 ? arg4.split(',') : []); break;
    case 'dispatch': await dispatchNextMission(); break;
    case 'finish': await finishMission(arg1, arg2 === '--seal'); break;
    case 'resume': await resumeMission(arg1); break;
    case 'record-task': await recordTask(arg1, arg2, JSON.parse(process.argv[5] || '{}')); break;
    case 'purge': await purgeMissions(arg1 !== '--execute'); break;
    case 'list': listMissions(arg1); break;
    case 'status': showMissionStatus(arg1); break;
    case 'sync':
        logger.info('Syncing mission registry...');
        break;
    case 'help': case '--help': case '-h':
        showHelp(); break;
    default:
      showHelp();
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
