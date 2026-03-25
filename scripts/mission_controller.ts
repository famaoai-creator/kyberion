/**
 * scripts/mission_controller.ts
 * Kyberion Sovereign Mission Controller (KSMC) v2.0
 * [SECURE-IO COMPLIANT]
 *
 * Architecture: Thin orchestration layer.
 * Domain logic lives in scripts/refactor/:
 *   - mission-types.ts           → Type definitions & constants
 *   - mission-cli-args.ts        → CLI argument parsing
 *   - mission-git.ts             → Git micro-repo operations
 *   - mission-state.ts           → State management & prerequisites
 *   - mission-project-ledger.ts  → Project ledger synchronization
 *   - mission-llm.ts             → LLM resolution & invocation
 *   - mission-distill.ts         → Knowledge distillation (Wisdom)
 *   - mission-seal.ts            → Cryptographic sealing (AES+RSA)
 */

import * as path from 'node:path';
import {
  findMissionPath,
  logger,
  pathResolver,
  safeReadFile,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync,
  transitionStatus,
} from '@agent/core';

// --- Sub-module imports ---
import { type MissionState, type MissionRelationships } from './refactor/mission-types.js';
import {
  extractMissionControllerPositionalArgs,
  extractProjectRelationshipOptionsFromArgv,
  extractProjectRelationshipOptions,
} from './refactor/mission-cli-args.js';
import { getGitHash, initMissionRepo, getCurrentBranch } from './refactor/mission-git.js';
import {
  assertCanGrantMissionAuthority,
  normalizeRelationships,
  readFocusedMissionId as _readFocusedMissionId,
  writeFocusedMissionId as _writeFocusedMissionId,
  loadState,
  checkDependencies,
} from './refactor/mission-state.js';
import { createMission as _createMission, startMission as _startMission } from './refactor/mission-creation.js';
import {
  syncProjectLedger as _syncProjectLedger,
  syncProjectLedgerIfLinked as _syncProjectLedgerIfLinked,
} from './refactor/mission-project-ledger.js';
import {
  delegateMission as _delegateMission,
  finishMission as _finishMission,
  grantMissionAccess as _grantMissionAccess,
  grantMissionSudo as _grantMissionSudo,
  importMission as _importMission,
  verifyMission as _verifyMission,
} from './refactor/mission-lifecycle.js';
import {
  createCheckpoint as _createCheckpoint,
  purgeMissions as _purgeMissions,
  recordTask as _recordTask,
  resumeMission as _resumeMission,
} from './refactor/mission-maintenance.js';
import { dispatchNextQueuedMission, enqueueMission as _enqueueMission } from './refactor/mission-queue.js';
import { buildMissionStatusView, listMissionSummaries } from './refactor/mission-read-model.js';
import { prewarmMissionTeam as _prewarmMissionTeam, showMissionTeam as _showMissionTeam, staffMissionTeam as _staffMissionTeam } from './refactor/mission-runtime.js';
import { distillMission as _distillMission } from './refactor/mission-distill.js';
import { sealMission as _sealMission } from './refactor/mission-seal.js';
import {
  recordAgentRuntimeEvent,
} from './refactor/mission-governance.js';

// Re-export public API for backward compatibility (tests import these directly)
export { extractMissionControllerPositionalArgs, extractProjectRelationshipOptionsFromArgv, assertCanGrantMissionAuthority };

// ─── Constants ───────────────────────────────────────────────────────────────
const ROOT_DIR = pathResolver.rootDir();
const ARCHIVE_DIR = pathResolver.active('archive/missions');
const QUEUE_PATH = pathResolver.shared('runtime/mission_queue.jsonl');
const MISSION_FOCUS_PATH = pathResolver.shared('runtime/current_mission_focus.json');
const AGENT_RUNTIME_EVENT_PATH = pathResolver.shared('observability/mission-control/agent-runtime-events.jsonl');

// ─── Focus helpers (thin wrappers binding MISSION_FOCUS_PATH) ────────────────
function readFocusedMissionId(): string | null {
  return _readFocusedMissionId(MISSION_FOCUS_PATH);
}

function writeFocusedMissionId(missionId: string): void {
  _writeFocusedMissionId(MISSION_FOCUS_PATH, missionId);
}

// ─── Project ledger helpers (bind ROOT_DIR) ───────────────────────────────────
async function syncProjectLedger(id: string): Promise<void> {
  return _syncProjectLedger(id, ROOT_DIR);
}

async function syncProjectLedgerIfLinked(id: string): Promise<void> {
  return _syncProjectLedgerIfLinked(id, ROOT_DIR);
}

// ─── Mission seal / distill wrappers ─────────────────────────────────────────
async function sealMission(id: string): Promise<string | undefined> {
  return _sealMission(id);
}

async function distillMission(id: string): Promise<void> {
  return _distillMission(id, ROOT_DIR);
}



/**
 * Mission Commands
 */

async function enqueueMission(id: string, tier: string, priority: number = 5, deps: string[] = []) {
  await _enqueueMission(QUEUE_PATH, id, tier, priority, deps);
}

async function dispatchNextMission() {
  await dispatchNextQueuedMission(
    QUEUE_PATH,
    checkDependencies,
    async (missionId, tier) => startMission(missionId, tier as any),
  );
}

async function createMission(id: string, tier: 'personal' | 'confidential' | 'public' = 'confidential', tenantId: string = 'default', missionType: string = 'development', visionRef?: string, persona: string = 'Ecosystem Architect', relationships: any = {}) {
  return _createMission({ id, tier, tenantId, missionType, visionRef, persona, relationships, rootDir: ROOT_DIR });
}

/**
 * 4.5. Mission Directory Search Helper
 * Returns only the active tier directories (personal, confidential, public)
 * from mission-management-config.json — excludes archive, exports, and ledger paths.
 */
async function startMission(id: string, tier: 'personal' | 'confidential' | 'public' = 'confidential', persona: string = 'Ecosystem Architect', tenantId: string = 'default', missionType: string = 'development', visionRef?: string, relationships: any = {}) {
  return _startMission({ id, tier, persona, tenantId, missionType, visionRef, relationships, rootDir: ROOT_DIR });
}

// syncProjectLedger and syncProjectLedgerIfLinked are defined as wrappers
// earlier in this file (lines 97-104), delegating to mission-project-ledger.ts

async function delegateMission(id: string, agentId: string, a2aMessageId: string) {
  return _delegateMission(id, agentId, a2aMessageId, syncProjectLedgerIfLinked);
}

async function importMission(id: string, remoteUrl: string) {
  return _importMission(id, remoteUrl, transitionStatus as any, syncProjectLedgerIfLinked);
}

async function verifyMission(id: string, result: 'verified' | 'rejected', note: string) {
  return _verifyMission(id, result, note, transitionStatus as any, syncProjectLedgerIfLinked);
}

// distillMission, sealMission and all LLM/distillation helpers are defined
// as thin wrappers at the top of this file, delegating to:
//   - scripts/refactor/mission-distill.ts (distillMission, helpers)
//   - scripts/refactor/mission-llm.ts (LLM resolution)
//   - scripts/refactor/mission-seal.ts (sealMission)




async function finishMission(id: string, seal: boolean = false) {
  return _finishMission(id, seal, {
    archiveDir: ARCHIVE_DIR,
    agentRuntimeEventPath: AGENT_RUNTIME_EVENT_PATH,
    getGitHash,
    sealMission,
    syncProjectLedgerIfLinked,
    transitionStatus: transitionStatus as any,
  });
}

async function createCheckpoint(taskId: string, note: string, explicitMissionId?: string) {
  return _createCheckpoint({
    taskId,
    note,
    explicitMissionId,
    readFocusedMissionId,
    writeFocusedMissionId,
    getGitHash,
    syncProjectLedgerIfLinked,
  });
}

async function resumeMission(id?: string) {
  return _resumeMission(id, {
    readFocusedMissionId,
    writeFocusedMissionId,
    getCurrentBranch,
    syncProjectLedgerIfLinked,
  });
}

async function recordTask(missionId: string, description: string, details: any = {}) {
  return _recordTask(missionId, description, details);
}

async function purgeMissions(dryRun: boolean = false) {
  return _purgeMissions(ROOT_DIR, dryRun);
}

/**
 * 6. Visibility Commands
 */
function listMissions(filterStatus?: string) {
  const missions = listMissionSummaries(filterStatus);

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
  const view = buildMissionStatusView(id);
  if (!view) {
    logger.error(`Mission ${id.toUpperCase()} not found. Run "list" to see available missions.`);
    return;
  }
  const { state, missionPath, nextAction, recentHistory } = view;

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
  if (state.relationships?.project) {
    console.log(`  Project:     ${state.relationships.project.project_id || '-'}`);
    console.log(`  Relation:    ${state.relationships.project.relationship_type}`);
    console.log(`  Gate Impact: ${state.relationships.project.gate_impact || 'none'}`);
  }

  console.log(`  Next:        ${nextAction}`);

  // Recent history (last 5)
  console.log('');
  console.log('  Recent History:');
  for (const h of recentHistory) {
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
  sync-project-ledger <ID>       Upsert this mission into the related project mission-ledger
  team     <ID> [--refresh]      Show or regenerate mission team composition
  staff    <ID>                  Spawn or verify runtime instances for assigned mission team roles

Maintenance Commands:
  record-task <ID> <description> Record a task intention (flight recorder)
  purge    [--execute]            Preview stale missions to archive (--execute to apply)
  sync                           Sync mission registry

Typical Workflow:
  start → checkpoint (repeat) → verify → distill → finish

Project Traceability Options:
  --project-id <ID>              Link mission to a project identifier
  --project-path <PATH>          Record the related project-os path
  --project-relationship <TYPE>  belongs_to | supports | governs | independent
  --affected-artifacts <CSV>     Comma-separated project artifacts impacted by the mission
  --gate-impact <TYPE>           none | informational | review_required | blocking
  --traceability-refs <CSV>      Comma-separated evidence or document refs
  --project-note <TEXT>          Free-text note for the project relationship
`);
}

function showMissionTeam(id: string, refresh = false) {
  return _showMissionTeam(id, refresh);
}

async function staffMissionTeam(id: string) {
  return _staffMissionTeam(id);
}

async function prewarmMissionTeam(id: string, teamRolesArg?: string) {
  return _prewarmMissionTeam(id, teamRolesArg);
}

async function grantMissionAccess(missionId: string, serviceId: string, ttl: number = 30) {
  assertCanGrantMissionAuthority();
  return _grantMissionAccess(missionId, serviceId, ttl);
}

async function grantMissionSudo(missionId: string, on: boolean = true, ttl: number = 15) {
  assertCanGrantMissionAuthority();
  return _grantMissionSudo(missionId, on, ttl);
}

/**
 * 7. Main Entry
 */
async function main() {
  // Self-identify as mission_controller role for tier-guard resolution.
  if (!process.env.MISSION_ROLE) {
    process.env.MISSION_ROLE = 'mission_controller';
  }

  const positionalArgs = extractMissionControllerPositionalArgs(process.argv);

  const action = positionalArgs[0];
  const arg1 = positionalArgs[1];
  const arg2 = positionalArgs[2];
  const arg3 = positionalArgs[3];
  const arg4 = positionalArgs[4];
  const arg5 = positionalArgs[5];
  const arg6 = positionalArgs[6];
  const arg7 = positionalArgs[7];

  const hasRefresh = process.argv.includes('--refresh');
  const relationshipOptions = extractProjectRelationshipOptions();

  switch (action) {
    case 'create': await createMission(arg1, arg2 as any, arg3, arg4, arg5, arg6, normalizeRelationships(JSON.parse(arg7 || '{}'), relationshipOptions)); break;
    case 'start': await startMission(arg1, arg2 as any, arg3, arg4, arg5, arg6, normalizeRelationships(JSON.parse(arg7 || '{}'), relationshipOptions)); break;
    case 'grant': await grantMissionAccess(arg1, arg2, arg3 ? parseInt(arg3) : undefined); break;
    case 'sudo': await grantMissionSudo(arg1, arg2 !== 'OFF', arg3 ? parseInt(arg3) : undefined); break;
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
    case 'finish': await finishMission(arg1, process.argv.includes('--seal')); break;
    case 'resume': await resumeMission(arg1); break;
    case 'record-task': await recordTask(arg1, arg2, JSON.parse(positionalArgs[3] || '{}')); break;
    case 'purge': await purgeMissions(!process.argv.includes('--execute')); break;
    case 'list': listMissions(arg1); break;
    case 'status': showMissionStatus(arg1); break;
    case 'sync-project-ledger': await syncProjectLedger(arg1); break;
    case 'team': showMissionTeam(arg1, hasRefresh); break;
    case 'staff': await staffMissionTeam(arg1); break;
    case 'prewarm': await prewarmMissionTeam(arg1, arg2); break;
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
