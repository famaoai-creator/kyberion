/**
 * scripts/refactor/mission-creation.ts
 * Mission creation and activation helpers.
 */

import * as path from 'node:path';
import {
  composeMissionTeamPlan,
  customerResolver,
  resolveCompany,
  findMissionPath,
  initializeMissionTeamBindings,
  ledger,
  logger,
  missionDir as resolveMissionDir,
  pathResolver,
  inferMissionOutcomeContract,
  ensureDefaultTenantProfile,
  loadOrganizationProfile,
  resolveMissionWorkflowDesign,
  resolveMissionReviewDesign,
  consumeIntentGoalHandoff,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  transitionStatus,
  withExecutionContext,
  writeMissionTeamPlan,
  buildCompanyVisionRef,
} from '@agent/core';
import { readJsonFile } from './cli-input.js';
import { getCurrentBranch, getGitHash, initMissionRepo } from './mission-git.js';
import { applyProcessTemplatePlan } from './mission-process-planning.js';
import {
  calculateRequiredTier,
  checkPrerequisites,
  loadState,
  normalizeRelationships,
  saveState,
  type KnowledgeInjectionDeclaration,
} from './mission-state.js';
import { syncRoleProcedure } from './mission-governance.js';
import { emitMissionLifecycleIntentSnapshot } from './mission-intent-delta.js';
import type { MissionState } from './mission-types.js';

const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

function normalizeTenantSlug(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  return TENANT_SLUG_RE.test(trimmed) ? trimmed : undefined;
}

export interface MissionVisionRefSummary {
  raw: string;
  kind: 'company' | 'vision' | 'legacy';
  tenant_slug: string | null;
  path: string | null;
  query: string | null;
}

export function parseMissionVisionRef(
  inputVisionRef: string | undefined | null,
  tenantSlug?: string | undefined
): MissionVisionRefSummary | null {
  const raw = String(inputVisionRef || '').trim();
  if (!raw) return null;

  if (raw.startsWith('company://')) {
    const remainder = raw.slice('company://'.length);
    const [pathPart, queryPart] = remainder.split('?', 2);
    const [parsedTenantSlug, ...segments] = pathPart.split('/').filter(Boolean);
    return {
      raw,
      kind: 'company',
      tenant_slug: normalizeTenantSlug(parsedTenantSlug || tenantSlug || undefined) || null,
      path: segments.length ? segments.join('/') : 'vision',
      query: queryPart || null,
    };
  }

  if (raw.startsWith('vision://')) {
    const remainder = raw.slice('vision://'.length);
    const [pathPart, queryPart] = remainder.split('?', 2);
    return {
      raw,
      kind: 'vision',
      tenant_slug: normalizeTenantSlug(tenantSlug || undefined) || null,
      path: pathPart || null,
      query: queryPart || null,
    };
  }

  return {
    raw,
    kind: 'legacy',
    tenant_slug: normalizeTenantSlug(tenantSlug || undefined) || null,
    path: null,
    query: null,
  };
}

export function normalizeMissionVisionRef(
  inputVisionRef: string | undefined,
  tenantSlug: string | undefined,
  rootDir: string
): string {
  const raw = String(inputVisionRef || '').trim();
  if (raw.startsWith('company://') || raw.startsWith('vision://')) {
    return raw;
  }

  const company = resolveCompany(
    tenantSlug || customerResolver.activeCustomer() || 'default',
    rootDir
  );
  const structuredRef = buildCompanyVisionRef(company.tenant_slug);
  if (!raw) {
    return structuredRef;
  }

  return `${structuredRef}?source=${encodeURIComponent(raw)}`;
}

export async function createMission(args: {
  id: string;
  tier?: 'personal' | 'confidential' | 'public';
  tenantId?: string;
  /**
   * Tenant slug for multi-tenant deployments. When set (and matches the
   * `^[a-z][a-z0-9-]{1,30}$` pattern), the resulting mission-state.json
   * will carry `tenant_slug` so tier-guard and audit-chain enforce
   * cross-tenant isolation.
   */
  tenantSlug?: string;
  missionType?: string;
  visionRef?: string;
  persona?: string;
  relationships?: any;
  rootDir: string;
}): Promise<void> {
  const {
    id,
    tier = 'confidential',
    tenantId = 'default',
    tenantSlug: rawTenantSlug,
    missionType = 'development',
    visionRef,
    persona = 'worker',
    relationships = {},
    rootDir,
  } = args;
  const tenantSlug = normalizeTenantSlug(rawTenantSlug);
  if (rawTenantSlug && !tenantSlug) {
    throw new Error(
      `[mission-creation] invalid tenant slug '${rawTenantSlug}'; must match ^[a-z][a-z0-9-]{1,30}$`
    );
  }
  withExecutionContext(
    'knowledge_steward',
    () => ensureDefaultTenantProfile(),
    'ecosystem_architect'
  );

  const upperId = id.toUpperCase();
  assertValidMissionId(upperId);
  const isEphemeral = process.argv.includes('--ephemeral');
  // IL-01: the surface passes the interpreted intent (utterance + agreed goal)
  // via a governed tmp handoff file; consume (read + delete) it here so the
  // outcome contract reflects the real request. Same process.argv pattern as
  // --ephemeral above — the flag is process-scoped CLI input.
  const intentGoalFlagIndex = process.argv.indexOf('--intent-goal');
  const intentGoalPath =
    intentGoalFlagIndex >= 0 ? process.argv[intentGoalFlagIndex + 1] : undefined;
  const intentHandoff = intentGoalPath ? consumeIntentGoalHandoff(intentGoalPath) : null;
  const normalizedRelationships = normalizeRelationships(relationships);
  const organizationProfile = loadOrganizationProfile(rootDir);
  const templatePath = pathResolver.knowledge('product/governance/mission-templates.json');
  const templates = readJsonFile<{
    templates: Array<{
      name?: string;
      knowledge_injections?: KnowledgeInjectionDeclaration[];
      files: Array<{ content_template: string; path: string }>;
    }>;
  }>(templatePath).templates;
  const template = templates.find((entry: any) => entry.name === missionType) || templates[0];

  const finalTier = calculateRequiredTier(template.knowledge_injections || [], tier);
  const missionBaseDir = isEphemeral
    ? pathResolver.active('missions/ephemeral')
    : resolveMissionDir(upperId, finalTier);
  const missionDir = isEphemeral ? path.join(missionBaseDir, upperId) : missionBaseDir;

  if (!safeExistsSync(missionDir)) safeMkdir(missionDir, { recursive: true });
  if (safeExistsSync(path.join(missionDir, 'mission-state.json'))) {
    logger.info(`Mission ${upperId} already exists at ${missionDir}.`);
    return;
  }

  const gitBranch = getCurrentBranch(rootDir);
  const gitHash = getGitHash(rootDir);
  const now = new Date().toISOString();
  const owner = process.env.USER || 'famao';
  const resolvedVision = normalizeMissionVisionRef(visionRef, tenantSlug, rootDir);

  for (const file of template.files) {
    const content = file.content_template
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

  const teamPlan = composeMissionTeamPlan({
    missionId: upperId,
    missionType,
    tier: finalTier,
    assignedPersona: persona,
    organizationProfile,
  });
  writeMissionTeamPlan(missionDir, teamPlan);
  initializeMissionTeamBindings(missionDir, teamPlan);

  // MO-01: the policy-driven classification (not the free-string mission_type)
  // is the authoritative record; the selected workflow template drives the
  // process phases. Both are persisted into mission-state.json below.
  const classification = teamPlan.mission_classification;
  const workflowDesign = classification
    ? resolveMissionWorkflowDesign({
        missionClass: classification.mission_class,
        deliveryShape: classification.delivery_shape,
        riskProfile: classification.risk_profile,
        stage: classification.stage,
        executionShape: 'mission',
        missionTypeHint: missionType,
      })
    : undefined;
  if (classification && workflowDesign) {
    const taskBoardPath = path.join(missionDir, 'TASK_BOARD.md');
    if (safeExistsSync(taskBoardPath)) {
      const board = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
      const headerLine =
        `> Class: \`${classification.mission_class}\` (risk: ${classification.risk_profile}) · ` +
        `Process: \`${workflowDesign.workflow_id}\` — ${workflowDesign.phases.join(' → ')}`;
      const lines = board.split('\n');
      lines.splice(1, 0, '', headerLine);
      safeWriteFile(taskBoardPath, lines.join('\n'));
    }

    // The task-board header is a one-line summary; this is the queryable
    // record of how the mission is meant to proceed (workflow pattern/phases
    // + review mode), so later tooling and humans don't have to re-derive it
    // from the classification inputs.
    const reviewDesign = resolveMissionReviewDesign({
      missionClass: classification.mission_class,
      deliveryShape: classification.delivery_shape,
      riskProfile: classification.risk_profile,
      workflowPattern: workflowDesign.pattern,
      stage: classification.stage,
    });
    safeWriteFile(
      path.join(missionDir, 'mission-workflow.json'),
      JSON.stringify(
        { classification, workflow_design: workflowDesign, review_design: reviewDesign },
        null,
        2
      )
    );
  }

  // MO-01: when the selected process template declares per-phase default
  // tasks, expand them deterministically into NEXT_TASKS.json + gate
  // definitions so the phases are executable, not just labels.
  if (workflowDesign?.phase_specs) {
    const planResult = applyProcessTemplatePlan({
      missionId: upperId,
      missionDir,
      design: workflowDesign,
    });
    if (planResult.tasks.length > 0) {
      logger.info(
        `📋 [Process] Expanded ${workflowDesign.workflow_id} into ${planResult.tasks.length} tasks (${planResult.gatePaths.length} gates).`
      );
    }
  }

  const evidenceDir = path.join(missionDir, 'evidence');
  if (!safeExistsSync(evidenceDir)) {
    safeMkdir(evidenceDir, { recursive: true });
    safeWriteFile(path.join(evidenceDir, '.gitkeep'), '');
    logger.info(`📁 [Architecture] Created evidence directory for mission ${upperId}.`);
  }

  if (!isEphemeral) {
    initMissionRepo(missionDir, upperId);
  }

  // Initialize volatile working-memory faces (MEMORY.md + NOW.md with sidecar)
  try {
    const { initMissionMemory } = await import(
      pathResolver.rootResolve('dist/libs/actuators/working-memory-actuator/src/index.js')
    );
    initMissionMemory({ missionId: upperId, tier: finalTier });
    logger.info(`📝 [WorkingMemory] Volatile memory faces initialized for ${upperId}.`);
  } catch {
    // Best-effort: working-memory-actuator may not be compiled yet
  }

  const missionGitHash = !isEphemeral ? getGitHash(missionDir) : 'ephemeral';
  const missionBranch = !isEphemeral ? getCurrentBranch(missionDir) : 'ephemeral';
  const initialState: MissionState & { is_ephemeral?: boolean } = {
    mission_id: upperId,
    mission_type: missionType,
    ...(classification ? { classification } : {}),
    ...(workflowDesign
      ? {
          process_template: {
            workflow_id: workflowDesign.workflow_id,
            pattern: workflowDesign.pattern,
            phases: workflowDesign.phases,
            ...(workflowDesign.phase_specs ? { phase_specs: workflowDesign.phase_specs } : {}),
          },
        }
      : {}),
    tier: finalTier,
    status: 'planned',
    execution_mode: 'local',
    is_ephemeral: isEphemeral,
    relationships: normalizedRelationships,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    ...(intentHandoff?.correlation_id ? { correlation_id: intentHandoff.correlation_id } : {}),
    ...(intentHandoff?.origin_intent_id
      ? { origin_intent_id: intentHandoff.origin_intent_id }
      : {}),
    ...(intentHandoff?.origin_utterance_ref
      ? { origin_utterance_ref: intentHandoff.origin_utterance_ref }
      : {}),
    priority: 3,
    assigned_persona: persona,
    confidence_score: 1.0,
    git: {
      branch: missionBranch,
      start_commit: missionGitHash,
      latest_commit: missionGitHash,
      checkpoints: [],
    },
    outcome_contract: inferMissionOutcomeContract({
      missionId: upperId,
      missionType,
      visionRef: resolvedVision,
      ...(intentHandoff
        ? {
            intentGoal: {
              source_text: intentHandoff.source_text,
              summary: intentHandoff.goal?.summary,
              success_condition: intentHandoff.goal?.success_condition,
            },
          }
        : {}),
    }),
    ...(intentHandoff
      ? {
          intent: {
            source_text: intentHandoff.source_text,
            goal_summary: intentHandoff.goal?.summary,
            success_condition: intentHandoff.goal?.success_condition,
            outcome_ids: intentHandoff.outcome_ids,
          },
        }
      : {}),
    history: [
      {
        ts: now,
        event: 'CREATE',
        note: `Mission created in ${finalTier} tier ${isEphemeral ? '(Ephemeral Mode)' : '(Independent Micro-Repo)'}.`,
      },
    ],
  };
  await saveState(upperId, initialState);
  await emitMissionLifecycleIntentSnapshot({
    missionId: upperId,
    stage: 'intake',
    text:
      intentHandoff?.goal?.summary ||
      intentHandoff?.source_text ||
      resolvedVision ||
      `Mission ${upperId} (${missionType})`,
    source: intentHandoff ? 'user_prompt' : 'mission_state',
    traceRef: intentHandoff?.correlation_id,
  });

  ledger.record('MISSION_CREATE', {
    mission_id: upperId,
    tier: finalTier,
    type: missionType,
    persona,
    owner,
    is_ephemeral: isEphemeral,
  });

  logger.success(
    `🚀 Mission ${upperId} initialized in ${finalTier} tier from template "${template.name}" (ADF-driven${isEphemeral ? ', Ephemeral' : ''}).`
  );
}

const MISSION_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;

/**
 * Mission ids become directory names, git branch material, and task-id
 * prefixes — whitespace or shell-split accidents must fail at creation, not
 * surface later as broken mission dirs.
 */
export function assertValidMissionId(missionId: string): void {
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new Error(
      `[mission-creation] invalid mission id '${missionId}'; must match ${MISSION_ID_PATTERN.source} (no spaces — check shell quoting)`
    );
  }
}

export async function startMission(args: {
  id: string;
  tier?: 'personal' | 'confidential' | 'public';
  persona?: string;
  tenantId?: string;
  tenantSlug?: string;
  missionType?: string;
  visionRef?: string;
  relationships?: any;
  rootDir: string;
}): Promise<void> {
  const {
    id,
    tier = 'confidential',
    persona = 'worker',
    tenantId = 'default',
    tenantSlug,
    missionType = 'development',
    visionRef,
    relationships = {},
    rootDir,
  } = args;

  if (!id) {
    logger.error(
      'Usage: mission_controller start <MISSION_ID> [--tier <personal|confidential|public>]'
    );
    logger.info(
      '  Preferred: use named options for tier, persona, type, vision, relationships, and --dry-run.'
    );
    return;
  }

  checkPrerequisites();
  const upperId = id.toUpperCase();
  const normalizedRelationships = normalizeRelationships(relationships);

  let state = loadState(upperId);
  const finalTier = state ? state.tier : tier;

  const force = process.argv.includes('--force');
  if (!force) {
    const prereqs = state?.relationships?.prerequisites || normalizedRelationships?.prerequisites;
    if (prereqs) {
      const missing = prereqs.filter((pre) => {
        const preState = loadState(pre);
        return !preState || preState.status !== 'completed';
      });
      if (missing.length > 0) {
        logger.error(
          `🚨 Cannot start mission ${upperId}. Prerequisites not met: ${missing.join(', ')}`
        );
        logger.info('Use --force to bypass this check.');
        return;
      }
    }
  }

  logger.info(`🚀 Activating Mission: ${upperId} (Tier: ${finalTier})...`);

  try {
    if (!state) {
      await createMission({
        id: upperId,
        tier: finalTier,
        tenantId,
        ...(tenantSlug ? { tenantSlug } : {}),
        missionType,
        visionRef,
        persona,
        relationships: normalizedRelationships,
        rootDir,
      });
      state = loadState(upperId);
      if (state) {
        state.status = transitionStatus(state.status, 'active');
        state.history.push({
          ts: new Date().toISOString(),
          event: 'ACTIVATE',
          note: 'Mission activated.',
        });
        await saveState(upperId, state);
      }
    } else {
      if (!state.outcome_contract) {
        state.outcome_contract = inferMissionOutcomeContract({
          missionId: upperId,
          missionType: state.mission_type,
          visionRef: state.vision_ref,
        });
      }
      // MO-01 backward compatibility: missions created before classification
      // persistence get lazily classified on activation.
      if (!state.classification) {
        try {
          const { resolveMissionClassification } = await import('@agent/core');
          const classification = resolveMissionClassification({
            missionTypeHint: state.mission_type,
            shape: 'mission',
            utterance: `${state.mission_type || ''} ${state.vision_ref || ''}`.trim(),
          });
          state.classification = classification;
          state.process_template = (() => {
            const workflow = resolveMissionWorkflowDesign({
              missionClass: classification.mission_class,
              deliveryShape: classification.delivery_shape,
              riskProfile: classification.risk_profile,
              stage: classification.stage,
              executionShape: 'mission',
              missionTypeHint: state.mission_type,
            });
            return {
              workflow_id: workflow.workflow_id,
              pattern: workflow.pattern,
              phases: workflow.phases,
              ...(workflow.phase_specs ? { phase_specs: workflow.phase_specs } : {}),
            };
          })();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[mission-creation] lazy classification failed for ${upperId}: ${message}`);
        }
      }
      if (normalizedRelationships.project) {
        state.relationships = {
          ...(state.relationships || {}),
          project: {
            ...(state.relationships?.project || {}),
            ...normalizedRelationships.project,
          },
        };
      }
      if (normalizedRelationships.track) {
        state.relationships = {
          ...(state.relationships || {}),
          track: {
            ...(state.relationships?.track || {}),
            ...normalizedRelationships.track,
          },
        };
      }
      state.status = transitionStatus(state.status, 'active');
      state.history.push({
        ts: new Date().toISOString(),
        event: 'RESUME',
        note: 'Mission resumed.',
      });
      await saveState(upperId, state);
    }

    await emitMissionLifecycleIntentSnapshot({
      missionId: upperId,
      stage: 'intake',
      text:
        state?.intent?.goal_summary ||
        state?.intent?.source_text ||
        visionRef ||
        `Start mission ${upperId} (${missionType})`,
      source: 'mission_state',
      traceRef: state?.correlation_id,
    });

    const missionPath = findMissionPath(upperId);
    if (missionPath) {
      initMissionRepo(missionPath);
    }

    syncRoleProcedure(upperId, persona);

    ledger.record('MISSION_ACTIVATE', {
      mission_id: upperId,
      branch: state?.git.branch || 'main',
      persona,
    });

    logger.success(`✅ Mission ${upperId} is now ACTIVE (Independent History).`);
  } catch (err: any) {
    logger.error(`Failed to start mission: ${err.message}`);
  }
}
