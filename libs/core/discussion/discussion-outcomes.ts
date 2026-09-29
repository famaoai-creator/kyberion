import { pathResolver } from '../path-resolver.js';
import { safeWriteFile } from '../secure-io.js';
import { logger } from '../core.js';
import { createArtifactRecord, saveArtifactRecord } from '../workforce/artifact-record.js';
import { createWorkItem } from '../workforce/work-coordination.js';
import { discussionRoleLabel, fillCopy, loadDiscussionCopy } from './discussion-copy.js';
import {
  appendDiscussionEvent,
  readDiscussionRoom,
  sanitizeDiscussionId,
} from './discussion-store.js';
import type { DiscussionRoomState, DiscussionWorkProposal } from './discussion-types.js';

/** Same project a WorkItem falls back to, so an unscoped room still has an owner. */
const FALLBACK_PROJECT_ID = 'default';
const MAX_PROPOSALS = 8;
const TITLE_MAX = 100;

function minutesLogicalPath(roomId: string): string {
  return `active/shared/runtime/discussions/${sanitizeDiscussionId(roomId)}/minutes.md`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Decision-support minutes: everything a reader needs without opening the room. */
export function renderDiscussionMinutes(room: DiscussionRoomState): string {
  const locale = room.config.locale;
  const { minutes: copy } = loadDiscussionCopy();
  const decision = room.decision;
  const lines: string[] = [];
  const bullets = (items: string[]) =>
    items.length ? items.map((item) => `- ${item}`) : [`- ${copy.none[locale]}`];

  lines.push(`# ${fillCopy(copy.title[locale], { title: room.title })}`, '');
  lines.push(`**${copy.goal[locale]}**: ${room.goal}`);
  lines.push(
    `**${copy.status[locale]}**: ${room.status} · **${copy.consensus[locale]}**: ${Math.round(room.consensus * 100)}%`
  );
  lines.push('', `## ${copy.team[locale]}`, '');
  for (const p of room.participants) {
    lines.push(`- ${discussionRoleLabel(p.role, locale)} — ${p.name}`);
  }
  if (decision) {
    lines.push('', `## ${copy.decision[locale]}`, '', decision.summary);
    lines.push('', `### ${copy.agreements[locale]}`, '', ...bullets(decision.agreements));
    lines.push('', `### ${copy.dissent[locale]}`, '', ...bullets(decision.dissent));
    lines.push('', `### ${copy.next_steps[locale]}`, '');
    lines.push(
      ...(decision.next_steps.length
        ? decision.next_steps.map((s, i) => `${i + 1}. ${s}`)
        : bullets([]))
    );
  }
  if (room.votes.length) {
    lines.push('', `## ${copy.votes[locale]}`, '');
    for (const vote of room.votes) {
      const tally = vote.options.map((o) => `${o}: ${vote.tally[o] ?? 0}`).join(' / ');
      lines.push(`- ${vote.question} — ${tally}${vote.winner ? ` (→ ${vote.winner})` : ''}`);
    }
  }
  lines.push('', `## ${copy.transcript[locale]}`);
  let round = 0;
  for (const message of room.messages) {
    if (message.round !== round) {
      round = message.round;
      lines.push('', `### ${fillCopy(copy.round[locale], { round })}`, '');
    }
    const who =
      message.kind === 'human'
        ? copy.human[locale]
        : discussionRoleLabel(
            room.participants.find((p) => p.id === message.speaker)?.role ?? message.speaker,
            locale
          );
    lines.push(`- **${who}**${message.stance ? ` (${message.stance})` : ''}: ${message.text}`);
  }
  lines.push('', '---', fillCopy(copy.footer[locale], { id: room.id }), '');
  return lines.join('\n');
}

/** Each next step of the decision becomes an offer — never an automatic WorkItem. */
export function buildWorkProposals(room: DiscussionRoomState): DiscussionWorkProposal[] {
  const decision = room.decision;
  if (!decision) return [];
  const locale = room.config.locale;
  const { work_proposal } = loadDiscussionCopy();
  const minutesPath = minutesLogicalPath(room.id);
  return decision.next_steps.slice(0, MAX_PROPOSALS).map((step, index) => ({
    id: `wp-${index + 1}`,
    title: clip(step, TITLE_MAX),
    description: `${step}\n\n${fillCopy(work_proposal.description[locale], {
      title: room.title,
      decision: decision.summary,
      minutes: minutesPath,
    })}`,
    priority: index === 0 ? 'high' : 'normal',
  }));
}

/**
 * After a decision: register the minutes as a deliverable (visible in the
 * Deliverables inbox under the room's tenant / organization / project /
 * mission) and offer the follow-ups as WorkItem proposals. Idempotent.
 */
export function publishDiscussionOutcomes(roomId: string): void {
  const room = readDiscussionRoom(roomId);
  if (!room?.decision) return;
  if (room.outcomes.proposals.length === 0) {
    const proposals = buildWorkProposals(room);
    if (proposals.length) appendDiscussionEvent(room.id, { type: 'outcomes_proposed', proposals });
  }
  if (room.outcomes.minutes) return;
  try {
    const logicalPath = minutesLogicalPath(room.id);
    const markdown = renderDiscussionMinutes(room);
    safeWriteFile(pathResolver.rootResolve(logicalPath), markdown);
    const record = createArtifactRecord({
      kind: 'markdown',
      storage_class: 'repo',
      path: logicalPath,
      preview_text: clip(room.decision.summary, 400),
      ...(room.scope.tenant_slug ? { tenant_slug: room.scope.tenant_slug } : {}),
      ...(room.scope.organization_id ? { organization_id: room.scope.organization_id } : {}),
      project_id: room.scope.project_id ?? FALLBACK_PROJECT_ID,
      ...(room.scope.mission_id ? { mission_id: room.scope.mission_id } : {}),
      metadata: {
        source: 'discussion_room',
        // Deliverables fail closed without a tier; discussions default to confidential.
        tier: room.scope.tier ?? 'confidential',
        discussion_id: room.id,
        title: room.title,
        consensus: room.consensus,
      },
    });
    saveArtifactRecord(record);
    appendDiscussionEvent(room.id, {
      type: 'minutes_published',
      artifact_id: record.artifact_id,
      path: logicalPath,
      kind: record.kind,
    });
  } catch (error) {
    // The decision stands even if the deliverable could not be registered.
    logger.warn(
      `[discussion] minutes were not published for ${room.id}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface CreateWorkItemsResult {
  created: Array<{ proposal_id: string; item_id: string }>;
  skipped: string[];
}

/**
 * The human gate: turn selected proposals into backlog WorkItems that carry
 * the room's canonical context chain (tenant → organization → project →
 * mission). A proposal already converted is skipped, so a double click is safe.
 */
export function createWorkItemsFromDecision(
  roomId: string,
  actor: string,
  proposalIds?: string[]
): CreateWorkItemsResult {
  const room = readDiscussionRoom(roomId);
  if (!room?.decision) throw new Error('The discussion has no decision yet');
  const wanted = new Set(proposalIds ?? room.outcomes.proposals.map((p) => p.id));
  const result: CreateWorkItemsResult = { created: [], skipped: [] };
  for (const proposal of room.outcomes.proposals) {
    if (!wanted.has(proposal.id)) continue;
    if (room.outcomes.work_items[proposal.id]) {
      result.skipped.push(proposal.id);
      continue;
    }
    const item = createWorkItem({
      title: proposal.title,
      description: proposal.description,
      priority: proposal.priority,
      status: 'backlog',
      source: 'local',
      sourceRef: `discussion:${room.id}#${proposal.id}`,
      ...(room.scope.project_id ? { projectId: room.scope.project_id } : {}),
      labels: ['discussion', `discussion:${room.id}`],
      context: {
        ...(room.scope.tenant_slug ? { tenant_slug: room.scope.tenant_slug } : {}),
        ...(room.scope.organization_id ? { organization_id: room.scope.organization_id } : {}),
        ...(room.scope.project_id ? { project_id: room.scope.project_id } : {}),
        ...(room.scope.mission_id ? { mission_id: room.scope.mission_id } : {}),
        work_shape: 'solution_project',
      },
      metadata: {
        discussion_id: room.id,
        proposal_id: proposal.id,
        created_by: actor,
        ...(room.outcomes.minutes
          ? { minutes_artifact_id: room.outcomes.minutes.artifact_id }
          : {}),
      },
    });
    result.created.push({ proposal_id: proposal.id, item_id: item.item_id });
  }
  if (result.created.length) {
    appendDiscussionEvent(room.id, { type: 'workitems_created', actor, links: result.created });
  }
  return result;
}
