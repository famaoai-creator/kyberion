import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeReadFileSnapshot,
  safeWriteFile,
} from '../secure-io.js';
import { logger } from '../core.js';
import {
  createArtifactRecord,
  loadArtifactRecord,
  saveArtifactRecord,
  type ArtifactRecord,
} from '../workforce/artifact-record.js';
import { renderDiscussionBriefHtml } from './discussion-brief.js';
import { createWorkItem } from '../workforce/work-coordination.js';
import {
  discussionExecutionSummary,
  discussionRoleLabel,
  fillCopy,
  loadDiscussionCopy,
} from './discussion-copy.js';
import {
  appendDiscussionEvent,
  DiscussionUserError,
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

function briefLogicalPath(roomId: string): string {
  return `active/shared/runtime/discussions/${sanitizeDiscussionId(roomId)}/brief.html`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Decision-support minutes: everything a reader needs without opening the room. */
export function renderDiscussionMinutes(room: DiscussionRoomState): string {
  const locale = room.config.locale;
  const { minutes: copy, execution: executionCopy } = loadDiscussionCopy();
  const execution = discussionExecutionSummary(room);
  const decision = room.decision;
  const lines: string[] = [];
  const bullets = (items: string[]) =>
    items.length ? items.map((item) => `- ${item}`) : [`- ${copy.none[locale]}`];

  lines.push(
    `# ${fillCopy(room.config.single_pass ? executionCopy.single_pass_record[locale] : copy.title[locale], { title: room.title })}`,
    ''
  );
  lines.push(`**${copy.goal[locale]}**: ${room.goal}`);
  lines.push(
    `**${copy.status[locale]}**: ${room.status}` +
      (room.config.single_pass
        ? ''
        : ` · **${copy.consensus[locale]}**: ${Math.round(room.consensus * 100)}%`)
  );
  lines.push(
    '',
    `## ${execution.heading}`,
    '',
    execution.notice,
    '',
    ...execution.entries.map(([label, value]) => `- **${label}**: ${value}`)
  );
  lines.push('', `## ${copy.team[locale]}`, '');
  for (const p of room.participants) {
    lines.push(`- ${discussionRoleLabel(p.role, locale)} — ${p.name}`);
  }
  if (decision) {
    lines.push(
      '',
      `## ${room.config.single_pass ? executionCopy.draft[locale] : copy.decision[locale]}`,
      '',
      decision.summary
    );
    lines.push(
      '',
      `### ${room.config.single_pass ? executionCopy.rationale[locale] : copy.agreements[locale]}`,
      '',
      ...bullets(decision.agreements)
    );
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

export const MAX_SAVED_DISCUSSION_ARTIFACT_BYTES = 5 * 1024 * 1024;

type SavedArtifactSlot = 'minutes' | 'brief';

export class SavedDiscussionArtifactError extends Error {
  constructor(
    public readonly code: 'unverified' | 'integrity_mismatch' | 'unavailable' | 'too_large',
    message: string,
    public readonly status: 409 | 413 = 409
  ) {
    super(message);
    this.name = 'SavedDiscussionArtifactError';
  }
}

function validSavedId(value: string, max: number): boolean {
  return value.length <= max && /^[A-Za-z0-9._-]+$/u.test(value) && value !== '.' && value !== '..';
}

function artifactSpec(room: DiscussionRoomState, slot: SavedArtifactSlot) {
  return slot === 'minutes'
    ? { path: minutesLogicalPath(room.id), kind: 'markdown' as const, name: 'minutes.md' }
    : { path: briefLogicalPath(room.id), kind: 'html' as const, name: 'brief.html' };
}

/** Bind the room event and ownership record before any artifact filesystem probe. */
function boundArtifactRecord(room: DiscussionRoomState, artifactId: string) {
  if (!validSavedId(room.id, 96) || !validSavedId(artifactId, 160)) return null;
  const matches = (['minutes', 'brief'] as const).filter(
    (slot) => room.outcomes[slot]?.artifact_id === artifactId
  );
  if (matches.length !== 1) return null;
  const slot = matches[0];
  const reference = room.outcomes[slot]!;
  const spec = artifactSpec(room, slot);
  if (reference.path !== spec.path) return null;
  if (slot === 'minutes' && room.outcomes.minutes?.kind !== spec.kind) return null;
  const record = loadArtifactRecord(artifactId);
  if (
    !record ||
    record.artifact_id !== artifactId ||
    record.storage_class !== 'repo' ||
    record.path !== spec.path ||
    record.kind !== spec.kind ||
    record.external_ref !== undefined ||
    record.tenant_slug !== room.scope.tenant_slug ||
    record.organization_id !== room.scope.organization_id ||
    record.project_id !== (room.scope.project_id ?? FALLBACK_PROJECT_ID) ||
    record.mission_id !== room.scope.mission_id ||
    record.metadata?.source !== 'discussion_room' ||
    record.metadata?.discussion_id !== room.id ||
    record.metadata?.tier !== (room.scope.tier ?? 'confidential')
  )
    return null;
  return { record, slot, ...spec };
}

/**
 * Read only the exact saved bytes owned by an already-authorized room. The HTTP
 * caller must resolve its viewer and authorize the room AND tier first. This
 * function adds immutable room/record/path binding, never a broader path grant.
 */
export function readSavedDiscussionArtifact(
  room: DiscussionRoomState,
  artifactId: string
): {
  name: string;
  kind: 'markdown' | 'html';
  bytes: Buffer;
  sha256: string;
} | null {
  const bound = boundArtifactRecord(room, artifactId);
  if (!bound) return null;
  const sha256 = bound.record.metadata?.content_sha256;
  const expectedBytes = bound.record.metadata?.content_bytes;
  if (sha256 === undefined && expectedBytes === undefined) {
    throw new SavedDiscussionArtifactError(
      'unverified',
      'This saved artifact has no integrity evidence. Use the current brief view or regenerate the discussion deliverables.'
    );
  }
  if (
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    typeof expectedBytes !== 'number' ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0
  ) {
    throw new SavedDiscussionArtifactError(
      'integrity_mismatch',
      'Saved artifact integrity evidence is invalid.'
    );
  }
  if (expectedBytes > MAX_SAVED_DISCUSSION_ARTIFACT_BYTES) {
    throw new SavedDiscussionArtifactError(
      'too_large',
      'Saved artifact exceeds the size limit.',
      413
    );
  }
  let bytes: Buffer;
  try {
    const file = assertSafeRepositoryPath(pathResolver.rootResolve(bound.path));
    const stat = safeLstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SavedDiscussionArtifactError(
        'unavailable',
        'Saved artifact is not a safe regular file.'
      );
    }
    if (stat.size > MAX_SAVED_DISCUSSION_ARTIFACT_BYTES) {
      throw new SavedDiscussionArtifactError(
        'too_large',
        'Saved artifact exceeds the size limit.',
        413
      );
    }
    // This primitive checks every component, pins the inode, rejects symlinks,
    // non-regular files and concurrent changes, and bounds allocation + reads.
    bytes = safeReadFileSnapshot(file, MAX_SAVED_DISCUSSION_ARTIFACT_BYTES);
  } catch (error) {
    if (error instanceof SavedDiscussionArtifactError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SavedDiscussionArtifactError(
      'unavailable',
      'Saved artifact could not be read safely.'
    );
  }
  if (
    bytes.length !== expectedBytes ||
    createHash('sha256').update(bytes).digest('hex') !== sha256
  ) {
    throw new SavedDiscussionArtifactError(
      'integrity_mismatch',
      'Saved artifact differs from its integrity evidence. Regenerate the discussion deliverables.'
    );
  }
  return { name: bound.name, kind: bound.kind, bytes, sha256 };
}

function saveDiscussionArtifact(room: DiscussionRoomState, slot: SavedArtifactSlot): void {
  const spec = artifactSpec(room, slot);
  const reference = room.outcomes[slot];
  const existing = reference ? boundArtifactRecord(room, reference.artifact_id) : null;
  if (reference && !existing) throw new Error('Saved discussion artifact ownership is unavailable');
  const bytes = Buffer.from(
    slot === 'minutes'
      ? renderDiscussionMinutes(room)
      : renderDiscussionBriefHtml(room, { mode: 'view' }),
    'utf8'
  );
  if (bytes.length > MAX_SAVED_DISCUSSION_ARTIFACT_BYTES) {
    throw new SavedDiscussionArtifactError(
      'too_large',
      'Saved artifact exceeds the size limit.',
      413
    );
  }
  const execution = room.execution;
  const metadata = {
    ...existing?.record.metadata,
    source: 'discussion_room',
    tier: room.scope.tier ?? 'confidential',
    discussion_id: room.id,
    title: room.title,
    consensus: room.consensus,
    content_sha256: createHash('sha256').update(bytes).digest('hex'),
    content_bytes: bytes.length,
    discussion_execution: execution
      ? {
          requested_mode: execution.requested_mode,
          actual_mode: execution.actual_mode,
          requested_provider: execution.requested_provider,
          provider: execution.provider,
          model: execution.model,
          calls_used: execution.attempts.length,
          call_budget: execution.call_budget,
          timeout_ms: execution.timeout_ms,
          internal_turn_limit: execution.internal_turn_limit,
        }
      : { actual_mode: 'unknown', provider: null, model: null },
    ...(slot === 'brief' ? { view: 'decision_brief' } : {}),
  };
  const input: Omit<ArtifactRecord, 'artifact_id'> = {
    ...(existing?.record ?? {}),
    storage_class: 'repo',
    ...(room.scope.tenant_slug ? { tenant_slug: room.scope.tenant_slug } : {}),
    ...(room.scope.organization_id ? { organization_id: room.scope.organization_id } : {}),
    project_id: room.scope.project_id ?? FALLBACK_PROJECT_ID,
    ...(room.scope.mission_id ? { mission_id: room.scope.mission_id } : {}),
    kind: spec.kind,
    path: spec.path,
    preview_text: clip(room.decision?.summary ?? room.goal, 400),
    metadata,
  };
  const record = existing
    ? { ...input, artifact_id: existing.record.artifact_id }
    : createArtifactRecord(input);
  // Each update preserves its identity and recomputes the evidence. A failure
  // between file and record writes leaves a mismatch, which retrieval rejects.
  safeWriteFile(pathResolver.rootResolve(spec.path), bytes);
  saveArtifactRecord(record);
  if (!reference) {
    if (slot === 'minutes')
      appendDiscussionEvent(room.id, {
        type: 'minutes_published',
        artifact_id: record.artifact_id,
        path: spec.path,
        kind: spec.kind,
      });
    else
      appendDiscussionEvent(room.id, {
        type: 'brief_published',
        artifact_id: record.artifact_id,
        path: spec.path,
      });
  }
}

const PUBLICATION_FAILURE =
  'Decision generated but saved artifact publication failed; no model retry performed.';

function recordPublicationFailure(roomId: string): void {
  logger.warn(
    '[discussion] saved artifact publication failed — room=' +
      roomId +
      ' | next=inspect storage and refresh deliverables; no model retry'
  );
  try {
    appendDiscussionEvent(roomId, { type: 'error', message: PUBLICATION_FAILURE });
  } catch {
    // If even the room log is unavailable, propagate only a fixed safe message.
    throw new Error(PUBLICATION_FAILURE);
  }
}

/** Publish saved minutes and brief with integrity evidence; refresh existing IDs. */
export function publishDiscussionOutcomes(roomId: string): void {
  const room = readDiscussionRoom(roomId);
  if (!room?.decision) return;
  if (room.outcomes.proposals.length === 0) {
    const proposals = buildWorkProposals(room);
    if (proposals.length) appendDiscussionEvent(room.id, { type: 'outcomes_proposed', proposals });
  }
  try {
    const fresh = readDiscussionRoom(roomId) as DiscussionRoomState;
    saveDiscussionArtifact(fresh, 'minutes');
    saveDiscussionArtifact(fresh, 'brief');
  } catch {
    recordPublicationFailure(room.id);
  }
}

/** Refresh files AND evidence after edits/review without replacing artifact IDs. */
export function refreshDiscussionDeliverables(roomId: string): void {
  const room = readDiscussionRoom(roomId);
  if (!room?.decision) return;
  try {
    saveDiscussionArtifact(room, 'minutes');
    saveDiscussionArtifact(room, 'brief');
  } catch {
    recordPublicationFailure(room.id);
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
  if (!room?.decision) throw new DiscussionUserError('The discussion has no decision yet');
  const wanted = new Set(
    proposalIds ?? room.outcomes.proposals.filter((p) => p.included !== false).map((p) => p.id)
  );
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
      labels: [
        'discussion',
        `discussion:${room.id}`,
        ...(proposal.owner_role ? [`owner-role:${proposal.owner_role}`] : []),
      ],
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
        ...(proposal.owner_role ? { owner_role: proposal.owner_role } : {}),
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
