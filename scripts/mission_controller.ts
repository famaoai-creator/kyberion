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
  loadProjectRecord,
  loadProjectTrackRecord,
  logger,
  pathResolver,
  safeReadFile,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync,
  transitionStatus,
  validateWritePermission,
} from '@agent/core';

// --- Sub-module imports ---
import { type MissionState, type MissionRelationships } from './refactor/mission-types.js';
import {
  extractMissionControllerPositionalArgs,
  extractMissionStartCreateOptionsFromArgv,
  extractProjectRelationshipOptionsFromArgv,
  getOptionValue,
  parseCsvOption,
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
import {
  createMission as _createMission,
  startMission as _startMission,
} from './refactor/mission-creation.js';
import {
  syncProjectLedger as _syncProjectLedger,
  syncProjectLedgerIfLinked as _syncProjectLedgerIfLinked,
  resolveProjectLedgerJsonPath,
  resolveProjectLedgerPath,
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
  recordEvidence as _recordEvidence,
  resumeMission as _resumeMission,
} from './refactor/mission-maintenance.js';
import {
  dispatchNextQueuedMission,
  enqueueMission as _enqueueMission,
} from './refactor/mission-queue.js';
import { buildMissionStatusView, listMissionSummaries } from './refactor/mission-read-model.js';
import {
  prewarmMissionTeam as _prewarmMissionTeam,
  showMissionTeam as _showMissionTeam,
  staffMissionTeam as _staffMissionTeam,
} from './refactor/mission-runtime.js';
import { distillMission as _distillMission } from './refactor/mission-distill.js';
import { sealMission as _sealMission } from './refactor/mission-seal.js';
import { recordAgentRuntimeEvent } from './refactor/mission-governance.js';

// Re-export public API for backward compatibility (tests import these directly)
export {
  extractMissionControllerPositionalArgs,
  extractProjectRelationshipOptionsFromArgv,
  extractMissionStartCreateOptionsFromArgv,
  assertCanGrantMissionAuthority,
};

export interface ResolvedMissionCliInput {
  tier?: 'personal' | 'confidential' | 'public';
  tenantId?: string;
  missionType?: string;
  visionRef?: string;
  persona?: string;
  relationships?: MissionRelationships;
  ledgerTargets?: {
    markdown: string;
    json: string;
  };
}

export function resolveMissionStartCreateInputFromArgv(
  argv: string[] = process.argv
): ResolvedMissionCliInput {
  const positionalArgs = extractMissionControllerPositionalArgs(argv);
  const arg2 = positionalArgs[2];
  const arg3 = positionalArgs[3];
  const arg4 = positionalArgs[4];
  const arg5 = positionalArgs[5];
  const arg6 = positionalArgs[6];
  const arg7 = positionalArgs[7];
  const namedStartCreateOptions = extractMissionStartCreateOptionsFromArgv(argv);
  const relationships = normalizeRelationships(
    JSON.parse(arg7 || '{}'),
    namedStartCreateOptions.relationships || {}
  );
  if (relationships?.project?.project_id && !relationships.track?.track_id) {
    const projectRecord = loadProjectRecord(relationships.project.project_id);
    const defaultTrackId = projectRecord?.default_track_id;
    if (defaultTrackId) {
      const trackRecord = loadProjectTrackRecord(defaultTrackId);
      if (trackRecord) {
        relationships.track = {
          relationship_type: 'belongs_to',
          track_id: trackRecord.track_id,
          track_name: trackRecord.name,
          track_type: trackRecord.track_type,
          lifecycle_model: trackRecord.lifecycle_model,
          traceability_refs: [],
        };
      }
    }
  }
  const projectPath = relationships?.project?.project_path;

  return {
    tier: namedStartCreateOptions.tier || (arg2 as any),
    tenantId: namedStartCreateOptions.tenantId || arg3,
    missionType: namedStartCreateOptions.missionType || arg4,
    visionRef: namedStartCreateOptions.visionRef || arg5,
    persona: namedStartCreateOptions.persona || arg6,
    relationships,
    ledgerTargets: projectPath
      ? {
          markdown: resolveProjectLedgerPath(projectPath),
          json: resolveProjectLedgerJsonPath(projectPath),
        }
      : undefined,
  };
}

export function validateMissionStartCreateInput(
  actionName: 'create' | 'start',
  missionId?: string,
  argv: string[] = process.argv
): ResolvedMissionCliInput {
  const input = resolveMissionStartCreateInputFromArgv(argv);
  if (!missionId) return input;
  const project = input.relationships?.project;
  const track = input.relationships?.track;
  if (project?.project_id && !project.project_path) {
    throw new Error(`${actionName} ${missionId}: --project-id requires --project-path`);
  }
  if (project?.project_path && !project.project_id) {
    throw new Error(`${actionName} ${missionId}: --project-path requires --project-id`);
  }
  if (track?.track_id && !project?.project_id) {
    throw new Error(`${actionName} ${missionId}: --track-id requires --project-id`);
  }
  if (project?.project_path && input.ledgerTargets) {
    const markdownGuard = validateWritePermission(input.ledgerTargets.markdown);
    if (!markdownGuard.allowed) {
      throw new Error(
        `${actionName} ${missionId}: project ledger target '${path.relative(ROOT_DIR, input.ledgerTargets.markdown)}' is not writable under current authority. ${markdownGuard.reason}`
      );
    }
    const jsonGuard = validateWritePermission(input.ledgerTargets.json);
    if (!jsonGuard.allowed) {
      throw new Error(
        `${actionName} ${missionId}: project ledger target '${path.relative(ROOT_DIR, input.ledgerTargets.json)}' is not writable under current authority. ${jsonGuard.reason}`
      );
    }
  }
  return input;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const ROOT_DIR = pathResolver.rootDir();
const ARCHIVE_DIR = pathResolver.active('archive/missions');
const QUEUE_PATH = pathResolver.shared('runtime/mission_queue.jsonl');
const MISSION_FOCUS_PATH = pathResolver.shared('runtime/current_mission_focus.json');
const AGENT_RUNTIME_EVENT_PATH = pathResolver.shared(
  'observability/mission-control/agent-runtime-events.jsonl'
);

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
  await dispatchNextQueuedMission(QUEUE_PATH, checkDependencies, async (missionId, tier) =>
    startMission(missionId, tier as any)
  );
}

async function createMission(
  id: string,
  tier: 'personal' | 'confidential' | 'public' = 'confidential',
  tenantId: string = 'default',
  missionType: string = 'development',
  visionRef?: string,
  persona: string = 'Ecosystem Architect',
  relationships: any = {}
) {
  return _createMission({
    id,
    tier,
    tenantId,
    missionType,
    visionRef,
    persona,
    relationships,
    rootDir: ROOT_DIR,
  });
}

/**
 * 4.5. Mission Directory Search Helper
 * Returns only the active tier directories (personal, confidential, public)
 * from mission-management-config.json — excludes archive, exports, and ledger paths.
 */
async function startMission(
  id: string,
  tier: 'personal' | 'confidential' | 'public' = 'confidential',
  persona: string = 'Ecosystem Architect',
  tenantId: string = 'default',
  missionType: string = 'development',
  visionRef?: string,
  relationships: any = {}
) {
  await _startMission({
    id,
    tier,
    persona,
    tenantId,
    missionType,
    visionRef,
    relationships,
    rootDir: ROOT_DIR,
  });
  const targetId = id.toUpperCase();
  const state = loadState(targetId);
  if (state?.status === 'active') {
    writeFocusedMissionId(targetId);
  }
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

async function recordEvidence(
  missionId: string,
  taskId: string,
  note: string,
  evidence?: string[],
  teamRole?: string,
  actorId?: string,
  actorType?: 'agent' | 'human' | 'service'
) {
  return _recordEvidence({
    missionId,
    taskId,
    note,
    evidence,
    teamRole,
    actorId,
    actorType,
    getGitHash,
    syncProjectLedgerIfLinked,
  });
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
    const statusIcon =
      {
        active: '🟢',
        planned: '⚪',
        completed: '✅',
        paused: '⏸️ ',
        failed: '❌',
        validating: '🔍',
        distilling: '🧠',
        archived: '📦',
      }[m.status] || '  ';
    console.log(
      `${m.id.padEnd(30)} ${statusIcon} ${m.status.padEnd(10)} ${m.tier.padEnd(14)} ${String(m.checkpoints).padStart(3)} ${m.lastEvent}`
    );
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
    console.log(
      `  Delegated:   ${state.delegation.agent_id} (${state.delegation.verification_status})`
    );
  }

  if (state.relationships?.prerequisites?.length) {
    console.log(`  Prereqs:     ${state.relationships.prerequisites.join(', ')}`);
  }
  if (state.relationships?.project) {
    console.log(`  Project:     ${state.relationships.project.project_id || '-'}`);
    console.log(`  Relation:    ${state.relationships.project.relationship_type}`);
    console.log(`  Gate Impact: ${state.relationships.project.gate_impact || 'none'}`);
  }
  if (state.relationships?.track) {
    console.log(`  Track:       ${state.relationships.track.track_id || '-'}`);
    if (state.relationships.track.track_name) {
      console.log(`  Track Name:  ${state.relationships.track.track_name}`);
    }
    console.log(`  Track Rel:   ${state.relationships.track.relationship_type}`);
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
  create   <ID>                  Create a new mission (status: planned)
  start    <ID>                  Activate a mission (planned/paused/failed → active)
  checkpoint [task_id] [note]    Record a checkpoint on the focused mission
  checkpoint <ID> <task_id> <note>
                                 Record a checkpoint on an explicit mission
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
  record-evidence <ID> <task_id> <note>
                                 Append an execution-ledger evidence entry and commit it
  purge    [--execute]            Preview stale missions to archive (--execute to apply)
  sync                           Sync mission registry

Typical Workflow:
  start → checkpoint (repeat) → verify → distill → finish

Mission Input Contract:
  Positionals:
    <ID>                         Only the mission ID should be positional for create/start
  Preferred named options:
    --tier <personal|confidential|public>
    --tenant-id <TENANT>
    --mission-type <TYPE>
    --vision-ref <REF>
    --persona <NAME>
    --dry-run
    --relationships <JSON>
    --relationships-file <PATH>
    --mission-id <ID>            Explicit mission target for checkpoint

  Validation:
    Linked project missions must point to a project_path whose 04_control ledger
    is writable under the current authority. Unsafe targets like libs/core will fail fast.

Project Traceability Options:
  --project-id <ID>              Link mission to a project identifier
  --project-path <PATH>          Record the related project-os path
  --project-relationship <TYPE>  belongs_to | supports | governs | independent
  --affected-artifacts <CSV>     Comma-separated project artifacts impacted by the mission
  --gate-impact <TYPE>           none | informational | review_required | blocking
  --traceability-refs <CSV>      Comma-separated evidence or document refs
  --project-note <TEXT>          Free-text note for the project relationship

Track Traceability Options:
  --track-id <ID>                Link mission to a project track identifier
  --track-name <NAME>            Human-readable track name
  --track-type <TYPE>            delivery | release | change | incident | operations | governance
  --lifecycle-model <MODEL>      Track lifecycle profile (for example default-sdlc)
  --track-relationship <TYPE>    belongs_to | supports | governs | independent
  --track-traceability-refs <CSV> Comma-separated track-level refs
  --track-note <TEXT>            Free-text note for the track relationship
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
  const hasDryRun = process.argv.includes('--dry-run');

  switch (action) {
    case 'create': {
      const input = validateMissionStartCreateInput('create', arg1);
      if (hasDryRun) {
        console.log(
          JSON.stringify(
            {
              action: 'create',
              mission_id: arg1,
              input,
            },
            null,
            2
          )
        );
        break;
      }
      await createMission(
        arg1,
        input.tier as any,
        input.tenantId,
        input.missionType,
        input.visionRef,
        input.persona,
        input.relationships
      );
      break;
    }
    case 'start': {
      const input = validateMissionStartCreateInput('start', arg1);
      if (hasDryRun) {
        console.log(
          JSON.stringify(
            {
              action: 'start',
              mission_id: arg1,
              input,
            },
            null,
            2
          )
        );
        break;
      }
      await startMission(
        arg1,
        input.tier as any,
        input.persona,
        input.tenantId,
        input.missionType,
        input.visionRef,
        input.relationships
      );
      break;
    }
    case 'grant':
      await grantMissionAccess(arg1, arg2, arg3 ? parseInt(arg3) : undefined);
      break;
    case 'sudo':
      await grantMissionSudo(arg1, arg2 !== 'OFF', arg3 ? parseInt(arg3) : undefined);
      break;
    case 'checkpoint':
      {
        const explicitMissionId = getOptionValue('--mission-id') || getOptionValue('--mission');
        if (explicitMissionId) {
          await createCheckpoint(arg1 || 'manual', arg2 || 'progress update', explicitMissionId);
        } else if (arg3) {
          await createCheckpoint(arg2 || 'manual', arg3 || 'progress update', arg1);
        } else {
          await createCheckpoint(arg1 || 'manual', arg2 || 'progress update');
        }
      }
      break;
    case 'delegate':
      await delegateMission(arg1, arg2, arg3);
      break;
    case 'import':
      await importMission(arg1, arg2);
      break;
    case 'verify':
      await verifyMission(arg1, arg2 as any, arg3);
      break;
    case 'distill':
      await distillMission(arg1);
      break;
    case 'seal':
      await sealMission(arg1);
      break;
    case 'enqueue':
      await enqueueMission(arg1, arg2!, parseInt(arg3 || '5'), arg4 ? arg4.split(',') : []);
      break;
    case 'dispatch':
      await dispatchNextMission();
      break;
    case 'finish':
      await finishMission(arg1, process.argv.includes('--seal'));
      break;
    case 'resume':
      await resumeMission(arg1);
      break;
    case 'record-task':
      await recordTask(arg1, arg2, JSON.parse(positionalArgs[3] || '{}'));
      break;
    case 'record-evidence':
      await recordEvidence(
        arg1,
        arg2 || 'manual',
        arg3 || 'evidence recorded',
        parseCsvOption('--evidence'),
        getOptionValue('--team-role'),
        getOptionValue('--actor-id'),
        getOptionValue('--actor-type') as any
      );
      break;
    case 'purge':
      await purgeMissions(!process.argv.includes('--execute'));
      break;
    case 'list':
      listMissions(arg1);
      break;
    case 'status':
      showMissionStatus(arg1);
      break;
    case 'sync-project-ledger':
      await syncProjectLedger(arg1);
      break;
    case 'team':
      showMissionTeam(arg1, hasRefresh);
      break;
    case 'staff':
      await staffMissionTeam(arg1);
      break;
    case 'prewarm':
      await prewarmMissionTeam(arg1, arg2);
      break;
    case 'sync':
      logger.info('Syncing mission registry...');
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      showHelp();
  }
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
