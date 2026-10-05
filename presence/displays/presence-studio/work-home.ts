/**
 * Unified work home, assembled from already viewer-scoped read projections.
 * Pure: no stores, filesystem, network, execution, or approval authority.
 * Every supported input row is returned. Readers own their documented bounds;
 * source totals describe omitted upstream rows instead of hiding truncation.
 * "Supported sources ready" never claims coverage of unimplemented sources.
 */
export type WorkHomeSource =
  'conversation' | 'approval' | 'held_action' | 'task_session' | 'artifact';
export type WorkHomeSourceId =
  'conversation' | 'approvals' | 'held_actions' | 'task_sessions' | 'artifacts';
export type WorkHomeStatus =
  | 'recorded'
  | 'intake'
  | 'queued'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'running'
  | 'verifying'
  | 'blocked'
  | 'unknown'
  | 'answered'
  | 'work_completed'
  | 'completion_unverified'
  | 'failed'
  | 'released'
  | 'artifact_recorded'
  | 'cancel_requested';
export type WorkHomeNextStep =
  | 'provide_input'
  | 'review_approval'
  | 'review_held_action'
  | 'review_blocker'
  | 'inspect_status'
  | 'arrange_execution'
  | 'follow_progress'
  | 'verify_result'
  | 'review_result'
  | 'open_artifact'
  | 'resume_conversation';
export type WorkHomeUnknown =
  | 'recorded_time_unknown'
  | 'verification_unknown'
  | 'completion_not_verified'
  | 'execution_state_unknown'
  | 'version_unknown'
  | 'artifact_time_unknown'
  | 'source_unavailable'
  | 'source_partial';
export type WorkHomeVerification = 'verified' | 'unverified' | 'unknown';
export type WorkHomeAvailability = 'available' | 'partial' | 'unavailable';
export interface WorkHomeSourceInput {
  state: WorkHomeAvailability;
  total?: number;
}
export interface WorkHomeSourceState {
  state: WorkHomeAvailability;
  id: WorkHomeSourceId;
  /** null means the source did not establish a trustworthy total. */
  total: number | null;
  shown: number;
}
/** No caller-supplied hrefs: navigation is built from typed, inert identifiers. */
export interface WorkHomeLink {
  kind: 'conversation' | 'progress' | 'artifact' | 'approval' | 'held_action';
  href: string;
  target_id: string;
}
export interface WorkHomeRelatedInput {
  source: 'conversation' | 'task_session';
  id: string;
  /** Must be the same server-owned scope as the referenced item. */
  scope_id?: string;
}
export interface WorkHomeRecordInput {
  id: string;
  title: string;
  when?: string;
  scope_id?: string;
  /** Display association only. An actual identifier, never a title match. */
  relatedTo?: WorkHomeRelatedInput;
}
export interface WorkHomeDecisionInput extends WorkHomeRecordInput {
  tenant_slug?: string;
}
export interface WorkHomeTaskSessionInput extends WorkHomeRecordInput {
  status: string;
  /** Explicit runtime wait flag; missing requirement names are never needed here. */
  awaiting_user_input?: boolean;
  correlation_id?: string;
  /** Already scoped/redacted history. These are recorded updates, not proof. */
  history?: Array<{ when?: string; text: string }>;
}
export interface WorkHomeArtifactInput extends WorkHomeRecordInput {
  /** Only true after the route's existing file/access check succeeds. */
  downloadable?: boolean;
  kind?: string;
}
/** Structurally matches the exact-viewer conversation read projection. */
export interface WorkHomeConversationInput {
  id: string;
  title: string;
  sourceStatus: 'recorded' | 'answered' | 'completed' | 'awaiting_input' | 'needs_execution';
  createdAt: number;
  lastRecordedAt: number;
  resultExcerpt?: string;
  turnState: 'settled' | 'pending' | 'uncertain' | 'not_started' | 'unknown';
  executionStatus?: string;
  executionSummary?: string;
  workItemId?: string;
  verifiedAt?: number;
  artifact?: {
    requestId: string;
    revision: number;
    format: 'compact' | 'readable';
    parentRequestId?: string;
    parentRevision?: number;
    changeReason?: 'format_change';
    verification: 'verified' | 'pending' | 'unknown';
    currentness: 'latest_verified' | 'older_verified' | 'requested_pending' | 'requested_unknown';
    sha256?: string;
    verifiedAt?: number;
  };
}
export interface WorkHomeArtifact {
  kind: 'conversation_receipt' | 'generic';
  request_id?: string;
  revision?: number;
  format?: 'compact' | 'readable';
  parent_request_id?: string;
  parent_revision?: number;
  change_reason?: 'format_change';
  verification: 'verified' | 'pending' | 'unknown';
  currentness:
    'latest_verified' | 'older_verified' | 'requested_pending' | 'requested_unknown' | 'unknown';
  last_verified_at?: string;
}
export interface WorkHomeResume {
  last_recorded_at?: string;
  last_verified_at?: string;
  next_step_key: string;
  unknowns: WorkHomeUnknown[];
}
export interface WorkHomeItem extends WorkHomeResume {
  id: string;
  source: WorkHomeSource;
  source_id: string;
  source_status: string;
  title: string;
  status: WorkHomeStatus;
  status_key: string;
  verification: WorkHomeVerification;
  links: WorkHomeLink[];
  resume: WorkHomeResume;
  artifact?: WorkHomeArtifact;
  related_to?: string;
}
export interface WorkHomeUpdate {
  kind: 'recorded_status' | 'recorded_update' | 'result' | 'execution' | 'verification';
  item_id: string;
  when?: string;
  status?: WorkHomeStatus;
  text?: string;
}
export interface WorkHomeUpdateGroup {
  item_id: string;
  title: string;
  last_recorded_at?: string;
  entries: WorkHomeUpdate[];
}
export interface WorkHomePayload {
  version: 1;
  scope_id?: string;
  observed_at: string;
  coverage: 'supported_sources_ready' | 'partial' | 'unavailable';
  sources: WorkHomeSourceState[];
  counts: { all: number; attention: number; active: number; answered: number; verified: number };
  items: WorkHomeItem[];
  attention: WorkHomeItem[];
  updates: WorkHomeUpdateGroup[];
}
export interface BuildWorkHomePayloadInput {
  now: Date;
  scopeId?: string;
  conversationWork: { sessionId: string; tasks: WorkHomeConversationInput[] };
  approvals: WorkHomeDecisionInput[];
  heldActions: WorkHomeDecisionInput[];
  taskSessions: WorkHomeTaskSessionInput[];
  artifacts: WorkHomeArtifactInput[];
  /** Omitted sources are unavailable, not successfully empty. */
  sources?: Partial<Record<WorkHomeSourceId, WorkHomeSourceInput>>;
}
const SOURCE_IDS: WorkHomeSourceId[] = [
  'conversation',
  'approvals',
  'held_actions',
  'task_sessions',
  'artifacts',
];
const SOURCE_ID: Record<WorkHomeSource, WorkHomeSourceId> = {
  conversation: 'conversation',
  approval: 'approvals',
  held_action: 'held_actions',
  task_session: 'task_sessions',
  artifact: 'artifacts',
};
const ATTENTION = new Set<WorkHomeStatus>([
  'awaiting_input',
  'awaiting_approval',
  'blocked',
  'unknown',
  'failed',
  'completion_unverified',
  'intake',
]);
const ACTIVE = new Set<WorkHomeStatus>([
  'recorded',
  'intake',
  'queued',
  'awaiting_input',
  'awaiting_approval',
  'running',
  'verifying',
  'blocked',
  'unknown',
  'cancel_requested',
]);
const PRIORITY: Partial<Record<WorkHomeStatus, number>> = {
  awaiting_approval: 0,
  awaiting_input: 1,
  blocked: 2,
  failed: 2,
  unknown: 3,
  completion_unverified: 3,
  intake: 4,
};
function iso(value: string | number | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function encode(id: string): string {
  // Escape lone UTF-16 surrogates as well as URL syntax; never accept raw hrefs.
  return encodeURIComponent(
    Array.from(id, (char) =>
      char.length === 1 && /[\uD800-\uDFFF]/.test(char) ? '\uFFFD' : char
    ).join('')
  );
}
function namespacedId(source: WorkHomeSource, id: string, scope?: string): string {
  return source + ':' + (scope ? encode(scope) + ':' : '') + encode(id);
}
function link(kind: WorkHomeLink['kind'], id: string): WorkHomeLink {
  const href =
    kind === 'conversation'
      ? '/ask?request=' + encode(id)
      : kind === 'progress'
        ? '/progress#' + encode(id)
        : kind === 'artifact'
          ? '/api/artifacts/' + encode(id)
          : kind === 'approval'
            ? '/work#approval-panel'
            : '/work#os-control-plane-panel';
  return { kind, href, target_id: id };
}
function nextStep(status: WorkHomeStatus, source: WorkHomeSource): WorkHomeNextStep {
  if (source === 'held_action') return 'review_held_action';
  if (status === 'awaiting_approval') return 'review_approval';
  if (status === 'awaiting_input') return 'provide_input';
  if (status === 'blocked' || status === 'failed') return 'review_blocker';
  if (status === 'unknown' || status === 'released') return 'inspect_status';
  if (status === 'intake') return 'arrange_execution';
  if (status === 'completion_unverified') return 'verify_result';
  if (status === 'work_completed') return 'review_result';
  if (status === 'answered') return 'resume_conversation';
  if (source === 'artifact') return 'open_artifact';
  if (status === 'recorded') return 'resume_conversation';
  return 'follow_progress';
}
function sessionStatus(status: string): WorkHomeStatus {
  if (
    [
      'queued',
      'awaiting_input',
      'awaiting_approval',
      'running',
      'verifying',
      'blocked',
      'failed',
      'released',
      'cancel_requested',
    ].includes(status)
  )
    return status as WorkHomeStatus;
  if (status === 'completed' || status === 'work_completed') return 'completion_unverified';
  if (status === 'awaiting_instruction' || status === 'collecting_requirements')
    return 'awaiting_input';
  if (status === 'awaiting_confirmation') return 'awaiting_approval';
  if (status === 'executing') return 'running';
  if (status === 'planning') return 'intake';
  if (status === 'paused' || status === 'stalled') return 'blocked';
  return 'unknown';
}
function conversationVerified(row: WorkHomeConversationInput): boolean {
  return (
    row.executionStatus === 'work_completed' &&
    row.artifact?.verification === 'verified' &&
    row.artifact.requestId === row.id &&
    ['latest_verified', 'older_verified'].includes(row.artifact.currentness) &&
    /^[a-f0-9]{64}$/.test(row.artifact.sha256 ?? '') &&
    Number.isSafeInteger(row.artifact.revision) &&
    row.artifact.revision > 0 &&
    Boolean(iso(row.verifiedAt) ?? iso(row.artifact.verifiedAt))
  );
}
function conversationStatus(row: WorkHomeConversationInput): WorkHomeStatus {
  if (row.executionStatus === 'work_completed')
    return conversationVerified(row) ? 'work_completed' : 'unknown';
  if (row.executionStatus !== undefined) {
    if (
      ['queued', 'awaiting_approval', 'running', 'blocked', 'cancel_requested'].includes(
        row.executionStatus
      )
    )
      return row.executionStatus as WorkHomeStatus;
    return 'unknown';
  }
  if (row.turnState === 'uncertain' || row.turnState === 'unknown') return 'unknown';
  // An amendment keeps the prior answer in storage. Until its newest turn
  // settles, that answer is history, not the current request outcome.
  // A fresh execution projection above remains authoritative for execution.
  if (row.turnState === 'pending' || row.turnState === 'not_started') return 'recorded';
  if (row.sourceStatus === 'answered' || row.sourceStatus === 'completed') return 'answered';
  if (row.sourceStatus === 'awaiting_input') return 'awaiting_input';
  if (row.sourceStatus === 'needs_execution') return 'intake';
  return 'recorded';
}
interface Draft {
  item: WorkHomeItem;
  scope?: string;
  related?: WorkHomeRelatedInput;
  updates: WorkHomeUpdate[];
}
function makeItem(
  source: WorkHomeSource,
  row: WorkHomeRecordInput,
  status: WorkHomeStatus,
  sourceStatus: string,
  scope: string | undefined,
  links: WorkHomeLink[],
  verification: WorkHomeVerification = 'unknown',
  verifiedAt?: string
): WorkHomeItem {
  const lastRecorded = iso(row.when);
  const unknowns: WorkHomeUnknown[] = [];
  if (!lastRecorded) unknowns.push('recorded_time_unknown');
  if (verification !== 'verified') unknowns.push('verification_unknown');
  if (status === 'unknown') unknowns.push('execution_state_unknown');
  if (status === 'completion_unverified') unknowns.push('completion_not_verified');
  const resume: WorkHomeResume = {
    ...(lastRecorded ? { last_recorded_at: lastRecorded } : {}),
    ...(verifiedAt ? { last_verified_at: verifiedAt } : {}),
    next_step_key: 'front_desk:work_home_next_' + nextStep(status, source),
    unknowns,
  };
  return {
    id: namespacedId(source, row.id, scope),
    source,
    source_id: row.id,
    title: row.title,
    source_status: sourceStatus,
    status,
    status_key: 'front_desk:work_home_status_' + status,
    verification,
    links,
    ...resume,
    resume,
  };
}
function compareItems(a: WorkHomeItem, b: WorkHomeItem): number {
  const priority = (PRIORITY[a.status] ?? 10) - (PRIORITY[b.status] ?? 10);
  if (priority) return priority;
  const aTime = a.last_recorded_at ? Date.parse(a.last_recorded_at) : 0;
  const bTime = b.last_recorded_at ? Date.parse(b.last_recorded_at) : 0;
  // Decision/input waiters are oldest first; other work is recently recorded first.
  if (aTime !== bTime)
    return ATTENTION.has(a.status) && ATTENTION.has(b.status) ? aTime - bTime : bTime - aTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** Takes read-side projections only; inspecting this payload authorizes nothing. */
export function buildWorkHomePayload(input: BuildWorkHomePayloadInput): WorkHomePayload {
  const drafts: Draft[] = [];
  const add = (
    item: WorkHomeItem,
    scope?: string,
    related?: WorkHomeRelatedInput,
    updates: WorkHomeUpdate[] = []
  ) => {
    drafts.push({
      item,
      scope,
      related,
      updates: [
        {
          kind: 'recorded_status',
          item_id: item.id,
          status: item.status,
          when: item.last_recorded_at,
        },
        ...updates,
      ],
    });
  };
  for (const row of input.conversationWork.tasks) {
    const status = conversationStatus(row);
    const verified = conversationVerified(row);
    const when = iso(row.lastRecordedAt);
    const verifiedAt = verified
      ? (iso(row.verifiedAt) ?? iso(row.artifact?.verifiedAt))
      : undefined;
    const item = makeItem(
      'conversation',
      { id: row.id, title: row.title, when },
      status,
      row.executionStatus ?? row.sourceStatus,
      input.scopeId,
      [link('conversation', row.id)],
      verified ? 'verified' : 'unknown',
      verifiedAt
    );
    if (row.artifact) {
      item.artifact = {
        kind: 'conversation_receipt',
        request_id: row.artifact.requestId,
        revision: row.artifact.revision,
        format: row.artifact.format,
        parent_request_id: row.artifact.parentRequestId,
        parent_revision: row.artifact.parentRevision,
        change_reason: row.artifact.changeReason,
        verification: verified
          ? 'verified'
          : row.artifact.verification === 'pending'
            ? 'pending'
            : 'unknown',
        currentness: verified
          ? row.artifact.currentness === 'older_verified'
            ? 'older_verified'
            : 'latest_verified'
          : row.artifact.currentness === 'requested_pending'
            ? 'requested_pending'
            : 'requested_unknown',
        ...(verifiedAt ? { last_verified_at: verifiedAt } : {}),
      };
      if (verified)
        item.links.push({
          kind: 'artifact',
          href: '/ask?request=' + encode(row.artifact.requestId),
          target_id: row.artifact.requestId,
        });
    }
    const updates: WorkHomeUpdate[] = [];
    if (row.resultExcerpt && row.turnState === 'settled' && row.executionStatus === undefined)
      updates.push({ kind: 'result', item_id: item.id, text: row.resultExcerpt, when });
    if (row.executionSummary)
      updates.push({ kind: 'execution', item_id: item.id, text: row.executionSummary, when });
    if (verifiedAt) updates.push({ kind: 'verification', item_id: item.id, when: verifiedAt });
    add(item, input.scopeId, undefined, updates);
  }
  for (const [source, rows] of [
    ['approval', input.approvals],
    ['held_action', input.heldActions],
  ] as const) {
    for (const row of rows) {
      const scope = row.scope_id ?? row.tenant_slug ?? input.scopeId;
      add(
        makeItem(source, row, 'awaiting_approval', 'pending', scope, [link(source, row.id)]),
        scope,
        row.relatedTo
      );
    }
  }
  for (const row of input.taskSessions) {
    const scope = row.scope_id ?? input.scopeId;
    const terminal = ['completed', 'work_completed', 'failed', 'released'].includes(row.status);
    const status =
      row.awaiting_user_input === true && !terminal ? 'awaiting_input' : sessionStatus(row.status);
    const links = [link('progress', row.id)];
    // A correlation id is an explicit source identifier, never a title match.
    if (
      row.correlation_id &&
      input.conversationWork.tasks.some((task) => task.id === row.correlation_id) &&
      scope === input.scopeId
    )
      links.unshift(link('conversation', row.correlation_id));
    const item = makeItem('task_session', row, status, row.status, scope, links);
    add(
      item,
      scope,
      row.relatedTo,
      (row.history ?? [])
        .filter((entry) => entry.text.trim())
        .map((entry) => ({
          kind: 'recorded_update',
          item_id: item.id,
          text: entry.text,
          when: iso(entry.when),
        }))
    );
  }
  for (const row of input.artifacts) {
    const scope = row.scope_id ?? input.scopeId;
    const links = [link('progress', row.id)];
    if (row.downloadable === true && row.id && !/^\.{1,2}$/.test(row.id))
      links.push(link('artifact', row.id));
    const item = makeItem('artifact', row, 'artifact_recorded', 'recorded', scope, links);
    item.artifact = { kind: 'generic', verification: 'unknown', currentness: 'unknown' };
    item.unknowns.push('version_unknown');
    // A record update time is not an artifact creation or version timestamp.
    item.unknowns.push('artifact_time_unknown');
    add(item, scope, row.relatedTo);
  }
  const sources = SOURCE_IDS.map((id): WorkHomeSourceState => {
    const shown = drafts.filter((draft) => SOURCE_ID[draft.item.source] === id).length;
    const source = input.sources?.[id];
    const validTotal =
      source?.total !== undefined && Number.isSafeInteger(source.total) && source.total >= shown
        ? source.total
        : undefined;
    const state =
      !source || source.state === 'unavailable'
        ? 'unavailable'
        : source.state === 'partial' ||
            (source.total !== undefined && validTotal === undefined) ||
            (validTotal !== undefined && validTotal > shown)
          ? 'partial'
          : 'available';
    return {
      id,
      state,
      total:
        state === 'unavailable' ? null : (validTotal ?? (state === 'available' ? shown : null)),
      shown,
    };
  });
  for (const draft of drafts) {
    const state = sources.find((source) => source.id === SOURCE_ID[draft.item.source])!.state;
    if (state !== 'available')
      draft.item.unknowns.push(state === 'partial' ? 'source_partial' : 'source_unavailable');
    if (!draft.related) continue;
    const target = drafts.find(
      (candidate) =>
        candidate.item.source === draft.related!.source &&
        candidate.item.source_id === draft.related!.id &&
        candidate.scope === draft.scope &&
        (draft.related!.scope_id === undefined || draft.related!.scope_id === candidate.scope)
    );
    if (target && target !== draft) draft.item.related_to = target.item.id;
  }
  const items = drafts.map((draft) => draft.item).sort(compareItems);
  const groups = new Map<string, WorkHomeUpdateGroup>();
  for (const draft of drafts) {
    const id = draft.item.related_to ?? draft.item.id;
    const target = drafts.find((candidate) => candidate.item.id === id)!.item;
    const group = groups.get(id) ?? {
      item_id: id,
      title: target.title,
      last_recorded_at: target.last_recorded_at,
      entries: [],
    };
    group.entries.push(...draft.updates);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    // Verification observed now does not move the last recorded work update.
    for (const entry of group.entries) {
      if (
        entry.kind !== 'verification' &&
        entry.when &&
        (!group.last_recorded_at || entry.when > group.last_recorded_at)
      )
        group.last_recorded_at = entry.when;
    }
    group.entries.sort(
      (a, b) =>
        (a.when ? Date.parse(a.when) : Number.MAX_SAFE_INTEGER) -
        (b.when ? Date.parse(b.when) : Number.MAX_SAFE_INTEGER)
    );
  }
  const attention = items.filter((item) => ATTENTION.has(item.status));
  return {
    version: 1,
    ...(input.scopeId ? { scope_id: input.scopeId } : {}),
    observed_at: input.now.toISOString(),
    coverage: sources.every((source) => source.state === 'available')
      ? 'supported_sources_ready'
      : sources.every((source) => source.state === 'unavailable')
        ? 'unavailable'
        : 'partial',
    sources,
    counts: {
      all: items.length,
      attention: attention.length,
      active: items.filter((item) => ACTIVE.has(item.status)).length,
      answered: items.filter((item) => item.status === 'answered').length,
      verified: items.filter((item) => item.verification === 'verified').length,
    },
    items,
    attention,
    updates: [...groups.values()].sort((a, b) =>
      compareItems(
        items.find((item) => item.id === a.item_id)!,
        items.find((item) => item.id === b.item_id)!
      )
    ),
  };
}
