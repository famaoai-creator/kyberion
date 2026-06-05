/**
 * scripts/refactor/mission-workitem-dispatch.ts
 * Mission work item execution dispatch for registered tickets.
 */

import * as nodePath from 'node:path';
import {
  a2aBridge,
  executeServicePreset,
  getReasoningBackend,
  ledger,
  logger,
  pathResolver,
  resolveMissionTeamReceiver,
  safeExistsSync,
  listWorkItems,
  updateWorkItem,
  renderMissionContextPack,
  resolveMissionContextPack,
  saveMissionContextPack,
  type A2AMessage,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
} from '@agent/core';
import { findMissionPath } from '@agent/core';
import type { MissionState } from './mission-types.js';
import {
  countWords as countWordsFromDispatchIO,
  readJsonFile as readJsonFileFromDispatchIO,
  writeJsonFile as writeJsonFileFromDispatchIO,
} from './mission-dispatch-io.js';
import {
  appendDispatchEvent,
  writeDispatchArtifact,
} from './mission-dispatch-lifecycle.js';

export type MissionWorkItemDispatchMode = 'auto' | 'agent' | 'subagent';
export type MissionWorkItemDispatchFinalStatus = 'review' | 'done';

export interface MissionWorkItemDispatchOptions {
  mode?: MissionWorkItemDispatchMode;
  limit?: number;
  statuses?: WorkItemStatus[];
  sources?: WorkItemSource[];
  finalStatus?: MissionWorkItemDispatchFinalStatus;
}

export interface MissionWorkItemDispatchRecord {
  item_id: string;
  title: string;
  team_role?: string;
  assignee_peer_id?: string;
  context_pack_id?: string;
  context_pack_path?: string;
  execution_mode: MissionWorkItemDispatchMode | 'agent' | 'subagent';
  status: 'created' | 'updated' | 'skipped' | 'failed';
  work_item_status_before?: WorkItemStatus;
  work_item_status_after?: WorkItemStatus;
  response_path?: string;
  response_excerpt?: string;
  reflection_status?: 'done' | 'review' | 'blocked';
  reflection_path?: string;
  reflection_excerpt?: string;
  reflected_at?: string;
  ticket_state_after?: string;
  notes: string[];
}

export interface MissionWorkItemDispatchManifest {
  mission_id: string;
  mission_type?: string;
  tier: MissionState['tier'];
  tenant_slug?: string;
  created_at: string;
  updated_at: string;
  mode: MissionWorkItemDispatchMode;
  final_status: MissionWorkItemDispatchFinalStatus;
  work_item_count: number;
  records: MissionWorkItemDispatchRecord[];
  manifest_path?: string;
  event_path?: string;
}

interface WorkItemDispatchAdapters {
  routeA2A?: (envelope: A2AMessage) => Promise<A2AMessage>;
  delegateTask?: (instruction: string, context?: string) => Promise<string>;
}

function dispatchRoot(missionPath: string): string {
  return nodePath.join(missionPath, 'evidence');
}

function dispatchEventPath(missionPath: string): string {
  return nodePath.join(missionPath, 'coordination', 'events', 'workitem-dispatch.jsonl');
}

function manifestPath(missionPath: string): string {
  return nodePath.join(dispatchRoot(missionPath), 'workitem-dispatch-manifest.json');
}

function ticketRoot(missionPath: string): string {
  return nodePath.join(missionPath, 'coordination', 'tickets');
}

function ticketManifestPath(missionPath: string): string {
  return nodePath.join(ticketRoot(missionPath), 'dispatch-manifest.json');
}

function ticketReplyPath(missionPath: string, taskId: string): string {
  return nodePath.join(ticketRoot(missionPath), 'replies', `${taskId}.json`);
}

function missionNextTasksPath(missionPath: string): string {
  return nodePath.join(missionPath, 'NEXT_TASKS.json');
}

function readManifest(missionPath: string): MissionWorkItemDispatchManifest | null {
  const path = manifestPath(missionPath);
  if (!safeExistsSync(path)) return null;
  try {
    const parsed = readJsonFileFromDispatchIO<MissionWorkItemDispatchManifest>(path);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function getMissionLabel(item: WorkItem): string | undefined {
  return (item.labels || []).find((label) => label.startsWith('mission:'))?.slice('mission:'.length);
}

function getTeamRole(item: WorkItem): string | undefined {
  const label = (item.labels || []).find((entry) => entry.startsWith('team_role:'));
  if (label) return label.slice('team_role:'.length);
  const metadata = item.metadata as Record<string, unknown> | undefined;
  const teamRole = metadata?.team_role;
  return typeof teamRole === 'string' ? teamRole : undefined;
}

function getTaskDescription(item: WorkItem): string {
  return item.title || item.description || item.source_ref || item.item_id;
}

function getWorkItemTaskId(item: WorkItem): string | undefined {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const taskId = metadata.task_id;
  if (typeof taskId === 'string' && taskId.trim()) return taskId.trim();
  const sourceRef = String(item.source_ref || '').trim();
  const match = sourceRef.match(/^mission:[^:]+:(.+)$/u);
  return match?.[1] || undefined;
}

function extractGitHubIssueNumber(source: unknown): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const raw = record.issue_number ?? record.number ?? record.id;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function extractGitHubRepoInfo(source: unknown): { owner?: string; repo?: string; repositoryUrl?: string } {
  if (!source || typeof source !== 'object') return {};
  const record = source as Record<string, unknown>;
  const repositoryUrl = typeof record.repository_url === 'string' ? record.repository_url : undefined;
  const owner = typeof record.owner === 'string' ? record.owner : undefined;
  const repo = typeof record.repo === 'string' ? record.repo : undefined;
  if (owner && repo) return { owner, repo, repositoryUrl };
  if (repositoryUrl) {
    const match = repositoryUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/u, ''), repositoryUrl };
    }
  }
  return { repositoryUrl };
}

function extractJiraIssueKey(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const raw = record.issue_key ?? record.key ?? record.id;
  const value = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  return value || undefined;
}

function extractJiraProjectInfo(source: unknown): { domain?: string; projectKey?: string } {
  if (!source || typeof source !== 'object') return {};
  const record = source as Record<string, unknown>;
  return {
    domain: typeof record.domain === 'string' ? record.domain : undefined,
    projectKey: typeof record.projectKey === 'string' ? record.projectKey : undefined,
  };
}

function buildTicketReflectionBody(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  contextPackId?: string;
  contextPackPath?: string;
  ticketState: 'done' | 'review' | 'blocked';
  responseText: string;
  responsePath: string;
  responseExcerpt: string;
  notes: string[];
}): string {
  const lines = [
    `Mission: ${input.missionId}`,
    `Work item: ${input.item.item_id}`,
    input.teamRole ? `Team role: ${input.teamRole}` : '',
    input.assigneePeerId ? `Assignee agent: ${input.assigneePeerId}` : '',
    input.contextPackId ? `Context pack: ${input.contextPackId}` : '',
    input.contextPackPath ? `Context pack path: ${input.contextPackPath}` : '',
    `Result state: ${input.ticketState}`,
    `Response path: ${input.responsePath}`,
    '',
    input.responseText.trim() ? input.responseText.trim() : input.responseExcerpt,
    ...input.notes.map((note) => `- ${note}`),
  ].filter(Boolean);
  return lines.join('\n');
}

function deriveTicketState(
  finalStatus: MissionWorkItemDispatchFinalStatus,
  notes: string[],
): 'done' | 'review' | 'blocked' {
  if (notes.some((note) => /block/i.test(note))) return 'blocked';
  return finalStatus === 'done' ? 'done' : 'review';
}

function updateTicketManifest(missionPath: string, taskId: string, updater: (record: Record<string, unknown>, ticketState: 'done' | 'review' | 'blocked') => void, ticketState: 'done' | 'review' | 'blocked'): void {
  const manifestFile = ticketManifestPath(missionPath);
  const manifest = readJsonFileFromDispatchIO<{ records?: Array<Record<string, unknown>> }>(manifestFile);
  if (!manifest?.records) return;
  const index = manifest.records.findIndex((record) => String(record.task_id || '') === taskId);
  if (index < 0) return;
  updater(manifest.records[index], ticketState);
  writeJsonFileFromDispatchIO(manifestFile, manifest);
}

function updateNextTasksReflection(missionPath: string, taskId: string, payload: Record<string, unknown>): void {
  const nextTasksFile = missionNextTasksPath(missionPath);
  const tasks = readJsonFileFromDispatchIO<Array<Record<string, unknown>>>(nextTasksFile);
  if (!tasks) return;
  const index = tasks.findIndex((task) => String(task.task_id || '') === taskId);
  if (index < 0) return;
  const current = tasks[index];
  tasks[index] = {
    ...current,
    ticket_dispatch: {
      ...(current.ticket_dispatch as Record<string, unknown> | undefined),
      ...payload,
    },
  };
  writeJsonFileFromDispatchIO(nextTasksFile, tasks);
}

function appendComment(existing: unknown, comment: Record<string, unknown>): Record<string, unknown>[] {
  const comments = Array.isArray(existing) ? existing.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[] : [];
  comments.push(comment);
  return comments;
}

async function reflectTicketOutcome(input: {
  missionPath: string;
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  contextPackId?: string;
  contextPackPath?: string;
  finalStatus: MissionWorkItemDispatchFinalStatus;
  responseText: string;
  responsePath: string;
  responseExcerpt: string;
  notes: string[];
  executionMode: 'agent' | 'subagent';
}): Promise<{ ticketState: 'done' | 'review' | 'blocked'; reflectionPath: string; notes: string[] }> {
  const taskId = getWorkItemTaskId(input.item);
  const notes = [...input.notes];
  if (!taskId) {
    notes.push('missing task_id for ticket reflection');
    return {
      ticketState: deriveTicketState(input.finalStatus, notes),
      reflectionPath: '',
      notes,
    };
  }

  const ticketState = deriveTicketState(input.finalStatus, notes);
  const reflectionPath = ticketReplyPath(input.missionPath, taskId);
  const manifest = readJsonFileFromDispatchIO<{ records?: Array<Record<string, unknown>> }>(ticketManifestPath(input.missionPath));
  const manifestRecord = manifest?.records?.find((record) => String(record.task_id || '') === taskId);
  const liveResults = (manifestRecord?.live_results as Record<string, unknown> | undefined) || {};
  const reflectionBody = buildTicketReflectionBody({
    missionId: input.missionId,
    item: input.item,
    teamRole: input.teamRole,
    assigneePeerId: input.assigneePeerId,
    contextPackId: input.contextPackId,
    contextPackPath: input.contextPackPath,
    ticketState,
    responseText: input.responseText,
      responsePath: input.responsePath,
      responseExcerpt: input.responseExcerpt,
      notes,
    });
  const reflectionPayload = {
    mission_id: input.missionId,
    task_id: taskId,
    work_item_id: input.item.item_id,
    team_role: input.teamRole,
    assignee_peer_id: input.assigneePeerId,
    context_pack_id: input.contextPackId,
    context_pack_path: input.contextPackPath,
    execution_mode: input.executionMode,
    ticket_state: ticketState,
    response_path: input.responsePath,
    response_excerpt: input.responseExcerpt,
    notes,
    body: reflectionBody,
    reflected_at: new Date().toISOString(),
  };
  writeDispatchArtifact(reflectionPath, reflectionPayload);

  updateTicketManifest(input.missionPath, taskId, (record, state) => {
    record.reflection_status = ticketState;
    record.reflection_path = reflectionPath;
    record.reflection_excerpt = input.responseExcerpt;
    record.reflected_at = new Date().toISOString();
    record.ticket_state_after = state;
    record.notes = Array.from(new Set([...(Array.isArray(record.notes) ? record.notes as string[] : []), ...notes]));
  }, ticketState);

    updateNextTasksReflection(input.missionPath, taskId, {
      reflected_at: new Date().toISOString(),
      ticket_state: ticketState,
      ticket_reply_path: reflectionPath,
      response_path: input.responsePath,
      response_excerpt: input.responseExcerpt,
      context_pack_id: input.contextPackId,
      context_pack_path: input.contextPackPath,
      result_status: ticketState,
      review_required: ticketState === 'review',
      blocked: ticketState === 'blocked',
      work_item_status_after: input.finalStatus,
    });

  const githubPath = nodePath.join(ticketRoot(input.missionPath), 'github', `${taskId}.json`);
  if (safeExistsSync(githubPath)) {
      const githubIssue = readJsonFileFromDispatchIO<Record<string, unknown>>(githubPath);
    if (githubIssue) {
      const issueNumber = extractGitHubIssueNumber(liveResults.github) || extractGitHubIssueNumber(githubIssue);
      const repoInfo = extractGitHubRepoInfo(githubIssue);
      githubIssue.state = ticketState === 'done' ? 'closed' : 'open';
      githubIssue.state_reason = ticketState === 'done' ? 'completed' : 'reopened';
      githubIssue.comments = appendComment(githubIssue.comments, {
        body: reflectionBody,
        created_at: new Date().toISOString(),
        state: ticketState,
        source: 'workitem-dispatch',
      });
      githubIssue.last_reflection = {
        ticket_state: ticketState,
        reflected_at: new Date().toISOString(),
        response_path: input.responsePath,
        response_excerpt: input.responseExcerpt,
      };
      writeJsonFileFromDispatchIO(githubPath, githubIssue);

      if (repoInfo.owner && repoInfo.repo && issueNumber) {
        try {
          await executeServicePreset('github', 'add_comment', {
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            issue_number: issueNumber,
            body: reflectionBody,
          }, 'secret-guard');
          if (ticketState === 'done') {
            await executeServicePreset('github', 'close_issue', {
              owner: repoInfo.owner,
              repo: repoInfo.repo,
              issue_number: issueNumber,
            }, 'secret-guard');
          }
        } catch (error: any) {
          notes.push(`github reflection failed: ${error?.message || error}`);
        }
      }
    }
  }

  const jiraPath = nodePath.join(ticketRoot(input.missionPath), 'jira', `${taskId}.json`);
  if (safeExistsSync(jiraPath)) {
      const jiraIssue = readJsonFileFromDispatchIO<Record<string, unknown>>(jiraPath);
    if (jiraIssue) {
      const issueKey = extractJiraIssueKey(liveResults.jira) || extractJiraIssueKey(jiraIssue);
      const jiraInfo = {
        ...extractJiraProjectInfo(jiraIssue),
        ...extractJiraProjectInfo(liveResults.jira),
      };
      const fields = (jiraIssue.fields && typeof jiraIssue.fields === 'object' ? jiraIssue.fields as Record<string, unknown> : {});
      fields.status = {
        name: ticketState === 'done' ? 'Done' : ticketState === 'review' ? 'In Review' : 'Blocked',
      };
      jiraIssue.fields = fields;
      jiraIssue.comments = appendComment(jiraIssue.comments, {
        body: reflectionBody,
        created_at: new Date().toISOString(),
        state: ticketState,
        source: 'workitem-dispatch',
      });
      jiraIssue.last_reflection = {
        ticket_state: ticketState,
        reflected_at: new Date().toISOString(),
        response_path: input.responsePath,
        response_excerpt: input.responseExcerpt,
      };
      writeJsonFileFromDispatchIO(jiraPath, jiraIssue);

      if (issueKey && jiraInfo.domain) {
        try {
          await executeServicePreset('jira', 'add_comment', {
            issue_key: issueKey,
            body: reflectionBody,
          }, 'secret-guard');
          if (ticketState === 'done') {
            const transitions = await executeServicePreset('jira', 'get_transitions', {
              issue_key: issueKey,
            }, 'secret-guard');
            const transitionList = Array.isArray((transitions as any)?.transitions)
              ? (transitions as any).transitions
              : Array.isArray((transitions as any)?.body?.transitions)
                ? (transitions as any).body.transitions
                : [];
            const match = transitionList.find((transition: any) => {
              const name = String(transition?.name || transition?.to?.name || '').trim().toLowerCase();
              return ['done', 'closed', 'resolved', 'complete', 'completed'].includes(name);
            });
            if (match?.id) {
              await executeServicePreset('jira', 'transition_issue', {
                issue_key: issueKey,
                transition_id: String(match.id),
              }, 'secret-guard');
            } else {
              notes.push(`jira reflection transition skipped: no done transition for ${issueKey}`);
            }
          }
        } catch (error: any) {
          notes.push(`jira reflection failed: ${error?.message || error}`);
        }
      }
    }
  }

  return {
    ticketState,
    reflectionPath,
    notes,
  };
}

function validateWorkItemGranularity(item: WorkItem, assigneePeerId?: string): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  const description = String(item.description || '').trim();
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  if (!item.assignee_peer_id && !assigneePeerId) {
    notes.push('missing assignee_peer_id');
  }
  if (!description) {
    notes.push('missing description');
  } else if (countWordsFromDispatchIO(description) < 6) {
    notes.push('description too short');
  }
  if (!metadata.deliverable && !metadata.target_path) {
    notes.push('missing deliverable or target_path');
  }
  return { ok: notes.length === 0, notes };
}

function resolveWorkItemProjectId(state: MissionState): string {
  return String(
    state.relationships?.project?.project_id ||
    state.mission_id ||
    '',
  ).trim();
}

function selectWorkItems(state: MissionState, options: MissionWorkItemDispatchOptions): WorkItem[] {
  const missionId = state.mission_id.toUpperCase();
  const projectId = resolveWorkItemProjectId(state);
  const labels = [`mission:${missionId}`];
  const statuses = options.statuses && options.statuses.length > 0
    ? options.statuses
    : (['ready', 'backlog'] as WorkItemStatus[]);
  const sources = options.sources && options.sources.length > 0
    ? options.sources
    : (['local'] as WorkItemSource[]);
  return listWorkItems({
    projectId,
    source: sources,
    status: statuses,
    labels,
  }).filter((item) => getMissionLabel(item) === missionId);
}

function resolveAssigneePeerId(input: { missionId: string; item: WorkItem; teamRole?: string }): string | undefined {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const resolved = metadata.resolved_agent_id;
  if (typeof resolved === 'string' && resolved) return resolved;
  if (input.item.assignee_peer_id) return input.item.assignee_peer_id;
  if (input.teamRole) {
    const assignment = resolveMissionTeamReceiver({ missionId: input.missionId, teamRole: input.teamRole });
    if (assignment?.agent_id) return assignment.agent_id;
  }
  return undefined;
}

function buildDispatchResponseArtifact(input: {
  missionPath: string;
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  contextPackId?: string;
  contextPackPath?: string;
  executionMode: MissionWorkItemDispatchMode | 'agent' | 'subagent';
  responseText: string;
  prompt: string;
}): { filePath: string; payload: Record<string, unknown> } {
  const filePath = nodePath.join(dispatchRoot(input.missionPath), `workitem-dispatch-${input.item.item_id}.json`);
  const payload = {
    mission_id: input.missionId,
    item_id: input.item.item_id,
    team_role: input.teamRole,
    assignee_peer_id: input.assigneePeerId,
    context_pack_id: input.contextPackId,
    context_pack_path: input.contextPackPath,
    execution_mode: input.executionMode,
    prompt: input.prompt,
    response_text: input.responseText,
    response_excerpt: input.responseText.slice(0, 800),
    written_at: new Date().toISOString(),
  };
  return { filePath, payload };
}

function buildWorkItemPromptBody(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
}): string {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const lines = [
    `Execute work item ${input.item.item_id} for mission ${input.missionId}.`,
    input.teamRole ? `Assigned team role: ${input.teamRole}` : '',
    input.assigneePeerId ? `Assigned agent: ${input.assigneePeerId}` : '',
    `Title: ${input.item.title}`,
    `Description: ${input.item.description}`,
    metadata.deliverable ? `Deliverable: ${String(metadata.deliverable)}` : '',
    metadata.target_path ? `Target path: ${String(metadata.target_path)}` : '',
    metadata.assignee_label ? `Assignee label: ${String(metadata.assignee_label)}` : '',
    '',
    'Return a concrete completion note, include any artifact paths written, and call out blockers explicitly.',
  ].filter(Boolean);
  return lines.join('\n');
}

async function buildWorkItemDispatchContext(input: {
  missionPath: string;
  missionId: string;
  missionState: MissionState;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
}): Promise<{ prompt: string; contextPackId: string; contextPackPath: string }> {
  const contextPack = await resolveMissionContextPack({
    missionId: input.missionId,
    tier: input.missionState.tier,
    tenantSlug: input.missionState.tenant_slug,
    recipientKind: input.assigneePeerId ? 'agent' : 'subagent',
    teamRole: input.teamRole,
    assigneePeerId: input.assigneePeerId,
    workItemId: input.item.item_id,
    projectId: input.missionState.relationships?.project?.project_id || input.item.project_id,
    trackId: input.missionState.relationships?.track?.track_id,
    workItem: input.item,
    missionState: input.missionState,
  });
  if (!contextPack) {
    throw new Error(`Unable to resolve mission context pack for ${input.missionId}`);
  }
  const contextPackPath = saveMissionContextPack(input.missionPath, contextPack);
  const prompt = [
    renderMissionContextPack(contextPack),
    '',
    buildWorkItemPromptBody({
      missionId: input.missionId,
      item: input.item,
      teamRole: input.teamRole,
      assigneePeerId: input.assigneePeerId,
    }),
  ].join('\n');
  return {
    prompt,
    contextPackId: contextPack.context_pack_id,
    contextPackPath,
  };
}

async function routeToAgentOrSubagent(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  prompt: string;
  mode: MissionWorkItemDispatchMode;
  adapters: WorkItemDispatchAdapters;
}): Promise<{ executionMode: 'agent' | 'subagent'; responseText: string; notes: string[] }> {
  const prompt = input.prompt;

  const notes: string[] = [];
  if (input.mode === 'subagent' || (!input.assigneePeerId && input.mode === 'auto')) {
    const backend = getReasoningBackend();
    const responseText = input.adapters.delegateTask
      ? await input.adapters.delegateTask(prompt, `workitem:${input.item.item_id}`)
      : await backend.delegateTask(prompt, `workitem:${input.item.item_id}`);
    return { executionMode: 'subagent', responseText, notes };
  }

  if (!input.assigneePeerId) {
    notes.push('missing assignee_peer_id; falling back to subagent');
    const backend = getReasoningBackend();
    const responseText = input.adapters.delegateTask
      ? await input.adapters.delegateTask(prompt, `workitem:${input.item.item_id}`)
      : await backend.delegateTask(prompt, `workitem:${input.item.item_id}`);
    return { executionMode: 'subagent', responseText, notes };
  }

  try {
    const response = input.adapters.routeA2A
      ? await input.adapters.routeA2A({
          a2a_version: '1.0',
          header: {
            msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.item.item_id}`,
            sender: 'kyberion:workitem-dispatcher',
            receiver: input.assigneePeerId,
            performative: 'request',
            timestamp: new Date().toISOString(),
          },
          payload: {
            intent: 'workitem_execution',
            text: prompt,
            context: {
              mission_id: input.missionId,
              work_item_id: input.item.item_id,
              team_role: input.teamRole,
              execution_mode: 'workitem',
            },
          },
        })
      : await a2aBridge.route({
          a2a_version: '1.0',
          header: {
            msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.item.item_id}`,
            sender: 'kyberion:workitem-dispatcher',
            receiver: input.assigneePeerId,
            performative: 'request',
            timestamp: new Date().toISOString(),
          },
          payload: {
            intent: 'workitem_execution',
            text: prompt,
            context: {
              mission_id: input.missionId,
              work_item_id: input.item.item_id,
              team_role: input.teamRole,
              execution_mode: 'workitem',
            },
          },
        });
    return { executionMode: 'agent', responseText: String(response.payload?.text || ''), notes };
  } catch (error: any) {
    notes.push(`agent dispatch failed: ${error?.message || error}; falling back to subagent`);
    const backend = getReasoningBackend();
    const responseText = input.adapters.delegateTask
      ? await input.adapters.delegateTask(prompt, `workitem:${input.item.item_id}`)
      : await backend.delegateTask(prompt, `workitem:${input.item.item_id}`);
    return { executionMode: 'subagent', responseText, notes };
  }
}

export async function dispatchMissionWorkItems(
  state: MissionState,
  options: MissionWorkItemDispatchOptions = {},
  adapters: WorkItemDispatchAdapters = {},
): Promise<MissionWorkItemDispatchManifest> {
  const missionId = state.mission_id.toUpperCase();
  const missionPath = findMissionPath(missionId) || pathResolver.missionDir(missionId, state.tier);
  if (!missionPath) {
    throw new Error(`Mission path not found for ${missionId}`);
  }

  const workItems = selectWorkItems(state, options);
  const existingManifest = readManifest(missionPath);
  const records: MissionWorkItemDispatchRecord[] = [];
  const finalStatus = options.finalStatus || 'review';
  const mode = options.mode || 'auto';
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : workItems.length;

  for (const item of workItems.slice(0, limit)) {
    const teamRole = getTeamRole(item);
    const assigneePeerId = resolveAssigneePeerId({ missionId, item, teamRole });
    const validation = validateWorkItemGranularity(item, assigneePeerId);
    const record: MissionWorkItemDispatchRecord = {
      item_id: item.item_id,
      title: getTaskDescription(item),
      team_role: teamRole,
      assignee_peer_id: assigneePeerId,
      execution_mode: mode,
      status: validation.ok ? 'created' : 'failed',
      work_item_status_before: item.status,
      notes: [...validation.notes],
    };

    if (!validation.ok) {
      records.push(record);
      appendDispatchEvent(dispatchEventPath(missionPath), {
        event_type: 'workitem_dispatch_failed',
        mission_id: missionId,
        item_id: item.item_id,
        team_role: teamRole,
        assignee_peer_id: assigneePeerId,
        notes: validation.notes,
      });
      continue;
    }

    const dispatchContext = await buildWorkItemDispatchContext({
      missionPath,
      missionId,
      missionState: state,
      item,
      teamRole,
      assigneePeerId,
    });

    const response = await routeToAgentOrSubagent({
      missionId,
      item,
      teamRole,
      assigneePeerId,
      prompt: dispatchContext.prompt,
      mode,
      adapters,
    });
    record.execution_mode = response.executionMode;
    record.notes.push(...response.notes);

    const artifact = buildDispatchResponseArtifact({
      missionPath,
      missionId,
      item,
      teamRole,
      assigneePeerId,
      contextPackId: dispatchContext.contextPackId,
      contextPackPath: dispatchContext.contextPackPath,
      executionMode: response.executionMode,
      responseText: response.responseText,
      prompt: dispatchContext.prompt,
    });
    writeDispatchArtifact(artifact.filePath, artifact.payload);
    record.response_path = artifact.filePath;
    record.response_excerpt = response.responseText.slice(0, 400);
    record.context_pack_id = dispatchContext.contextPackId;
    record.context_pack_path = dispatchContext.contextPackPath;

    updateWorkItem({
      itemId: item.item_id,
      status: finalStatus,
      assigneePeerId: assigneePeerId || item.assignee_peer_id,
      metadata: {
        ...(item.metadata || {}),
        last_dispatch_at: new Date().toISOString(),
        last_dispatch_mode: response.executionMode,
        last_dispatch_mission_id: missionId,
        last_dispatch_response_path: artifact.filePath,
        last_dispatch_response_excerpt: record.response_excerpt,
        last_context_pack_id: dispatchContext.contextPackId,
        last_context_pack_path: dispatchContext.contextPackPath,
      },
    });

    const reflection = await reflectTicketOutcome({
      missionPath,
      missionId,
      item,
      teamRole,
      assigneePeerId,
      contextPackId: dispatchContext.contextPackId,
      contextPackPath: dispatchContext.contextPackPath,
      finalStatus,
      responseText: response.responseText,
      responsePath: artifact.filePath,
      responseExcerpt: record.response_excerpt || response.responseText.slice(0, 400),
      notes: record.notes,
      executionMode: response.executionMode,
    });
    record.reflection_status = reflection.ticketState;
    if (reflection.reflectionPath) {
      record.reflection_path = reflection.reflectionPath;
    }
    record.reflection_excerpt = record.response_excerpt;
    record.reflected_at = new Date().toISOString();
    record.ticket_state_after = reflection.ticketState;
    record.notes.push(...reflection.notes);

    appendDispatchEvent(dispatchEventPath(missionPath), {
      event_type: 'workitem_dispatched',
      mission_id: missionId,
      item_id: item.item_id,
      team_role: teamRole,
      assignee_peer_id: assigneePeerId,
      execution_mode: response.executionMode,
      response_path: artifact.filePath,
      status_after: finalStatus,
      ticket_state_after: reflection.ticketState,
      ticket_reflection_path: reflection.reflectionPath || undefined,
      context_pack_id: dispatchContext.contextPackId,
      context_pack_path: dispatchContext.contextPackPath,
    });
    record.status = 'updated';
    record.work_item_status_after = finalStatus;
    records.push(record);
  }

  const manifest: MissionWorkItemDispatchManifest = {
    mission_id: missionId,
    mission_type: state.mission_type,
    tier: state.tier,
    tenant_slug: state.tenant_slug,
    created_at: existingManifest?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    mode,
    final_status: finalStatus,
    work_item_count: records.length,
    records,
  };

  const manifestFilePath = manifestPath(missionPath);
  manifest.manifest_path = manifestFilePath;
  manifest.event_path = dispatchEventPath(missionPath);
  writeJsonFileFromDispatchIO(manifestFilePath, manifest);

  ledger.record('MISSION_WORKITEMS_DISPATCHED', {
    mission_id: missionId,
    work_item_count: records.length,
    mode,
    final_status: finalStatus,
    manifest_path: manifestFilePath,
  });

  logger.info(`[workitems] mission=${missionId} mode=${mode} count=${records.length} final=${finalStatus}`);
  return manifest;
}
