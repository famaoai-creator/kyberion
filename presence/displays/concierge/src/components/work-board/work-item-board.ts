/**
 * Pure model of the work-item kanban board shared by `/w/work_item` and the
 * operations console 作業ボード: status columns, card ordering, move targets,
 * optimistic moves and a readable one-line summary of raw descriptions.
 *
 * Client-safe: only the import-free display humanizer. Moving a card never happens here — the
 * board only proposes a status; the caller sends it through the governed
 * `/api/ops/workitems` POST and rolls back on error.
 */
import {
  clampText,
  describeActor,
  stripMachineText,
  type ActorNameLookup,
  type DisplayText,
} from '@agent/core/surface/display-humanize';

/** Board columns, left to right (mirrors `WorkItemStatus` minus `archived`). */
export const BOARD_STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'done',
] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export const ARCHIVED_STATUS = 'archived';
/** Every status the governed update route accepts, in board order. */
export const WORK_ITEM_STATUS_ORDER: readonly string[] = [...BOARD_STATUSES, ARCHIVED_STATUS];

/** Vocabulary keys for work-item status names (shared with the console). */
export const WORK_ITEM_STATUS_LABEL_KEYS: Readonly<Record<string, string>> = {
  backlog: 'chronos_status_backlog',
  ready: 'chronos_status_ready',
  in_progress: 'chronos_status_in_progress',
  blocked: 'chronos_blocked_count',
  review: 'chronos_status_review',
  done: 'chronos_status_done',
  archived: 'chronos_status_archived',
};

export interface BoardRef {
  id: string;
  label: string;
}

export interface BoardCard {
  id: string;
  title: string;
  status: string;
  priority?: string;
  assignee?: string;
  project?: BoardRef;
  mission?: BoardRef;
  updatedAt?: string;
  description?: string;
  href?: string;
}

export interface BoardColumn<T extends BoardCard = BoardCard> {
  status: string;
  cards: T[];
}

export interface BoardColumns<T extends BoardCard = BoardCard> {
  columns: BoardColumn<T>[];
  archived: T[];
  /** Cards whose status is not a known column; rendered after the board, never dropped. */
  other: T[];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function compareCards(left: BoardCard, right: BoardCard): number {
  const rank = (card: BoardCard) => PRIORITY_RANK[card.priority ?? ''] ?? 2;
  const byPriority = rank(left) - rank(right);
  if (byPriority !== 0) return byPriority;
  const byUpdated = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
  return byUpdated !== 0 ? byUpdated : left.id.localeCompare(right.id);
}

/** Group cards by status into the fixed columns; within a column urgent first, then most recently updated. */
export function groupBoardColumns<T extends BoardCard>(cards: readonly T[]): BoardColumns<T> {
  const byStatus = new Map<string, T[]>(BOARD_STATUSES.map((status) => [status, []]));
  const archived: T[] = [];
  const other: T[] = [];
  for (const card of cards) {
    const column = byStatus.get(card.status);
    if (column) column.push(card);
    else if (card.status === ARCHIVED_STATUS) archived.push(card);
    else other.push(card);
  }
  return {
    columns: BOARD_STATUSES.map((status) => ({
      status,
      cards: [...(byStatus.get(status) ?? [])].sort(compareCards),
    })),
    archived: archived.sort(compareCards),
    other: other.sort(compareCards),
  };
}

export function isWorkItemStatus(value: unknown): value is string {
  return typeof value === 'string' && WORK_ITEM_STATUS_ORDER.includes(value);
}

/** Statuses a card in `status` can be moved to (the "状態を変更" menu), in board order. */
export function boardMoveTargets(status: string): string[] {
  return WORK_ITEM_STATUS_ORDER.filter((candidate) => candidate !== status);
}

/** A drop on a column: the target status, or null when it is no move (same column, unknown target). */
export function resolveBoardDrop(from: string, to: string): string | null {
  if (!isWorkItemStatus(to) || from === to) return null;
  return to;
}

/** The card list with one card's status replaced (optimistic move / rollback). */
export function withCardStatus<T extends BoardCard>(
  cards: readonly T[],
  id: string,
  status: string
): T[] {
  return cards.map((card) => (card.id === id ? { ...card, status } : card));
}

/** An assignee as a person reads it (shared humanizer: member/agent names, no bare hashes). */
export function actorDisplayName(
  actorId: string | undefined | null,
  render: (text: DisplayText) => string,
  names?: ActorNameLookup
): string | undefined {
  if (!String(actorId ?? '').trim()) return undefined;
  return render(describeActor(actorId, names));
}

/** `MSN-…: Do the thing` → `Do the thing` when the mission is already shown as a chip. */
export function cardTitle(title: string, missionId?: string): string {
  const text = title.trim();
  if (!missionId) return text;
  const prefix = `${missionId}:`;
  if (text.startsWith(prefix)) {
    const rest = text.slice(prefix.length).trim();
    if (rest) return rest;
  }
  return text;
}

/** Whole days since `iso` (0 = today), or null for a missing / invalid date. */
export function ageInDays(iso: string | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / 86_400_000));
}

const PLAN_MARKER = /Managed work plan:\s*/iu;
const TAIL_MARKER = /\s*(?:Rationale:|Proposed by\s|Contributes to:)/iu;
const LABELLED_FIELDS = [
  'Mission',
  'Mission type',
  'Project',
  'Assignee role',
  'Assignee agent',
  'Task',
  'Deliverable',
  'Risk',
];

/** First balanced `{…}` starting at or after `from`, or null. String-aware. */
function balancedJson(text: string, from: number): { start: number; end: number } | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return null;
}

function planGoal(text: string, markerIndex: number): string {
  const blob = balancedJson(text, markerIndex);
  if (!blob) return '';
  try {
    const plan = JSON.parse(text.slice(blob.start, blob.end)) as {
      goal?: unknown;
      missions?: Array<{ goal?: unknown; title?: unknown }>;
    };
    const first = Array.isArray(plan.missions) ? plan.missions[0] : undefined;
    for (const value of [plan.goal, first?.goal, first?.title]) {
      if (typeof value === 'string' && value.trim()) return value;
    }
  } catch {
    /* not JSON after all: fall through to an empty plan goal */
  }
  return '';
}

function labelledField(text: string, field: string): string | undefined {
  const others = LABELLED_FIELDS.filter((entry) => entry !== field)
    .map((entry) => entry.replace(/ /gu, '\\s+'))
    .join('|');
  const pattern = new RegExp(
    `(?:^|\\s)${field.replace(/ /gu, '\\s+')}:\\s*(.+?)(?=\\s+(?:${others}):|$)`,
    'su'
  );
  return text.match(pattern)?.[1]?.trim() || undefined;
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export interface WorkItemDescriptionSummary {
  /** 1–2 readable lines, or '' when nothing adds to the title. */
  summary: string;
  /** The `Deliverable:` of a generated mission-task description, when present. */
  deliverable?: string;
  /** True when the full text holds more than the summary (show a disclosure). */
  hasMore: boolean;
}

/**
 * Readable summary of a work-item description. Generated descriptions carry a
 * serialized plan (`Managed work plan: {…}`), a rationale and a provenance
 * tail, or a `Mission: … Task: … Deliverable: …` field list; neither belongs
 * on a card. Keep the human lead sentence, else the plan goal / task.
 */
export function summarizeWorkItemDescription(
  description: string | undefined,
  title = ''
): WorkItemDescriptionSummary {
  const full = normalize(description ?? '');
  if (!full) return { summary: '', hasMore: false };
  const titleText = normalize(title);
  let lead = '';
  let deliverable: string | undefined;
  if (/^(?:Mission|Project):/u.test(full)) {
    lead = labelledField(full, 'Task') ?? '';
    deliverable = labelledField(full, 'Deliverable');
  } else {
    const marker = full.search(PLAN_MARKER);
    lead = marker >= 0 ? full.slice(0, marker) : full;
    const tail = lead.search(TAIL_MARKER);
    if (tail >= 0) lead = lead.slice(0, tail);
    lead = stripMachineText(lead).text;
    if (!lead && marker >= 0) lead = normalize(planGoal(full, marker));
  }
  lead = normalize(lead);
  const redundant =
    !lead || lead === titleText || (titleText.length > 0 && titleText.endsWith(lead));
  const summary = redundant ? '' : clampText(lead).short;
  return {
    summary,
    ...(deliverable ? { deliverable } : {}),
    hasMore: full !== summary,
  };
}
