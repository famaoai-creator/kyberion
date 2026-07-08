import * as path from 'node:path';
import {
  loadProjectRecord,
  loadProjectTrackRecord,
  pathResolver,
  validateWritePermission,
} from '@agent/core';
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

export function resolveMissionTicketDispatchOptionsFromArgv(argv: string[] = process.argv): {
  targets: Array<'workitem' | 'github' | 'jira'>;
  liveTargets: Array<'workitem' | 'github' | 'jira'>;
  github?: { owner?: string; repo?: string };
  jira?: { domain?: string; projectKey?: string };
} {
  const targets = parseCsvOption('--ticket-targets', argv) || ['workitem', 'github', 'jira'];
  const liveTargets = parseCsvOption('--live-ticket-targets', argv) || [];
  const githubOwner = getOptionValue('--github-owner', argv);
  const githubRepo = getOptionValue('--github-repo', argv);
  const jiraDomain = getOptionValue('--jira-domain', argv);
  const jiraProjectKey = getOptionValue('--jira-project-key', argv);

  return {
    targets: (targets.length > 0 ? targets : ['workitem']) as Array<'workitem' | 'github' | 'jira'>,
    liveTargets: liveTargets as Array<'workitem' | 'github' | 'jira'>,
    github: githubOwner || githubRepo ? { owner: githubOwner, repo: githubRepo } : undefined,
    jira:
      jiraDomain || jiraProjectKey ? { domain: jiraDomain, projectKey: jiraProjectKey } : undefined,
  };
}

export function resolveMissionWorkItemDispatchOptionsFromArgv(argv: string[] = process.argv): {
  mode: 'auto' | 'agent' | 'subagent';
  limit?: number;
  statuses: Array<'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived'>;
  sources: Array<'local' | 'github' | 'jira' | 'peer'>;
  finalStatus: 'review' | 'done';
  rounds?: number;
} {
  const mode = (getOptionValue('--dispatch-mode', argv) || 'auto') as 'auto' | 'agent' | 'subagent';
  const limitRaw = getOptionValue('--dispatch-limit', argv);
  const statusesRaw = parseCsvOption('--dispatch-statuses', argv) || ['ready'];
  const sourcesRaw = parseCsvOption('--dispatch-sources', argv) || ['local'];
  const finalStatus = (getOptionValue('--dispatch-final-status', argv) || 'review') as
    | 'review'
    | 'done';
  const roundsRaw = getOptionValue('--dispatch-rounds', argv);

  return {
    mode,
    ...(roundsRaw ? { rounds: Number(roundsRaw) } : {}),
    ...(limitRaw ? { limit: Number(limitRaw) } : {}),
    statuses: statusesRaw as Array<
      'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived'
    >,
    sources: sourcesRaw as Array<'local' | 'github' | 'jira' | 'peer'>,
    finalStatus,
  };
}
