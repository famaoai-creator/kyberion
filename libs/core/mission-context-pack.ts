import type { ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileSchema } from './foundation/ajv.js';
import { nowIso } from './foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from './secure-io.js';
import {
  provisionMissionEntry,
  writeProvisionedJson,
  writeProvisionedText,
} from './mission-orchestration-journal.js';
import {
  findReusableArtifactOwnershipRecord,
  listArtifactOwnershipRecordsForProject,
  type ArtifactOwnershipRecord,
} from './artifact-registry.js';
import { findMissionPath, pathResolver } from './path-resolver.js';
import {
  loadProjectOperationalState,
  projectOperationalStatePath,
  type ProjectOperationalState,
} from './project-operational-state-registry.js';
import { loadProjectTrackRecord, type ProjectTrackRecord } from './project-track-registry.js';
import {
  getMissionTeamPlanPath,
  loadMissionTeamPlan,
  resolveMissionTeamPlan,
  type MissionTeamAssignment,
} from './mission-team-plan-composer.js';
import { getWorkItem, type WorkItem } from './work-coordination.js';
import { loadTaskSession, validateTaskSession, type TaskSession } from './task-session.js';
import { slugify } from './foundation/text.js';
import { compileScopedContextPack, type ContextSecurityScope } from './context-security-scope.js';
import { resolveFacets, type ResolvedFacets } from './facet-registry.js';
import {
  loadSkillResourceDescriptor,
  renderSkillResourceIndex,
  type SkillResourceDescriptor,
} from './skill-resource-loader.js';
import { isSkillAllowed } from './skill-plugin-loader.js';
import type { ScopeContext } from './scope-context.js';
import {
  knowledgeHintFragment,
  loadKnowledgeHintsIfPossible,
  organizationIdFromContext,
  resolveScopeBudget,
} from './mission-context-pack-knowledge.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import { loadMissionWorkItemDispatchManifestAtPath } from './mission-workitem-dispatch-manifest.js';
import { loadMissionWorkItemDispatchResponseSeedAtPath } from './mission-workitem-dispatch-response.js';
import type {
  BuildMissionContextPackInput,
  MissionContextPack,
  MissionContextPackArtifactHint,
  MissionContextPackFacets,
  MissionContextPackKnowledgeHint,
  MissionContextPackMissionSummary,
  MissionContextPackRecipient,
  MissionContextPackScope,
  MissionContextPackSource,
  MissionContextPackTaskGuidance,
  MissionContextRecipientKind,
  MissionStateSummary,
  MissionTier,
  ResolveMissionContextPackInput,
} from './mission-context-pack-types.js';

export type {
  BuildMissionContextPackInput,
  LoadKnowledgeHintsInput,
  MissionContextPack,
  MissionContextPackArtifactHint,
  MissionContextPackFacets,
  MissionContextPackKnowledgeHint,
  MissionContextPackMissionSummary,
  MissionContextPackPruningSummary,
  MissionContextPackProjectSummary,
  MissionContextPackRecipient,
  MissionContextPackScope,
  MissionContextPackSource,
  MissionContextPackTaskGuidance,
  MissionContextPackTaskSessionSummary,
  MissionContextPackTrackSummary,
  MissionContextPackWorkItemSummary,
  MissionContextRecipientKind,
  MissionStateSummary,
  MissionTier,
  ResolveMissionContextPackInput,
} from './mission-context-pack-types.js';
export {
  deriveGovernancePhaseFromMissionState,
  loadKnowledgeHintsIfPossible,
  resolveScopeBudget,
  SCOPE_KNOWLEDGE_BUDGETS,
} from './mission-context-pack-knowledge.js';

const MISSION_STATE_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/mission-state.schema.json'
);
const MISSION_CONTEXT_PACK_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-context-pack.schema.json'
);

let missionStateValidateFn: ValidateFunction | null = null;
let missionContextPackValidateFn: ValidateFunction | null = null;

function ensureMissionStateValidator(): ValidateFunction {
  if (missionStateValidateFn) return missionStateValidateFn;
  missionStateValidateFn = compileSchema(MISSION_STATE_SCHEMA_PATH);
  return missionStateValidateFn;
}

function ensureMissionContextPackValidator(): ValidateFunction {
  if (missionContextPackValidateFn) return missionContextPackValidateFn;
  missionContextPackValidateFn = compileSchema(MISSION_CONTEXT_PACK_SCHEMA_PATH);
  return missionContextPackValidateFn;
}

function validationErrors(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function summarizeText(value: unknown, max = 180): string | undefined {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function estimatedChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value || '').length;
  }
}

function safeMissionPath(missionPath: string): string {
  return assertSafeRepositoryPath(missionPath, { allowMissingLeaf: true });
}

function safeMissionArtifactPath(missionPath: string, relativePath: string): string {
  const safeRoot = safeMissionPath(missionPath);
  return assertSafeRepositoryPath(path.join(safeRoot, relativePath), {
    allowMissingLeaf: true,
  });
}

function safeOptionalRepositoryPath(value: string): string | undefined {
  if (!value) return undefined;
  try {
    return assertSafeRepositoryPath(value, { allowMissingLeaf: true });
  } catch {
    return undefined;
  }
}

function mapTaskModelTier(
  tier?: MissionTeamAssignment['model_hint']['tier']
): 'fast' | 'standard' | 'deep' | undefined {
  if (!tier) return undefined;
  switch (tier) {
    case 'small':
      return 'fast';
    case 'standard':
      return 'standard';
    case 'large':
      return 'deep';
  }
}

function buildTaskGuidance(input: {
  missionState: MissionStateSummary;
  missionPath?: string;
  taskSession?: TaskSession | null;
  workItem?: WorkItem | null;
  missionTeamAssignment?: MissionTeamAssignment | null;
  artifactHints?: MissionContextPackArtifactHint[];
}): MissionContextPackTaskGuidance | undefined {
  // KP-04: task_guidance is generated for every model tier, not just `fast`
  // — the acceptance criteria / output contract / verification checklist is
  // just as useful to a standard/deep-tier worker. `standard` is the
  // fallback when no model hint resolved at all (no missionTeamAssignment),
  // since guidance content itself does not vary by tier here (the pruning
  // path already handles budget overflow for any tier).
  const modelTier = mapTaskModelTier(input.missionTeamAssignment?.model_hint?.tier) ?? 'standard';

  const successCriteria = [
    ...(input.missionState.outcome_contract?.success_criteria || []),
    ...(input.taskSession?.outcome_contract?.success_criteria || []),
  ]
    .map((entry) => String(entry).trim())
    .filter(Boolean);

  const workItemMetadata =
    input.workItem?.metadata && typeof input.workItem.metadata === 'object'
      ? (input.workItem.metadata as Record<string, unknown>)
      : null;
  const workItemCriteria = Array.isArray(workItemMetadata?.acceptance_criteria)
    ? workItemMetadata.acceptance_criteria.map((entry) => String(entry).trim()).filter(Boolean)
    : [];

  const acceptanceCriteria = Array.from(
    new Set(
      [
        ...successCriteria,
        input.workItem?.title ? `Deliver the work item outcome: ${input.workItem.title}` : '',
        input.workItem?.description
          ? `Preserve the work item scope: ${summarizeText(input.workItem.description, 160) || input.workItem.description}`
          : '',
        input.taskSession?.goal?.success_condition
          ? `Satisfy task session success condition: ${input.taskSession.goal.success_condition}`
          : '',
        ...workItemCriteria,
      ].filter(Boolean)
    )
  );

  const seed: string[] = [];
  if (workItemMetadata) {
    if (typeof workItemMetadata.target_path === 'string' && workItemMetadata.target_path.trim()) {
      seed.push(`Target path: ${workItemMetadata.target_path}`);
    }
    if (typeof workItemMetadata.deliverable === 'string' && workItemMetadata.deliverable.trim()) {
      seed.push(`Deliverable: ${workItemMetadata.deliverable}`);
    }
  }
  for (const artifactHint of (input.artifactHints || []).slice(0, 2)) {
    seed.push(`Reference artifact: ${artifactHint.artifact_id} (${artifactHint.kind})`);
    if (artifactHint.path) seed.push(`Artifact path: ${artifactHint.path}`);
    if (artifactHint.evidence_refs?.length) {
      seed.push(`Evidence refs: ${artifactHint.evidence_refs.join(', ')}`);
    }
  }

  if (input.missionPath) {
    const dispatchManifestPath = safeMissionArtifactPath(
      input.missionPath,
      'evidence/workitem-dispatch-manifest.json'
    );
    if (safeExistsSync(dispatchManifestPath)) {
      try {
        const parsed = loadMissionWorkItemDispatchManifestAtPath(dispatchManifestPath);
        const currentItemId = input.workItem?.item_id;
        const currentTeamRole = String(
          input.workItem?.metadata && typeof input.workItem.metadata === 'object'
            ? (input.workItem.metadata as Record<string, unknown>).team_role || ''
            : ''
        ).trim();
        const priorResponses = (parsed.records || [])
          .filter((record) => {
            const itemId = String(record.item_id || '').trim();
            if (!itemId || itemId === currentItemId) return false;
            if (!String(record.response_path || '').trim()) return false;
            const status = String(record.status || '')
              .trim()
              .toLowerCase();
            if (status && !['updated', 'done'].includes(status)) return false;
            const recordTeamRole = String(record.team_role || '').trim();
            if (currentTeamRole && recordTeamRole && recordTeamRole !== currentTeamRole)
              return false;
            return true;
          })
          .sort((left, right) =>
            String(
              right.reflected_at || right.written_at || right.response_path || ''
            ).localeCompare(
              String(left.reflected_at || left.written_at || left.response_path || '')
            )
          )
          .slice(0, 2);

        for (const record of priorResponses) {
          const responsePath = String(record.response_path || '').trim();
          const reflectionPath = String(record.reflection_path || '').trim();
          const safeResponsePath = safeOptionalRepositoryPath(responsePath);
          const safeReflectionPath = safeOptionalRepositoryPath(reflectionPath);
          if (!safeResponsePath) continue;
          const responseExcerpt = String(record.response_excerpt || '').trim();
          const recordTitle = String(record.title || '').trim();
          seed.push(`Prior work item response: ${safeResponsePath}`);
          if (safeReflectionPath) seed.push(`Prior reflection: ${safeReflectionPath}`);
          if (recordTitle) seed.push(`Prior work item: ${recordTitle}`);
          if (responseExcerpt)
            seed.push(
              `Prior response excerpt: ${summarizeText(responseExcerpt, 160) || responseExcerpt}`
            );
          if (safeExistsSync(safeResponsePath)) {
            try {
              const taskResult = loadMissionWorkItemDispatchResponseSeedAtPath(safeResponsePath);
              for (const artifact of (taskResult?.artifacts || []).slice(0, 3)) {
                const artifactPath = artifact.path.trim();
                if (safeOptionalRepositoryPath(artifactPath)) {
                  seed.push(
                    `Prior artifact: ${artifactPath}${artifact.kind ? ` (${artifact.kind})` : ''}`
                  );
                }
              }
              const summary = taskResult?.summary?.trim() || '';
              if (summary) {
                seed.push(`Prior task summary: ${summarizeText(summary, 180) || summary}`);
              }
            } catch {
              // Best-effort seed enrichment only.
            }
          }
        }
      } catch {
        // Best-effort seed enrichment only.
      }
    }
  }

  return {
    model_tier: modelTier,
    acceptance_criteria:
      acceptanceCriteria.length > 0
        ? acceptanceCriteria
        : ['Complete the assigned work item with no scope expansion.'],
    output_contract:
      'Return a schema-forced result. Prefer structured JSON if an output schema is available; do not answer with free-form prose when a schema or artifact contract exists.',
    verification: [
      'Run the narrowest applicable validation or test before claiming completion.',
      'If the output does not satisfy the required schema or artifact contract, repair it before reporting success.',
      'Treat unresolved gaps as blockers instead of assuming the missing facts.',
    ],
    ...(seed.length > 0 ? { seed } : {}),
  };
}

function truncateText(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function clonePack(pack: MissionContextPack): MissionContextPack {
  return JSON.parse(JSON.stringify(pack)) as MissionContextPack;
}

function buildRollupSummary(pack: MissionContextPack, prunedSections: string[]): string {
  const lines = [
    `Mission context rollup for ${pack.scope.mission_id}`,
    `- Pack ID: ${pack.context_pack_id}`,
    `- Recipient: ${pack.recipient.kind}${pack.recipient.team_role ? ` / role=${pack.recipient.team_role}` : ''}`,
    `- Scope: tier=${pack.scope.tier}${pack.scope.tenant_slug ? `; tenant=${pack.scope.tenant_slug}` : ''}${pack.scope.organization_id ? `; organization=${pack.scope.organization_id}` : ''}${pack.scope.project_id ? `; project=${pack.scope.project_id}` : ''}${pack.scope.track_id ? `; track=${pack.scope.track_id}` : ''}${pack.scope.work_item_id ? `; work_item=${pack.scope.work_item_id}` : ''}`,
    `- Pruned sections: ${prunedSections.length > 0 ? prunedSections.join(', ') : 'none'}`,
  ];
  if (pack.project?.summary)
    lines.push(
      `- Project summary: ${summarizeText(pack.project.summary, 220) || pack.project.summary}`
    );
  if (pack.track?.summary)
    lines.push(`- Track summary: ${summarizeText(pack.track.summary, 220) || pack.track.summary}`);
  if (pack.task_session?.goal?.summary)
    lines.push(
      `- Task goal: ${summarizeText(pack.task_session.goal.summary, 180) || pack.task_session.goal.summary}`
    );
  if (pack.work_item?.title) lines.push(`- Work item: ${pack.work_item.title}`);
  return lines.join('\n');
}

function writeMissionContextRollup(
  missionPath: string | undefined,
  pack: MissionContextPack,
  rollupSummary: string
): string | undefined {
  if (!missionPath) return undefined;
  const targetDir = safeMissionArtifactPath(missionPath, 'coordination/context-rollups');
  if (!safeExistsSync(targetDir)) safeMkdir(targetDir, { recursive: true });
  const filePath = safeMissionArtifactPath(
    missionPath,
    `coordination/context-rollups/${pack.context_pack_id}.md`
  );
  writeProvisionedText({
    missionId: pack.scope.mission_id,
    filePath,
    targetPath: path.relative(missionPath, filePath).split(path.sep).join('/'),
    missionPathHint: missionPath,
    provisioned: provisionMissionEntry(`${rollupSummary}\n`),
  });
  return filePath;
}

function pruneMissionContextPack(
  pack: MissionContextPack,
  budgetChars?: number,
  missionPath?: string
): MissionContextPack {
  const budget = typeof budgetChars === 'number' && budgetChars > 0 ? budgetChars : 6000;
  const working = clonePack(pack);
  const originalEstimate = estimatedChars(working);
  const prunedSections: string[] = [];
  const keptSections = ['scope', 'recipient', 'mission', 'sources', 'redactions', 'delivery'];

  if (originalEstimate <= budget) {
    const rollupSummary = buildRollupSummary(working, []);
    const rollupPath = writeMissionContextRollup(missionPath, working, rollupSummary);
    return {
      ...working,
      pruning: {
        budget_chars: budget,
        estimated_chars: originalEstimate,
        kept_sections: keptSections,
        pruned_sections: [],
        rollup_summary: rollupSummary,
        ...(rollupPath ? { rollup_path: rollupPath } : {}),
      },
    };
  }

  if (working.knowledge_hints && working.knowledge_hints.length > 3) {
    working.knowledge_hints = working.knowledge_hints.slice(0, 3);
    prunedSections.push('knowledge_hints');
  }
  if (working.artifact_hints && working.artifact_hints.length > 2) {
    working.artifact_hints = working.artifact_hints.slice(0, 2);
    if (!prunedSections.includes('artifact_hints')) prunedSections.push('artifact_hints');
  }

  working.project = working.project
    ? {
        ...working.project,
        summary: truncateText(working.project.summary, 260) || working.project.summary,
        knowledge_refs: working.project.knowledge_refs?.slice(0, 3),
        distill_targets: working.project.distill_targets?.slice(0, 3),
      }
    : working.project;

  working.track = working.track
    ? {
        ...working.track,
        summary: truncateText(working.track.summary, 220) || working.track.summary,
        required_artifacts: working.track.required_artifacts?.slice(0, 3),
      }
    : working.track;

  working.task_session = working.task_session
    ? {
        ...working.task_session,
        goal: {
          ...working.task_session.goal,
          summary:
            truncateText(working.task_session.goal.summary, 180) ||
            working.task_session.goal.summary,
        },
      }
    : working.task_session;

  working.work_item = working.work_item
    ? {
        ...working.work_item,
        description:
          truncateText(working.work_item.description, 220) || working.work_item.description,
        labels: working.work_item.labels.slice(0, 8),
        dependencies: working.work_item.dependencies.slice(0, 5),
      }
    : working.work_item;

  const prunedEstimate = estimatedChars(working);
  if (prunedEstimate > budget) {
    working.knowledge_hints = working.knowledge_hints?.slice(0, 1);
    working.artifact_hints = working.artifact_hints?.slice(0, 1);
    if (!prunedSections.includes('knowledge_hints')) prunedSections.push('knowledge_hints');
    if (!prunedSections.includes('artifact_hints')) prunedSections.push('artifact_hints');
  }

  const finalEstimate = estimatedChars(working);
  const rollupSummary = buildRollupSummary(working, prunedSections);
  const rollupPath = writeMissionContextRollup(missionPath, working, rollupSummary);

  return {
    ...working,
    pruning: {
      budget_chars: budget,
      estimated_chars: finalEstimate,
      kept_sections: keptSections,
      pruned_sections: prunedSections,
      rollup_summary: rollupSummary,
      ...(rollupPath ? { rollup_path: rollupPath } : {}),
    },
  };
}

function normalizeTier(tier: unknown, fallback: MissionTier = 'public'): MissionTier {
  return tier === 'personal' || tier === 'confidential' || tier === 'public' ? tier : fallback;
}

function buildContextPackId(input: {
  missionId: string;
  teamRole?: string;
  recipientKind?: MissionContextRecipientKind;
  workItemId?: string;
}): string {
  const parts = [
    'CPK',
    slugify(input.missionId.toUpperCase(), { separator: '-', fallback: 'MISSION' }).toUpperCase(),
  ];
  if (input.teamRole) {
    parts.push(slugify(input.teamRole, { separator: '-', fallback: 'role' }).toUpperCase());
  } else if (input.recipientKind) {
    parts.push(
      slugify(input.recipientKind, { separator: '-', fallback: 'recipient' }).toUpperCase()
    );
  }
  if (input.workItemId) {
    parts.push(slugify(input.workItemId, { separator: '-', fallback: 'item' }).toUpperCase());
  }
  parts.push(randomUUID().slice(0, 8).toUpperCase());
  return parts.join('-');
}

function missionStatePath(missionId: string, tier: MissionTier): string {
  const missionPath = findMissionPath(missionId) || pathResolver.missionDir(missionId, tier);
  return safeMissionArtifactPath(missionPath, 'mission-state.json');
}

function loadMissionState(missionId: string, tier: MissionTier): MissionStateSummary | null {
  const filePath = missionStatePath(missionId, tier);
  return loadMissionStateAtPath(filePath) as MissionStateSummary | null;
}

function missionContextSummary(input: {
  missionId: string;
  teamRole?: string;
  recipientKind?: MissionContextRecipientKind;
  projectId?: string;
  trackId?: string;
  workItemId?: string;
  taskSessionId?: string;
  tenantSlug?: string;
}): string {
  const parts = [`mission=${input.missionId}`];
  if (input.teamRole) parts.push(`role=${input.teamRole}`);
  if (input.recipientKind) parts.push(`recipient=${input.recipientKind}`);
  if (input.projectId) parts.push(`project=${input.projectId}`);
  if (input.trackId) parts.push(`track=${input.trackId}`);
  if (input.workItemId) parts.push(`work_item=${input.workItemId}`);
  if (input.taskSessionId) parts.push(`task_session=${input.taskSessionId}`);
  if (input.tenantSlug) parts.push(`tenant=${input.tenantSlug}`);
  return parts.join(' / ');
}

function defaultRedactions(): string[] {
  return [
    'full Kyberion knowledge corpus',
    'unrelated mission histories',
    'cross-tier data outside the current scope',
    'other team roles and non-selected runtime logs',
  ];
}

function serializeFacets(facets: ResolvedFacets): MissionContextPackFacets {
  const serialize = (facet: { name: string; source: string; content: string }) => ({
    name: facet.name,
    source: facet.source,
    content: facet.content,
  });
  return {
    ...(facets.persona ? { persona: serialize(facets.persona) } : {}),
    policies: facets.policies.map(serialize),
    instructions: facets.instructions.map(serialize),
    ...(facets.output_contract ? { output_contract: serialize(facets.output_contract) } : {}),
  };
}

function filterAllowedSkillResources(
  resources: readonly SkillResourceDescriptor[],
  scope: ScopeContext
): SkillResourceDescriptor[] {
  return resources.filter((resource) => isSkillAllowed(resource.name, scope).allowed);
}

function loadSkillResources(
  skillPaths: string[] | undefined,
  scope: ScopeContext,
  options: { trustResolved?: boolean } = {}
): SkillResourceDescriptor[] {
  const resources = [
    ...new Set((skillPaths || []).map((value) => String(value).trim()).filter(Boolean)),
  ]
    .sort()
    .map((skillPath) => loadSkillResourceDescriptor(skillPath, undefined, options));
  return filterAllowedSkillResources(resources, scope);
}

function missionSources(input: {
  missionId: string;
  missionPath?: string;
  missionTier: MissionTier;
  tenantSlug?: string;
  teamRole?: string;
  recipientKind?: MissionContextRecipientKind;
  projectId?: string;
  trackId?: string;
  taskSessionId?: string;
  workItemId?: string;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  taskSession?: TaskSession | null;
  workItem?: WorkItem | null;
  missionTeamAssignment?: MissionTeamAssignment | null;
  knowledgeHints?: MissionContextPackKnowledgeHint[];
  skillResources?: SkillResourceDescriptor[];
}): MissionContextPackSource[] {
  const sources: MissionContextPackSource[] = [
    {
      kind: 'mission_state',
      ref: `mission:${input.missionId}`,
      path: input.missionPath
        ? safeMissionArtifactPath(input.missionPath, 'mission-state.json')
        : missionStatePath(input.missionId, input.missionTier),
      summary: `Mission state for ${input.missionId}`,
      captured_at: nowIso(),
    },
  ];

  if (input.teamRole && input.missionTeamAssignment) {
    const teamPlanPath = getMissionTeamPlanPath(input.missionId);
    sources.push({
      kind: 'mission_team',
      ref: `mission-team:${input.missionId}:${input.teamRole}`,
      ...(teamPlanPath ? { path: teamPlanPath } : {}),
      summary: input.missionTeamAssignment.agent_id
        ? `Role ${input.teamRole} assigned to ${input.missionTeamAssignment.agent_id}`
        : `Role ${input.teamRole} is unfilled`,
      captured_at: nowIso(),
    });
  }

  if (input.projectId && input.projectState) {
    sources.push({
      kind: 'project_state',
      ref: `project:${input.projectId}`,
      path: projectOperationalStatePath(input.projectId, input.missionTier, input.tenantSlug),
      summary: `Project state for ${input.projectId}`,
      captured_at: nowIso(),
    });
  }

  if (input.trackId && input.trackRecord) {
    sources.push({
      kind: 'project_track',
      ref: `track:${input.trackId}`,
      path: pathResolver.shared(`runtime/project-tracks/${input.trackId}.json`),
      summary: `Project track record for ${input.trackId}`,
      captured_at: nowIso(),
    });
  }

  if (input.taskSessionId && input.taskSession) {
    sources.push({
      kind: 'task_session',
      ref: `task-session:${input.taskSessionId}`,
      path: pathResolver.shared(`runtime/task-sessions/${input.taskSessionId}.json`),
      summary: `Task session ${input.taskSessionId}`,
      captured_at: nowIso(),
    });
  }

  if (input.workItemId && input.workItem) {
    sources.push({
      kind: 'work_item',
      ref: `work-item:${input.workItemId}`,
      summary: `Work item ${input.workItemId}`,
      captured_at: nowIso(),
    });

    const metadata = input.workItem.metadata as Record<string, unknown> | undefined;
    const targetPaths = Array.isArray(metadata?.target_paths)
      ? metadata.target_paths.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    for (const targetPath of targetPaths.slice(0, 24)) {
      sources.push({
        kind: 'other',
        ref: `work-item-evidence:${targetPath}`,
        path: targetPath,
        summary: `Scoped review artifact for ${input.workItemId}: ${targetPath}`,
        captured_at: nowIso(),
      });
    }
    const verificationDone = Array.isArray(metadata?.verification_done)
      ? metadata.verification_done.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    for (const verification of verificationDone.slice(0, 16)) {
      sources.push({
        kind: 'other',
        ref: `work-item-verification:${input.workItemId}:${sources.length + 1}`,
        summary: `Scoped verification: ${verification}`,
        captured_at: nowIso(),
      });
    }
    const criterionEvidence = metadata?.criterion_evidence;
    if (criterionEvidence && typeof criterionEvidence === 'object') {
      sources.push({
        kind: 'other',
        ref: `work-item-criterion-evidence:${input.workItemId}`,
        summary: `Scoped criterion evidence: ${JSON.stringify(criterionEvidence).slice(0, 2200)}`,
        captured_at: nowIso(),
      });
    }
  }

  for (const hint of input.knowledgeHints || []) {
    sources.push({
      kind: 'knowledge_hint',
      ref: hint.path,
      path: hint.path,
      summary: hint.title,
      captured_at: nowIso(),
    });
  }

  for (const skill of input.skillResources || []) {
    sources.push({
      kind: 'skill_resource',
      ref: skill.name,
      path: skill.path,
      summary: skill.description,
      captured_at: nowIso(),
    });
  }

  return sources;
}

function missionAssignmentSummary(
  assignment: MissionTeamAssignment | null | undefined
): MissionContextPackRecipient {
  if (!assignment) {
    return {
      kind: 'subagent',
      notes: 'No mission team assignment was resolved; using subagent context.',
    };
  }
  return {
    kind: 'agent',
    team_role: assignment.team_role,
    agent_id: assignment.agent_id || undefined,
    authority_role: assignment.authority_role || undefined,
    provider: assignment.provider || undefined,
    modelId: assignment.modelId || undefined,
    delegation_contract: assignment.delegation_contract || undefined,
    required_capabilities: assignment.required_capabilities || undefined,
    notes: assignment.notes,
  };
}

function loadTaskSessionIfPossible(taskSessionId?: string | null): TaskSession | null {
  if (!taskSessionId) return null;
  const session = loadTaskSession(taskSessionId);
  if (!session) return null;
  const validation = validateTaskSession(session);
  return validation.valid ? session : null;
}

function loadProjectStateIfPossible(input: {
  projectId?: string;
  missionState: MissionStateSummary;
  workItem?: WorkItem | null;
  tier: MissionTier;
  tenantSlug?: string;
}): ProjectOperationalState | null {
  const candidates = [
    input.projectId,
    input.missionState.relationships?.project?.project_id,
    input.workItem?.project_id,
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  const projectId = candidates[0];
  if (!projectId) return null;
  const queryTier = normalizeTier(input.missionState.tier, input.tier);
  return loadProjectOperationalState(projectId, {
    tier: queryTier,
    tenantSlug: input.tenantSlug || input.missionState.tenant_slug,
  });
}

function loadTrackStateIfPossible(input: {
  trackId?: string;
  projectState?: ProjectOperationalState | null;
  missionState: MissionStateSummary;
}): ProjectTrackRecord | null {
  const candidate = String(
    input.trackId ||
      input.missionState.relationships?.track?.track_id ||
      input.projectState?.active_track_ids?.[0] ||
      ''
  ).trim();
  if (!candidate) return null;
  return loadProjectTrackRecord(candidate);
}

function loadArtifactHintsIfPossible(input: {
  missionState: MissionStateSummary;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  taskSession?: TaskSession | null;
  workItem?: WorkItem | null;
}): MissionContextPackArtifactHint[] {
  const projectId = String(
    input.projectState?.project_id ||
      input.missionState.relationships?.project?.project_id ||
      input.workItem?.project_id ||
      ''
  ).trim();
  if (!projectId) return [];

  const getQualityScore = (record: ArtifactOwnershipRecord): number => {
    const metadata = record.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 0;
    const score =
      metadata.quality_score ??
      metadata.qualityScore ??
      metadata.reuse_score ??
      metadata.reuseScore;
    if (typeof score === 'number' && Number.isFinite(score)) return score;
    if (typeof score === 'string' && score.trim()) {
      const parsed = Number(score);
      if (Number.isFinite(parsed)) return parsed;
    }
    const verdict =
      metadata.quality_verdict ??
      metadata.qualityVerdict ??
      metadata.review_gate_verdict ??
      metadata.reviewGateVerdict;
    if (typeof verdict === 'string') {
      const normalized = verdict.toLowerCase();
      if (
        normalized === 'promoted' ||
        normalized === 'ready' ||
        normalized === 'approved' ||
        normalized === 'ok'
      )
        return 100;
      if (normalized === 'warn' || normalized === 'concerns') return 50;
      if (normalized === 'blocked' || normalized === 'poor') return 0;
    }
    return 0;
  };

  const getQualityRank = (record: ArtifactOwnershipRecord): number => {
    const score = getQualityScore(record);
    if (score > 0) return score;
    const promoted =
      record.metadata?.promoted === true ||
      record.metadata?.promoted_at ||
      record.metadata?.final_gate_verdict;
    return promoted ? 1 : 0;
  };

  const preferredKinds = new Set<string>(
    [
      input.missionState.outcome_contract?.deliverable_kind,
      ...(input.trackRecord?.required_artifacts || []),
      input.taskSession?.artifact?.kind,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  const reuseCandidates = Array.from(preferredKinds)
    .map((kind) => findReusableArtifactOwnershipRecord({ projectId, kind }))
    .filter((record): record is ArtifactOwnershipRecord => Boolean(record));

  const allProjectRecords = listArtifactOwnershipRecordsForProject(projectId, {
    includeTmp: false,
  });
  const projectRecords = preferredKinds.size
    ? allProjectRecords.filter((record) => preferredKinds.has(record.kind))
    : allProjectRecords;
  const fallbackRecords = projectRecords.length > 0 ? projectRecords : allProjectRecords;

  const candidates = [...reuseCandidates, ...fallbackRecords]
    .filter(
      (record, index, all) =>
        all.findIndex((candidate) => candidate.artifact_id === record.artifact_id) === index
    )
    .sort((a, b) => {
      const qualityCompare = getQualityRank(b) - getQualityRank(a);
      if (qualityCompare !== 0) return qualityCompare;
      const createdAtCompare = String(b.created_at || '').localeCompare(String(a.created_at || ''));
      if (createdAtCompare !== 0) return createdAtCompare;
      return String(b.artifact_id || '').localeCompare(String(a.artifact_id || ''));
    })
    .slice(0, 3);

  return candidates.map((record) => ({
    artifact_id: record.artifact_id,
    kind: record.kind,
    storage_class: record.storage_class,
    ...(record.project_id ? { project_id: record.project_id } : {}),
    ...(record.mission_id ? { mission_id: record.mission_id } : {}),
    ...(record.task_session_id ? { task_session_id: record.task_session_id } : {}),
    ...(record.path ? { path: record.path } : {}),
    ...(record.external_ref ? { external_ref: record.external_ref } : {}),
    ...(record.created_at ? { created_at: record.created_at } : {}),
    ...(record.evidence_refs?.length ? { evidence_refs: [...record.evidence_refs] } : {}),
    reuse_reason: preferredKinds.has(record.kind)
      ? 'Reusable project artifact matching the current deliverable or track requirement.'
      : 'Reusable project artifact candidate for this mission context.',
  }));
}

export function buildMissionContextPack(input: BuildMissionContextPackInput): MissionContextPack {
  const missionStateValidate = ensureMissionStateValidator();
  if (!missionStateValidate(input.missionState)) {
    throw new Error(
      `Invalid mission state for context pack: ${validationErrors(missionStateValidate).join('; ')}`
    );
  }

  const missionTier = normalizeTier(input.missionState.tier);
  const missionPath = safeMissionPath(
    input.missionPath ||
      findMissionPath(input.missionState.mission_id) ||
      pathResolver.missionDir(input.missionState.mission_id, missionTier)
  );
  const projectId =
    input.projectState?.project_id ||
    input.missionState.relationships?.project?.project_id ||
    input.workItem?.project_id;
  const organizationId = organizationIdFromContext({
    missionState: input.missionState,
    projectState: input.projectState,
  });
  const trackId =
    input.trackRecord?.track_id ||
    input.missionState.relationships?.track?.track_id ||
    input.projectState?.active_track_ids?.[0];
  const taskSessionId = input.taskSession?.session_id || undefined;
  const workItemId = input.workItem?.item_id || undefined;
  const assignment = input.missionTeamAssignment || null;
  const artifactHints = loadArtifactHintsIfPossible({
    missionState: input.missionState,
    projectState: input.projectState,
    trackRecord: input.trackRecord,
    taskSession: input.taskSession,
    workItem: input.workItem,
  });
  const taskGuidance = buildTaskGuidance({
    missionState: input.missionState,
    missionPath,
    taskSession: input.taskSession,
    workItem: input.workItem,
    missionTeamAssignment: assignment,
    artifactHints,
  });
  const recipient = input.recipientKind
    ? {
        ...missionAssignmentSummary(assignment),
        kind: input.recipientKind,
      }
    : missionAssignmentSummary(assignment);

  const scope: MissionContextPackScope = {
    tier: missionTier,
    mission_id: input.missionState.mission_id,
    ...(input.missionState.tenant_slug ? { tenant_slug: input.missionState.tenant_slug } : {}),
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(trackId ? { track_id: trackId } : {}),
    ...(taskSessionId ? { task_session_id: taskSessionId } : {}),
    ...(workItemId ? { work_item_id: workItemId } : {}),
  };
  const securityScope: ContextSecurityScope = {
    tenant_slug: input.missionState.tenant_slug || input.missionState.tenant_id || 'default',
    tenant_id: input.missionState.tenant_id || input.missionState.tenant_slug || 'default',
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    mission_id: input.missionState.mission_id,
    ...(recipient.agent_id ? { participant_id: recipient.agent_id } : {}),
    read_tiers:
      missionTier === 'public'
        ? ['public']
        : missionTier === 'confidential'
          ? ['public', 'confidential']
          : ['public', 'personal'],
    write_tier: missionTier,
    purpose: input.teamRole || input.recipientKind || 'mission-execution',
    external_egress: missionTier === 'public' ? 'allow' : 'deny',
  };
  const facets = input.facets
    ? serializeFacets(
        resolveFacets(input.facets, {
          tier: missionTier,
          ...(input.missionState.tenant_slug ? { tenantSlug: input.missionState.tenant_slug } : {}),
        })
      )
    : undefined;
  const skillResources =
    input.skillResources && input.skillResources.length > 0
      ? filterAllowedSkillResources(input.skillResources, {
          tier: missionTier,
          mission_id: input.missionState.mission_id,
          ...(input.missionState.tenant_slug || input.missionState.tenant_id
            ? { tenant_slug: input.missionState.tenant_slug || input.missionState.tenant_id }
            : {}),
          ...(organizationId ? { organization_id: organizationId } : {}),
          ...(projectId ? { project_id: projectId } : {}),
        })
      : loadSkillResources(
          input.skillPaths,
          {
            tier: missionTier,
            mission_id: input.missionState.mission_id,
            ...(input.missionState.tenant_slug || input.missionState.tenant_id
              ? { tenant_slug: input.missionState.tenant_slug || input.missionState.tenant_id }
              : {}),
            ...(organizationId ? { organization_id: organizationId } : {}),
            ...(projectId ? { project_id: projectId } : {}),
          },
          { ...(input.trustResolved !== undefined ? { trustResolved: input.trustResolved } : {}) }
        );

  const mission: MissionContextPackMissionSummary = {
    mission_id: input.missionState.mission_id,
    mission_type: input.missionState.mission_type,
    tier: missionTier,
    status: input.missionState.status,
    assigned_persona: input.missionState.assigned_persona,
    ...(input.missionState.tenant_id ? { tenant_id: input.missionState.tenant_id } : {}),
    ...(input.missionState.tenant_slug ? { tenant_slug: input.missionState.tenant_slug } : {}),
    ...(input.missionState.vision_ref ? { vision_ref: input.missionState.vision_ref } : {}),
    ...(input.missionState.execution_mode
      ? { execution_mode: input.missionState.execution_mode }
      : {}),
    ...(typeof input.missionState.priority === 'number'
      ? { priority: input.missionState.priority }
      : {}),
    ...(typeof input.missionState.confidence_score === 'number'
      ? { confidence_score: input.missionState.confidence_score }
      : {}),
    ...(input.missionState.relationships
      ? { relationships: input.missionState.relationships }
      : {}),
    ...(input.missionState.context ? { context: input.missionState.context } : {}),
    ...(input.missionState.outcome_contract
      ? { outcome_contract: input.missionState.outcome_contract }
      : {}),
  };

  const project = input.projectState
    ? {
        project_id: input.projectState.project_id,
        name: input.projectState.name,
        summary: input.projectState.summary,
        status: input.projectState.status,
        tier: input.projectState.tier,
        ...(input.projectState.tenant_slug ? { tenant_slug: input.projectState.tenant_slug } : {}),
        ...(input.projectState.project_path
          ? { project_path: input.projectState.project_path }
          : {}),
        ...(input.projectState.current_phase
          ? { current_phase: input.projectState.current_phase }
          : {}),
        ...(input.projectState.active_track_ids
          ? { active_track_ids: [...input.projectState.active_track_ids] }
          : {}),
        ...(input.projectState.active_mission_ids
          ? { active_mission_ids: [...input.projectState.active_mission_ids] }
          : {}),
        ...(input.projectState.active_task_session_ids
          ? { active_task_session_ids: [...input.projectState.active_task_session_ids] }
          : {}),
        ...(input.projectState.source_refs
          ? { source_refs: [...input.projectState.source_refs] }
          : {}),
        ...(input.projectState.distill_targets
          ? { distill_targets: [...input.projectState.distill_targets] }
          : {}),
        ...(input.projectState.knowledge_refs
          ? { knowledge_refs: [...input.projectState.knowledge_refs] }
          : {}),
        ...(input.projectState.last_distilled_at
          ? { last_distilled_at: input.projectState.last_distilled_at }
          : {}),
      }
    : undefined;

  const track = input.trackRecord
    ? {
        track_id: input.trackRecord.track_id,
        project_id: input.trackRecord.project_id,
        name: input.trackRecord.name,
        summary: input.trackRecord.summary,
        status: input.trackRecord.status,
        track_type: input.trackRecord.track_type,
        lifecycle_model: input.trackRecord.lifecycle_model,
        tier: input.trackRecord.tier,
        ...(input.trackRecord.primary_locale
          ? { primary_locale: input.trackRecord.primary_locale }
          : {}),
        ...(input.trackRecord.release_id ? { release_id: input.trackRecord.release_id } : {}),
        ...(input.trackRecord.change_scope ? { change_scope: input.trackRecord.change_scope } : {}),
        ...(input.trackRecord.gate_profile_id
          ? { gate_profile_id: input.trackRecord.gate_profile_id }
          : {}),
        ...(input.trackRecord.active_missions
          ? { active_missions: [...input.trackRecord.active_missions] }
          : {}),
        ...(input.trackRecord.required_artifacts
          ? { required_artifacts: [...input.trackRecord.required_artifacts] }
          : {}),
      }
    : undefined;

  const taskSession = input.taskSession
    ? {
        session_id: input.taskSession.session_id,
        surface: input.taskSession.surface,
        task_type: input.taskSession.task_type,
        status: input.taskSession.status,
        mode: input.taskSession.mode,
        goal: {
          summary: input.taskSession.goal.summary,
          success_condition: input.taskSession.goal.success_condition,
        },
        ...(input.taskSession.project_context
          ? { project_context: input.taskSession.project_context }
          : {}),
        ...(input.taskSession.requirements ? { requirements: input.taskSession.requirements } : {}),
        ...(input.taskSession.artifact ? { artifact: input.taskSession.artifact } : {}),
        ...(input.taskSession.control ? { control: input.taskSession.control } : {}),
        ...(input.taskSession.outcome_contract
          ? { outcome_contract: input.taskSession.outcome_contract }
          : {}),
        updated_at: input.taskSession.updated_at,
      }
    : undefined;

  const workItem = input.workItem
    ? {
        item_id: input.workItem.item_id,
        title: input.workItem.title,
        description: input.workItem.description,
        status: input.workItem.status,
        priority: input.workItem.priority,
        source: input.workItem.source,
        source_ref: input.workItem.source_ref,
        project_id: input.workItem.project_id,
        ...(input.workItem.assignee_peer_id
          ? { assignee_peer_id: input.workItem.assignee_peer_id }
          : {}),
        ...(input.workItem.assignee_user_id
          ? { assignee_user_id: input.workItem.assignee_user_id }
          : {}),
        labels: [...input.workItem.labels],
        dependencies: [...input.workItem.dependencies],
        ...(input.workItem.metadata ? { metadata: { ...input.workItem.metadata } } : {}),
      }
    : undefined;

  const sources = missionSources({
    missionId: input.missionState.mission_id,
    missionPath,
    missionTier,
    tenantSlug: input.missionState.tenant_slug,
    teamRole: input.teamRole,
    recipientKind: recipient.kind,
    projectId,
    trackId,
    taskSessionId,
    workItemId,
    projectState: input.projectState,
    trackRecord: input.trackRecord,
    taskSession: input.taskSession,
    workItem: input.workItem,
    missionTeamAssignment: assignment,
    knowledgeHints: input.knowledgeHints,
    skillResources,
  });
  const summary = missionContextSummary({
    missionId: input.missionState.mission_id,
    teamRole: input.teamRole,
    recipientKind: recipient.kind,
    projectId,
    trackId,
    workItemId,
    taskSessionId,
    tenantSlug: input.missionState.tenant_slug,
  });

  // Treat every supplied knowledge hint as an untrusted candidate at the
  // pack boundary. Public/product hints remain compatible; tenant and
  // overlay hints must prove the same security scope.
  const candidateHints = input.knowledgeHints || [];
  const compiledKnowledge = compileScopedContextPack(
    securityScope,
    candidateHints.map(knowledgeHintFragment)
  );
  const acceptedHintRefs = new Set(
    compiledKnowledge.fragments.map((fragment) => fragment.source_ref)
  );
  const governedKnowledgeHints = candidateHints.filter((hint) => acceptedHintRefs.has(hint.path));

  const pack: MissionContextPack = {
    context_pack_id:
      input.contextPackId ||
      buildContextPackId({
        missionId: input.missionState.mission_id,
        teamRole: input.teamRole,
        recipientKind: recipient.kind,
        workItemId,
      }),
    version: '1',
    generated_at: nowIso(),
    summary,
    scope,
    security_scope: securityScope,
    ...(compiledKnowledge.rejected.length > 0
      ? {
          scope_audit: {
            effective_scope: compiledKnowledge.security_scope,
            rejected: compiledKnowledge.rejected,
          },
        }
      : {}),
    recipient,
    mission,
    ...(project ? { project } : {}),
    ...(track ? { track } : {}),
    ...(taskSession ? { task_session: taskSession } : {}),
    ...(workItem ? { work_item: workItem } : {}),
    ...(governedKnowledgeHints.length > 0 ? { knowledge_hints: governedKnowledgeHints } : {}),
    ...(skillResources.length > 0 ? { skill_resources: skillResources } : {}),
    ...(artifactHints.length > 0 ? { artifact_hints: artifactHints } : {}),
    ...(taskGuidance ? { task_guidance: taskGuidance } : {}),
    ...(facets ? { facets } : {}),
    sources,
    redactions: defaultRedactions(),
    delivery: {
      mode: 'prompt',
      // KP-04: task_guidance is generated for every tier now, not just
      // `fast`, so this no longer distinguishes "fast-lane" from plain.
      summary: taskGuidance
        ? 'Role-scoped mission context pack with task guidance. Full Kyberion knowledge and unrelated operational state are intentionally omitted.'
        : 'Role-scoped mission context pack. Full Kyberion knowledge and unrelated operational state are intentionally omitted.',
    },
  };

  // KP-04: an explicit budget always wins; otherwise scale by estimated_scope
  // (M = pre-KP-04 default, so omitting both leaves behavior unchanged).
  const effectiveBudgetChars =
    input.contextBudgetChars ?? resolveScopeBudget(input.estimatedScope).contextBudgetChars;
  const prunedPack = pruneMissionContextPack(pack, effectiveBudgetChars, missionPath);
  const validate = ensureMissionContextPackValidator();
  if (!validate(prunedPack)) {
    throw new Error(`Invalid mission context pack: ${validationErrors(validate).join('; ')}`);
  }

  return prunedPack;
}

export async function resolveMissionContextPack(
  input: ResolveMissionContextPackInput
): Promise<MissionContextPack | null> {
  const tier = normalizeTier(input.tier, 'public');
  const missionState = input.missionState || loadMissionState(input.missionId, tier);
  if (!missionState) return null;

  const workItem = input.workItem || (input.workItemId ? getWorkItem(input.workItemId) : null);
  const workItemMetadata = (workItem?.metadata || {}) as Record<string, unknown>;
  const derivedTaskSessionId =
    typeof workItemMetadata.task_session_id === 'string'
      ? workItemMetadata.task_session_id
      : undefined;
  const taskSession =
    input.taskSession || loadTaskSessionIfPossible(input.taskSessionId || derivedTaskSessionId);
  const projectState =
    input.projectState ||
    loadProjectStateIfPossible({
      projectId: input.projectId,
      missionState,
      workItem,
      tier,
      tenantSlug: input.tenantSlug,
    });
  const trackRecord =
    input.trackRecord ||
    loadTrackStateIfPossible({
      trackId: input.trackId,
      projectState,
      missionState,
    });
  const missionTeamPlan = input.teamRole
    ? loadMissionTeamPlan(input.missionId) ||
      resolveMissionTeamPlan({
        missionId: input.missionId,
        missionType: missionState.mission_type,
        tier,
        assignedPersona: missionState.assigned_persona,
        ...(missionState.tenant_slug ? { tenantSlug: missionState.tenant_slug } : {}),
      })
    : null;
  const missionTeamAssignment =
    input.teamRole && missionTeamPlan
      ? missionTeamPlan.assignments.find((entry) => entry.team_role === input.teamRole) || null
      : null;
  const knowledgeHints =
    input.includeKnowledgeHints === false
      ? []
      : await loadKnowledgeHintsIfPossible({
          missionState,
          projectState,
          trackRecord,
          teamRole: input.teamRole,
          workItem,
          taskSession,
          ...(input.estimatedScope ? { estimatedScope: input.estimatedScope } : {}),
          ...(input.tenantKnowledgeRootDir
            ? { tenantKnowledgeRootDir: input.tenantKnowledgeRootDir }
            : {}),
        });

  return buildMissionContextPack({
    missionState,
    missionPath: findMissionPath(input.missionId) || pathResolver.missionDir(input.missionId, tier),
    recipientKind: input.recipientKind || (input.assigneePeerId ? 'agent' : 'subagent'),
    teamRole: input.teamRole,
    assigneePeerId: input.assigneePeerId,
    workItem,
    taskSession,
    projectState,
    trackRecord,
    missionTeamAssignment,
    ...(input.facets ? { facets: input.facets } : {}),
    ...(input.skillPaths ? { skillPaths: input.skillPaths } : {}),
    ...(input.trustResolved !== undefined ? { trustResolved: input.trustResolved } : {}),
    knowledgeHints,
    ...(input.contextBudgetChars ? { contextBudgetChars: input.contextBudgetChars } : {}),
    ...(input.contextPackId ? { contextPackId: input.contextPackId } : {}),
    ...(input.estimatedScope ? { estimatedScope: input.estimatedScope } : {}),
  });
}

export function saveMissionContextPack(missionPath: string, pack: MissionContextPack): string {
  const missionDir = safeMissionPath(
    missionPath && safeExistsSync(missionPath)
      ? missionPath
      : path.isAbsolute(missionPath)
        ? missionPath
        : pathResolver.rootResolve(missionPath)
  );
  const targetDir = safeMissionArtifactPath(missionDir, 'coordination/context-packs');
  if (!safeExistsSync(targetDir)) safeMkdir(targetDir, { recursive: true });
  const filePath = safeMissionArtifactPath(
    missionDir,
    `coordination/context-packs/${pack.context_pack_id}.json`
  );
  const payload = {
    ...pack,
    context_pack_path: filePath,
  };
  const validate = ensureMissionContextPackValidator();
  if (!validate(payload)) {
    throw new Error(
      `Invalid mission context pack payload: ${validationErrors(validate).join('; ')}`
    );
  }
  writeProvisionedJson({
    missionId: pack.scope.mission_id,
    filePath,
    targetPath: path.relative(missionDir, filePath).split(path.sep).join('/'),
    missionPathHint: missionDir,
    provisioned: provisionMissionEntry(payload),
  });
  return filePath;
}

export function renderMissionContextPack(pack: MissionContextPack): string {
  const lines: string[] = [
    'Mission context pack (scoped, minimal, role-specific).',
    `- Pack ID: ${pack.context_pack_id}`,
    `- Scope: mission=${pack.scope.mission_id}; tier=${pack.scope.tier}${pack.scope.tenant_slug ? `; tenant=${pack.scope.tenant_slug}` : ''}${pack.scope.organization_id ? `; organization=${pack.scope.organization_id}` : ''}${pack.scope.project_id ? `; project=${pack.scope.project_id}` : ''}${pack.scope.task_session_id ? `; task_session=${pack.scope.task_session_id}` : ''}${pack.scope.work_item_id ? `; work_item=${pack.scope.work_item_id}` : ''}`,
    `- Recipient: ${pack.recipient.kind}${pack.recipient.team_role ? ` / role=${pack.recipient.team_role}` : ''}${pack.recipient.agent_id ? ` / agent=${pack.recipient.agent_id}` : ''}${pack.recipient.authority_role ? ` / authority=${pack.recipient.authority_role}` : ''}`,
    `- Mission: ${pack.mission.mission_id} | ${pack.mission.status}${pack.mission.mission_type ? ` | type=${pack.mission.mission_type}` : ''}${pack.mission.assigned_persona ? ` | persona=${pack.mission.assigned_persona}` : ''}`,
  ];

  if (pack.project) {
    lines.push(
      `- Project: ${pack.project.project_id} | ${pack.project.name} | ${pack.project.status}${pack.project.current_phase ? ` | phase=${pack.project.current_phase}` : ''}`,
      `  - Summary: ${summarizeText(pack.project.summary, 320) || pack.project.summary}`
    );
  }

  if (pack.track) {
    lines.push(
      `- Track: ${pack.track.track_id} | ${pack.track.name} | ${pack.track.status} | ${pack.track.track_type}/${pack.track.lifecycle_model}`,
      `  - Summary: ${summarizeText(pack.track.summary, 280) || pack.track.summary}`
    );
  }

  if (pack.task_session) {
    lines.push(
      `- Task session: ${pack.task_session.session_id} | ${pack.task_session.task_type} | ${pack.task_session.status} | ${pack.task_session.mode}`,
      `  - Goal: ${summarizeText(pack.task_session.goal.summary, 240) || pack.task_session.goal.summary}`
    );
  }

  if (pack.work_item) {
    lines.push(
      `- Work item: ${pack.work_item.item_id} | ${pack.work_item.status} | ${pack.work_item.title}`,
      `  - Description: ${summarizeText(pack.work_item.description, 280) || pack.work_item.description}`
    );
  }

  if (pack.task_guidance) {
    lines.push(
      `- Fast-lane guidance: model_tier=${pack.task_guidance.model_tier}`,
      `  - Acceptance criteria:`,
      ...pack.task_guidance.acceptance_criteria.map((criterion) => `    - ${criterion}`),
      `  - Output contract: ${pack.task_guidance.output_contract}`,
      `  - Verification:`,
      ...pack.task_guidance.verification.map((step) => `    - ${step}`),
      ...(pack.task_guidance.seed?.length
        ? [`  - Seed:`, ...pack.task_guidance.seed.map((entry) => `    - ${entry}`)]
        : [])
    );
  }

  if (pack.facets) {
    if (pack.facets.persona) {
      lines.push(
        `- Persona facet: ${pack.facets.persona.name} (${pack.facets.persona.source})`,
        `  - ${pack.facets.persona.content}`
      );
    }
    for (const facet of [...pack.facets.policies, ...pack.facets.instructions]) {
      lines.push(`- ${facet.name} facet: ${facet.source}`, `  - ${facet.content}`);
    }
    if (pack.facets.output_contract) {
      lines.push(
        `- Output contract facet: ${pack.facets.output_contract.name}`,
        `  - ${pack.facets.output_contract.content}`
      );
    }
  }

  if (pack.skill_resources && pack.skill_resources.length > 0) {
    lines.push(
      '- Available skills (metadata only):',
      renderSkillResourceIndex(pack.skill_resources)
    );
  }

  if (pack.pruning) {
    lines.push(
      `- Context pruning: budget=${pack.pruning.budget_chars}; estimated=${pack.pruning.estimated_chars}`,
      `  - Kept: ${pack.pruning.kept_sections.join(', ')}`,
      `  - Pruned: ${pack.pruning.pruned_sections.length > 0 ? pack.pruning.pruned_sections.join(', ') : 'none'}`,
      ...(pack.pruning.rollup_path ? [`  - Rollup: ${pack.pruning.rollup_path}`] : [])
    );
  }

  if (pack.scope_audit) {
    const counts = new Map<string, number>();
    for (const rejection of pack.scope_audit.rejected) {
      counts.set(rejection.code, (counts.get(rejection.code) || 0) + 1);
    }
    const summary = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => `${code}=${count}`)
      .join(', ');
    lines.push(
      `- Scope-rejected knowledge: ${pack.scope_audit.rejected.length}${summary ? ` (${summary})` : ''}`
    );
  }

  if (pack.knowledge_hints && pack.knowledge_hints.length > 0) {
    lines.push('- Knowledge hints:');
    for (const hint of pack.knowledge_hints) {
      lines.push(`  - ${hint.title} (${hint.path})`);
      lines.push(`    ${summarizeText(hint.excerpt, 220) || hint.excerpt}`);
    }
  }

  if (pack.artifact_hints && pack.artifact_hints.length > 0) {
    lines.push('- Reusable artifact hints:');
    for (const hint of pack.artifact_hints) {
      lines.push(`  - ${hint.artifact_id} | ${hint.kind} | ${hint.storage_class}`);
      lines.push(`    ${hint.reuse_reason}`);
      if (hint.path) lines.push(`    path: ${hint.path}`);
      if (hint.project_id || hint.mission_id || hint.task_session_id) {
        lines.push(
          `    lineage: ${[hint.project_id ? `project=${hint.project_id}` : '', hint.mission_id ? `mission=${hint.mission_id}` : '', hint.task_session_id ? `task_session=${hint.task_session_id}` : ''].filter(Boolean).join(', ')}`
        );
      }
    }
  }

  lines.push('- Sources:');
  for (const source of pack.sources) {
    const descriptor = [
      `[${source.kind}] ${source.ref}`,
      source.path ? `(${source.path})` : '',
      source.summary ? `- ${summarizeText(source.summary, 200) || source.summary}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`  - ${descriptor}`);
  }

  lines.push(`- Redactions: ${pack.redactions.length > 0 ? pack.redactions.join('; ') : 'none'}`);
  lines.push(
    '',
    'Use only the facts in this pack and the task instructions that follow. If a necessary fact is missing, report the gap instead of assuming the full knowledge base.'
  );
  return lines.join('\n');
}
