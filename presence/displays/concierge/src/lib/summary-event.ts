export type ConciergeSummary = {
  generated_at: string;
  briefing: {
    sentence_ja: string;
    counts: {
      active_missions: number;
      pending_approvals: number;
      unread_outcomes: number;
      exceptions: number;
    };
    next_action_ja?: string;
  };
  intent_inbox: Array<{
    mission_id: string;
    title: string;
    status_ja: string;
    attention_needed: boolean;
    updated_at?: string;
    success_condition?: string;
  }>;
  approval_queue: Array<{
    id: string;
    channel: string;
    storage_channel: string;
    title: string;
    reason: string;
    requested_at: string;
    expires_at?: string;
    mission_id?: string;
  }>;
  outcome_feed: Array<{
    entry_id: string;
    title: string;
    summary: string;
    artifact_paths: string[];
    mission_id?: string;
    status: string;
    updated_at: string;
  }>;
  exception_feed: Array<{
    id: string;
    title: string;
    text: string;
    surface: string;
    created_at: string;
  }>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasStringFields(record: JsonRecord, fields: string[]): boolean {
  return fields.every((field) => typeof record[field] === 'string');
}

function hasOptionalStringFields(record: JsonRecord, fields: string[]): boolean {
  return fields.every((field) => record[field] === undefined || typeof record[field] === 'string');
}

function isSummaryItemArray(
  value: unknown,
  requiredFields: string[],
  optionalFields: string[] = []
): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (candidate) =>
        isRecord(candidate) &&
        hasStringFields(candidate, requiredFields) &&
        hasOptionalStringFields(candidate, optionalFields)
    )
  );
}

function isIntentInboxItemArray(value: unknown): boolean {
  return (
    isSummaryItemArray(
      value,
      ['mission_id', 'title', 'status_ja'],
      ['updated_at', 'success_condition']
    ) &&
    (value as unknown[]).every(
      (candidate) => isRecord(candidate) && typeof candidate.attention_needed === 'boolean'
    )
  );
}

export function parseConciergeSummaryValue(value: unknown): ConciergeSummary | null {
  if (!isRecord(value) || typeof value.generated_at !== 'string') return null;

  const briefing = value.briefing;
  if (!isRecord(briefing) || typeof briefing.sentence_ja !== 'string') return null;
  if (!hasOptionalStringFields(briefing, ['next_action_ja'])) return null;
  const counts = briefing.counts;
  if (
    !isRecord(counts) ||
    ['active_missions', 'pending_approvals', 'unread_outcomes', 'exceptions'].some(
      (field) =>
        typeof counts[field] !== 'number' || !Number.isInteger(counts[field]) || counts[field] < 0
    )
  ) {
    return null;
  }

  if (
    !isIntentInboxItemArray(value.intent_inbox) ||
    !isSummaryItemArray(
      value.approval_queue,
      ['id', 'channel', 'storage_channel', 'title', 'reason', 'requested_at'],
      ['expires_at', 'mission_id']
    ) ||
    !isSummaryItemArray(
      value.outcome_feed,
      ['entry_id', 'title', 'summary', 'status', 'updated_at'],
      ['mission_id']
    ) ||
    !Array.isArray(value.outcome_feed) ||
    value.outcome_feed.some(
      (candidate) =>
        !isRecord(candidate) ||
        !Array.isArray(candidate.artifact_paths) ||
        candidate.artifact_paths.some((path) => typeof path !== 'string')
    ) ||
    !isSummaryItemArray(value.exception_feed, ['id', 'title', 'text', 'surface', 'created_at'])
  ) {
    return null;
  }
  return value as ConciergeSummary;
}

export function parseConciergeSummaryEvent(raw: string): ConciergeSummary | null {
  try {
    return parseConciergeSummaryValue(JSON.parse(raw));
  } catch {
    return null;
  }
}
