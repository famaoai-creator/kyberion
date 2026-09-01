import * as path from 'node:path';
import { loadProjectRecord } from '@agent/core/project-registry';
import { loadProjectTrackRecord } from '@agent/core/project-track-registry';
import { assertManagedProjectTrackScope } from '@agent/core/project-management';
import {
  resolveMissionExecutionSurface,
  type MissionExecutionSurface,
} from '@agent/core/mission-execution-surface';
import { validateWritePermission } from '@agent/core/tier-guard';
import { pathResolver } from '@agent/core/path-resolver';
import {
  extractMissionControllerPositionalArgs,
  extractMissionStartCreateOptionsFromArgv,
  getOptionValue,
  parseCsvOption,
} from './mission-cli-args.js';
import { normalizeRelationships } from './mission-state.js';
import {
  resolveProjectLedgerJsonPath,
  resolveProjectLedgerPath,
} from './mission-project-ledger.js';
import type { MissionRelationships } from './mission-types.js';
import { currentProcessArgv } from '../lib/harness.js';
import { parseSafeJsonObjectInput } from '../lib/json-input.js';

const MISSION_TIERS = ['personal', 'confidential', 'public'] as const;

const TICKET_TARGETS = ['workitem', 'github', 'jira'] as const;
const DISPATCH_MODES = ['auto', 'agent', 'subagent'] as const;
const WORK_ITEM_STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'done',
  'archived',
] as const;
const WORK_ITEM_SOURCES = ['local', 'github', 'jira', 'peer'] as const;
const FINAL_STATUSES = ['review', 'done'] as const;

function getAllowedOption<T extends string>(
  flag: string,
  argv: string[],
  allowed: readonly T[]
): T | undefined {
  const value = getOptionValue(flag, argv);
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${flag} must be one of: ${allowed.join(', ')}`);
}

function getAllowedCsvOption<T extends string>(
  flag: string,
  argv: string[],
  allowed: readonly T[],
  fallback: readonly T[]
): T[] {
  const values = parseCsvOption(flag, argv);
  if (!values) return [...fallback];
  const invalid = values.filter((value) => !(allowed as readonly string[]).includes(value));
  if (invalid.length > 0) {
    throw new Error(`${flag} contains unsupported value(s): ${invalid.join(', ')}`);
  }
  return values as T[];
}

function getOptionalInteger(flag: string, argv: string[]): number | undefined {
  const raw = getOptionValue(flag, argv);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function getMissionTier(value: string | undefined): (typeof MISSION_TIERS)[number] | undefined {
  if (value === undefined) return undefined;
  if ((MISSION_TIERS as readonly string[]).includes(value)) {
    return value as (typeof MISSION_TIERS)[number];
  }
  throw new Error(`mission tier must be one of: ${MISSION_TIERS.join(', ')}`);
}

export interface ResolvedMissionCliInput {
  tier?: 'personal' | 'confidential' | 'public';
  tenantId?: string;
  organizationId?: string;
  /**
   * Tenant slug for multi-tenant isolation (^[a-z][a-z0-9-]{1,30}$).
   * When set, the resulting mission is bound to this tenant and
   * tier-guard / audit-chain enforce cross-tenant isolation.
   */
  tenantSlug?: string;
  missionType?: string;
  visionRef?: string;
  persona?: string;
  relationships?: MissionRelationships;
  ledgerTargets?: {
    markdown: string;
    json: string;
  };
  routingDecision?: string;
}

export function resolveMissionStartCreateInputFromArgv(
  argv: string[] = currentProcessArgv()
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
    parseSafeJsonObjectInput(arg7, 'legacy mission relationships') || {},
    namedStartCreateOptions.relationships || {}
  );
  if (relationships?.project?.project_id && !relationships.track?.track_id) {
    const projectRecord = loadProjectRecord(relationships.project.project_id);
    const defaultTrackId = projectRecord?.default_track_id;
    if (defaultTrackId) {
      const trackRecord = loadProjectTrackRecord(defaultTrackId);
      if (trackRecord?.status === 'active') {
        if (projectRecord) assertManagedProjectTrackScope(projectRecord, trackRecord);
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
    tier: namedStartCreateOptions.tier || getMissionTier(arg2),
    tenantId: namedStartCreateOptions.tenantId || arg3,
    organizationId: namedStartCreateOptions.organizationId,
    ...(namedStartCreateOptions.tenantSlug
      ? { tenantSlug: namedStartCreateOptions.tenantSlug }
      : {}),
    missionType: namedStartCreateOptions.missionType || arg4,
    visionRef: namedStartCreateOptions.visionRef || arg5,
    persona: namedStartCreateOptions.persona || arg6,
    routingDecision: namedStartCreateOptions.routingDecision,
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
  argv: string[] = currentProcessArgv()
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
  if (project?.project_id) {
    const projectRecord = loadProjectRecord(project.project_id);
    if (track?.track_id) {
      if (!projectRecord) {
        throw new Error(
          `${actionName} ${missionId}: project record not found for track scope validation: ${project.project_id}`
        );
      }
      const trackRecord = loadProjectTrackRecord(track.track_id);
      if (!trackRecord) {
        throw new Error(`${actionName} ${missionId}: project track not found: ${track.track_id}`);
      }
      assertManagedProjectTrackScope(projectRecord, trackRecord);
    }
    if (projectRecord) {
      const requestedTier = input.tier;
      const requestedTenant = input.tenantSlug || input.tenantId || 'shared';
      const projectTenant = projectRecord.tenant_slug || 'shared';
      if (requestedTier && requestedTier !== projectRecord.tier) {
        throw new Error(
          `${actionName} ${missionId}: mission tier '${requestedTier}' must match project tier '${projectRecord.tier}'.`
        );
      }
      if (
        (projectRecord.tier === 'confidential' ||
          projectRecord.tenant_slug ||
          input.tenantSlug ||
          input.tenantId) &&
        requestedTenant !== projectTenant
      ) {
        throw new Error(
          `${actionName} ${missionId}: mission tenant '${requestedTenant}' must match project tenant '${projectTenant}'.`
        );
      }
    }
  }
  if (project?.project_path && input.ledgerTargets) {
    const markdownGuard = validateWritePermission(input.ledgerTargets.markdown);
    if (!markdownGuard.allowed) {
      throw new Error(
        `${actionName} ${missionId}: project ledger target '${path.relative(pathResolver.rootDir(), input.ledgerTargets.markdown)}' is not writable under current authority. ${markdownGuard.reason}`
      );
    }
    const jsonGuard = validateWritePermission(input.ledgerTargets.json);
    if (!jsonGuard.allowed) {
      throw new Error(
        `${actionName} ${missionId}: project ledger target '${path.relative(pathResolver.rootDir(), input.ledgerTargets.json)}' is not writable under current authority. ${jsonGuard.reason}`
      );
    }
  }
  return input;
}

export function resolveMissionTicketDispatchOptionsFromArgv(
  argv: string[] = currentProcessArgv()
): {
  targets: Array<'workitem' | 'github' | 'jira'>;
  liveTargets: Array<'workitem' | 'github' | 'jira'>;
  github?: { owner?: string; repo?: string };
  jira?: { domain?: string; projectKey?: string };
} {
  const targets = getAllowedCsvOption('--ticket-targets', argv, TICKET_TARGETS, TICKET_TARGETS);
  const liveTargets = getAllowedCsvOption('--live-ticket-targets', argv, TICKET_TARGETS, []);
  const githubOwner = getOptionValue('--github-owner', argv);
  const githubRepo = getOptionValue('--github-repo', argv);
  const jiraDomain = getOptionValue('--jira-domain', argv);
  const jiraProjectKey = getOptionValue('--jira-project-key', argv);

  return {
    targets: targets.length > 0 ? targets : ['workitem'],
    liveTargets,
    github: githubOwner || githubRepo ? { owner: githubOwner, repo: githubRepo } : undefined,
    jira:
      jiraDomain || jiraProjectKey ? { domain: jiraDomain, projectKey: jiraProjectKey } : undefined,
  };
}

export function resolveMissionWorkItemDispatchOptionsFromArgv(
  argv: string[] = currentProcessArgv()
): {
  mode: 'auto' | 'agent' | 'subagent';
  executionSurface?: MissionExecutionSurface;
  reviewExecutionSurface?: MissionExecutionSurface;
  limit?: number;
  statuses: Array<'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived'>;
  sources: Array<'local' | 'github' | 'jira' | 'peer'>;
  finalStatus: 'review' | 'done';
  rounds?: number;
} {
  const mode = getAllowedOption('--dispatch-mode', argv, DISPATCH_MODES) || 'auto';
  const executionSurfaceRaw = getOptionValue('--dispatch-execution-surface', argv);
  const reviewExecutionSurfaceRaw = getOptionValue('--dispatch-review-execution-surface', argv);
  const executionSurface = executionSurfaceRaw
    ? resolveMissionExecutionSurface({ requested: executionSurfaceRaw }).surface
    : undefined;
  const reviewExecutionSurface = reviewExecutionSurfaceRaw
    ? resolveMissionExecutionSurface({ requested: reviewExecutionSurfaceRaw }).surface
    : undefined;
  const limit = getOptionalInteger('--dispatch-limit', argv);
  const statuses = getAllowedCsvOption('--dispatch-statuses', argv, WORK_ITEM_STATUSES, ['ready']);
  const sources = getAllowedCsvOption('--dispatch-sources', argv, WORK_ITEM_SOURCES, ['local']);
  const finalStatus = getAllowedOption('--dispatch-final-status', argv, FINAL_STATUSES) || 'review';
  const rounds = getOptionalInteger('--dispatch-rounds', argv);

  return {
    mode,
    ...(executionSurface ? { executionSurface } : {}),
    ...(reviewExecutionSurface ? { reviewExecutionSurface } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
    ...(limit !== undefined ? { limit } : {}),
    statuses,
    sources,
    finalStatus,
  };
}
