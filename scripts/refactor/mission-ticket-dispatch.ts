/**
 * scripts/refactor/mission-ticket-dispatch.ts
 * Mission follow-up ticket registration for work items and external issue payloads.
 */

import * as nodePath from 'node:path';
import {
  executeServicePreset,
  ledger,
  logger,
  pathResolver,
  resolveMissionTeamReceiver,
  safeExistsSync,
} from '@agent/core';
import { importExternalWorkItem } from '@agent/core';
import { findMissionPath } from '@agent/core';
import type { MissionState } from './mission-types.js';
import {
  countWords as countWordsFromDispatchIO,
  ensureDirectory,
  readJsonFile,
  writeJsonFile,
} from './mission-dispatch-io.js';
import {
  appendDispatchEvent,
  writeDispatchArtifact,
} from './mission-dispatch-lifecycle.js';

export type MissionTicketDispatchTarget = 'workitem' | 'github' | 'jira';

export interface MissionTicketDispatchLiveTarget {
  owner?: string;
  repo?: string;
  domain?: string;
  projectKey?: string;
}

export interface MissionTicketDispatchOptions {
  targets?: MissionTicketDispatchTarget[];
  liveTargets?: MissionTicketDispatchTarget[];
  github?: { owner?: string; repo?: string };
  jira?: { domain?: string; projectKey?: string };
}

export interface MissionTicketDispatchRecord {
  task_id: string;
  team_role?: string;
  title: string;
  work_item_id?: string;
  ticket_targets: MissionTicketDispatchTarget[];
  ticket_files: string[];
  live_results: Record<string, unknown>;
  status: 'created' | 'updated' | 'skipped' | 'deferred' | 'failed';
  notes: string[];
}

export interface MissionTicketDispatchManifest {
  mission_id: string;
  mission_type?: string;
  project_id?: string;
  track_id?: string;
  tier: MissionState['tier'];
  tenant_slug?: string;
  created_at: string;
  updated_at: string;
  targets: MissionTicketDispatchTarget[];
  live_targets: MissionTicketDispatchTarget[];
  ticket_count: number;
  records: MissionTicketDispatchRecord[];
  manifest_path?: string;
  event_path?: string;
}

interface PlannedTask {
  task_id: string;
  status?: string;
  assigned_to?: {
    role?: string;
    agent_id?: string;
  };
  description?: string;
  deliverable?: string;
  target_path?: string;
  [key: string]: unknown;
}

function readPlannedTasks(missionPath: string): PlannedTask[] {
  const nextTasksPath = nodePath.join(missionPath, 'NEXT_TASKS.json');
  if (!safeExistsSync(nextTasksPath)) return [];
  try {
    const parsed = readJsonFile<PlannedTask[]>(nextTasksPath);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function ticketRoot(missionPath: string): string {
  return nodePath.join(missionPath, 'coordination', 'tickets');
}

function ticketEventPath(missionPath: string): string {
  return nodePath.join(missionPath, 'coordination', 'events', 'ticket-events.jsonl');
}

function manifestPath(missionPath: string): string {
  return nodePath.join(ticketRoot(missionPath), 'dispatch-manifest.json');
}

function ensureTicketDirs(missionPath: string): void {
  ensureDirectory(ticketRoot(missionPath));
  ensureDirectory(nodePath.dirname(ticketEventPath(missionPath)));
}

function buildWorkItemDescription(input: {
  missionId: string;
  missionType?: string;
  projectId?: string;
  trackId?: string;
  task: PlannedTask;
  teamRole?: string;
  assigneeId?: string;
}): string {
  const lines = [
    `Mission: ${input.missionId}`,
    input.missionType ? `Mission type: ${input.missionType}` : '',
    input.projectId ? `Project: ${input.projectId}` : '',
    input.trackId ? `Track: ${input.trackId}` : '',
    input.teamRole ? `Assignee role: ${input.teamRole}` : '',
    input.assigneeId ? `Assignee agent: ${input.assigneeId}` : '',
    '',
    `Task: ${input.task.description || input.task.task_id}`,
    input.task.deliverable ? `Deliverable: ${input.task.deliverable}` : '',
    input.task.target_path ? `Target path: ${input.task.target_path}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildExternalBody(input: {
  missionId: string;
  task: PlannedTask;
  projectId?: string;
  teamRole?: string;
  assigneeId?: string;
}): string {
  const lines = [
    `Mission: ${input.missionId}`,
    input.projectId ? `Project: ${input.projectId}` : '',
    input.teamRole ? `Team role: ${input.teamRole}` : '',
    input.assigneeId ? `Assignee agent: ${input.assigneeId}` : '',
    '',
    input.task.description ? `Task: ${input.task.description}` : `Task: ${input.task.task_id}`,
    input.task.deliverable ? `Deliverable: ${input.task.deliverable}` : '',
    input.task.target_path ? `Target path: ${input.task.target_path}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function validateMissionTicketTask(task: PlannedTask, assigneeId?: string): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  const description = String(task.description || '').trim();

  if (!task.assigned_to?.role) {
    notes.push('missing assigned_to.role');
  }
  if (!task.assigned_to?.agent_id && !assigneeId) {
    notes.push('missing assigned_to.agent_id');
  }
  if (!description) {
    notes.push('missing task description');
  } else if (countWordsFromDispatchIO(description) < 4) {
    notes.push('task description too short');
  }
  if (!task.deliverable && !task.target_path) {
    notes.push('missing deliverable or target_path');
  }

  return { ok: notes.length === 0, notes };
}

function loadExistingManifest(missionPath: string): MissionTicketDispatchManifest | null {
  const path = manifestPath(missionPath);
  if (!safeExistsSync(path)) return null;
  try {
    const parsed = readJsonFile<MissionTicketDispatchManifest>(path);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function resolveProjectLink(state: MissionState): { project_id?: string; project_path?: string; track_id?: string } {
  return {
    project_id: state.relationships?.project?.project_id,
    project_path: state.relationships?.project?.project_path,
    track_id: state.relationships?.track?.track_id,
  };
}

export async function dispatchMissionTickets(
  state: MissionState,
  options: MissionTicketDispatchOptions = {},
): Promise<MissionTicketDispatchManifest> {
  const missionId = state.mission_id.toUpperCase();
  const missionPath = findMissionPath(missionId) || pathResolver.missionDir(missionId, state.tier);
  if (!missionPath) {
    throw new Error(`Mission path not found for ${missionId}`);
  }

  const plannedTasks = readPlannedTasks(missionPath).filter((task) => (task.status || 'planned') === 'planned');
  if (plannedTasks.length === 0) {
    throw new Error(`No planned tasks available for ${missionId}`);
  }
  const nextTasksPath = nodePath.join(missionPath, 'NEXT_TASKS.json');

  const targets: MissionTicketDispatchTarget[] =
    options.targets && options.targets.length > 0
      ? [...new Set(options.targets)] as MissionTicketDispatchTarget[]
      : ['workitem'];
  const liveTargets: MissionTicketDispatchTarget[] =
    options.liveTargets && options.liveTargets.length > 0
      ? [...new Set(options.liveTargets)] as MissionTicketDispatchTarget[]
      : [];
  ensureTicketDirs(missionPath);

  const projectLink = resolveProjectLink(state);
  const existingManifest = loadExistingManifest(missionPath);
  const existingRecords = new Map<string, MissionTicketDispatchRecord>(
    (existingManifest?.records || []).map((record) => [record.task_id, record]),
  );
  const allTasks = readPlannedTasks(missionPath);

  const records: MissionTicketDispatchRecord[] = [];
  for (const task of plannedTasks) {
    const teamRole = task.assigned_to?.role;
    const ticketTargets = [...targets];
    const ticketFiles: string[] = [];
    const liveResults: Record<string, unknown> = {};
    const notes: string[] = [];
    let status: MissionTicketDispatchRecord['status'] = 'created';

    const existing = existingRecords.get(task.task_id);
    const workItemSourceRef = `mission:${missionId}:${task.task_id}`;
    let workItemId = existing?.work_item_id;
    const resolvedAssignment = teamRole ? resolveMissionTeamReceiver({ missionId, teamRole }) : null;
    const resolvedAgentId = task.assigned_to?.agent_id || resolvedAssignment?.agent_id || undefined;
    const validation = validateMissionTicketTask(task, resolvedAgentId);
    if (!validation.ok) {
      status = 'failed';
      notes.push(...validation.notes);
    }

    if (status !== 'failed' && targets.includes('workitem')) {
      const sourceResult = importExternalWorkItem({
        source: 'local',
        sourceRef: workItemSourceRef,
        title: `${missionId}: ${task.description || task.task_id}`,
        description: buildWorkItemDescription({
          missionId,
          missionType: state.mission_type,
          projectId: projectLink.project_id,
          trackId: projectLink.track_id,
          task,
          teamRole,
          assigneeId: resolvedAgentId,
        }),
        status: 'ready',
        projectId: projectLink.project_id || missionId,
        assigneePeerId: resolvedAgentId,
        labels: [
          `mission:${missionId}`,
          ...(state.mission_type ? [`mission_type:${state.mission_type}`] : []),
          ...(teamRole ? [`team_role:${teamRole}`] : []),
          'ticket:workitem',
        ],
        metadata: {
          mission_id: missionId,
          mission_type: state.mission_type || null,
          task_id: task.task_id,
          target_path: task.target_path || null,
          deliverable: task.deliverable || null,
          team_role: teamRole || null,
          resolved_agent_id: resolvedAgentId || null,
          assignee_label: resolvedAgentId || teamRole || null,
          ticket_targets: targets,
        },
      });
      workItemId = sourceResult.item_id;
      status = existing?.work_item_id ? 'updated' : 'created';
    }

    const githubArtifactPath = nodePath.join(ticketRoot(missionPath), 'github', `${task.task_id}.json`);
    const githubPayload = {
      id: workItemId || task.task_id,
      number: undefined,
      title: `[${missionId}] ${task.description || task.task_id}`,
      body: buildExternalBody({
        missionId,
        task,
        projectId: projectLink.project_id,
        teamRole,
        assigneeId: resolvedAgentId,
      }),
      state: 'open',
      labels: [
        `mission:${missionId}`,
        ...(state.mission_type ? [`mission_type:${state.mission_type}`] : []),
        ...(teamRole ? [`team_role:${teamRole}`] : []),
      ],
      assignees: resolvedAgentId ? [{ login: resolvedAgentId }] : [],
      repository_url: options.github?.owner && options.github?.repo
        ? `https://github.com/${options.github.owner}/${options.github.repo}`
        : undefined,
      html_url: undefined,
      updated_at: new Date().toISOString(),
      draft: false,
    };
    if (status !== 'failed' && targets.includes('github')) {
      writeDispatchArtifact(githubArtifactPath, githubPayload);
      ticketFiles.push(githubArtifactPath);
        if (liveTargets.includes('github')) {
          if (!options.github?.owner || !options.github?.repo) {
            notes.push('github live dispatch skipped: missing owner/repo');
          } else {
            try {
              const result = await executeServicePreset('github', 'create_issue', {
              owner: options.github.owner,
              repo: options.github.repo,
                title: githubPayload.title,
                body: githubPayload.body,
              }, 'secret-guard');
              liveResults.github = {
                ...(result && typeof result === 'object' ? result as Record<string, unknown> : { value: result }),
                owner: options.github.owner,
                repo: options.github.repo,
                repository_url: githubPayload.repository_url || `https://github.com/${options.github.owner}/${options.github.repo}`,
                issue_number: typeof (result as any)?.number === 'number'
                  ? (result as any).number
                  : typeof (result as any)?.id === 'number'
                    ? (result as any).id
                    : undefined,
              };
            } catch (error: any) {
              notes.push(`github live dispatch failed: ${error?.message || error}`);
              status = 'failed';
            }
          }
      }
    }

    const jiraArtifactPath = nodePath.join(ticketRoot(missionPath), 'jira', `${task.task_id}.json`);
    const jiraProjectKey = options.jira?.projectKey || projectLink.project_id || missionId;
    const jiraPayload = {
      key: `${jiraProjectKey}-${task.task_id}`.toUpperCase(),
      fields: {
        summary: `[${missionId}] ${task.description || task.task_id}`,
        description: buildExternalBody({
          missionId,
          task,
          projectId: projectLink.project_id,
          teamRole,
          assigneeId: resolvedAgentId,
        }),
        status: { name: 'Open' },
        priority: { name: 'Normal' },
        labels: [
          `mission:${missionId}`,
          ...(state.mission_type ? [`mission_type:${state.mission_type}`] : []),
          ...(teamRole ? [`team_role:${teamRole}`] : []),
        ],
        assignee: resolvedAgentId ? { accountId: resolvedAgentId, displayName: resolvedAgentId } : undefined,
        project: { key: jiraProjectKey, id: jiraProjectKey },
        updated: new Date().toISOString(),
      },
    };
    if (status !== 'failed' && targets.includes('jira')) {
      writeDispatchArtifact(jiraArtifactPath, jiraPayload);
      ticketFiles.push(jiraArtifactPath);
        if (liveTargets.includes('jira')) {
          if (!options.jira?.projectKey || !options.jira?.domain) {
            notes.push('jira live dispatch skipped: missing domain/projectKey');
          } else {
            try {
              const result = await executeServicePreset('jira', 'create_issue', {
              domain: options.jira.domain,
              project_key: options.jira.projectKey,
                summary: jiraPayload.fields.summary,
                description: jiraPayload.fields.description,
                issue_type: 'Task',
              }, 'secret-guard');
              liveResults.jira = {
                ...(result && typeof result === 'object' ? result as Record<string, unknown> : { value: result }),
                domain: options.jira.domain,
                projectKey: options.jira.projectKey,
                issue_key: typeof (result as any)?.key === 'string'
                  ? (result as any).key
                  : typeof (result as any)?.issue_key === 'string'
                    ? (result as any).issue_key
                    : undefined,
              };
            } catch (error: any) {
              notes.push(`jira live dispatch failed: ${error?.message || error}`);
              status = 'failed';
            }
          }
      }
    }

    const record: MissionTicketDispatchRecord = {
      task_id: task.task_id,
      team_role: teamRole,
      title: task.description || task.task_id,
      work_item_id: workItemId,
      ticket_targets: ticketTargets,
      ticket_files: ticketFiles,
      live_results: liveResults,
      status,
      notes,
    };
    records.push(record);

    const taskIndex = allTasks.findIndex((entry) => entry.task_id === task.task_id);
    if (taskIndex >= 0) {
      const nextTask = {
        ...allTasks[taskIndex],
        ticket_dispatch: {
          registered_at: new Date().toISOString(),
          manifest_path: manifestPath(missionPath),
          work_item_id: workItemId,
          targets,
          ticket_targets: ticketTargets,
          live_targets: liveTargets,
          live_results: liveResults,
          status,
        },
      };
      allTasks[taskIndex] = nextTask;
    }

    appendDispatchEvent(ticketEventPath(missionPath), {
      event_type: 'ticket_dispatched',
      mission_id: missionId,
      task_id: task.task_id,
      team_role: teamRole,
      work_item_id: workItemId,
      ticket_targets: ticketTargets,
      ticket_files: ticketFiles,
      live_targets: liveTargets,
      status,
      notes,
    });
  }

  const manifest: MissionTicketDispatchManifest = {
    mission_id: missionId,
    mission_type: state.mission_type,
    project_id: projectLink.project_id,
    track_id: projectLink.track_id,
    tier: state.tier,
    tenant_slug: state.tenant_slug,
    created_at: existingManifest?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    targets,
    live_targets: liveTargets,
    ticket_count: records.length,
    records,
  };

  const manifestFilePath = manifestPath(missionPath);
  manifest.manifest_path = manifestFilePath;
  manifest.event_path = ticketEventPath(missionPath);
  writeJsonFile(manifestFilePath, manifest);
  writeJsonFile(nextTasksPath, allTasks);

  ledger.record('MISSION_TICKETS_REGISTERED', {
    mission_id: missionId,
    ticket_count: records.length,
    ticket_targets: targets,
    live_ticket_targets: liveTargets,
    project_id: projectLink.project_id,
    track_id: projectLink.track_id,
    manifest_path: manifestFilePath,
  });

  logger.info(`[tickets] mission=${missionId} targets=${targets.join(',')} live=${liveTargets.join(',') || 'none'} count=${records.length}`);
  return manifest;
}
