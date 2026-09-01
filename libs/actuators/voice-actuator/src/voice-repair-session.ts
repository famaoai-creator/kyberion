export interface VoiceRepairAttempt {
  segment_id: string;
  attempt: number;
  status: string;
  [key: string]: unknown;
}

export interface VoiceRepairReplacement {
  start_sec: number;
  end_sec: number;
  path: string;
  segment_id: string;
}

export interface VoiceRepairSession {
  version: number;
  created_at: string;
  expires_at: string;
  request_id: string;
  sample_id: string;
  prompt_text: string;
  initial_recording: Record<string, unknown>;
  initial_transcript: Record<string, unknown>;
  verification: Record<string, unknown>;
  repair_attempts: VoiceRepairAttempt[];
  replacements: VoiceRepairReplacement[];
  next_action: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseVoiceRepairSession(value: unknown): VoiceRepairSession | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isNonEmptyString(value.created_at) ||
    !isNonEmptyString(value.expires_at) ||
    !isNonEmptyString(value.request_id) ||
    !isNonEmptyString(value.sample_id) ||
    !isNonEmptyString(value.prompt_text) ||
    !isRecord(value.initial_recording) ||
    !isRecord(value.initial_transcript) ||
    !isRecord(value.verification) ||
    !Array.isArray(value.repair_attempts) ||
    !Array.isArray(value.replacements) ||
    !isNonEmptyString(value.next_action)
  ) {
    return null;
  }

  const repairAttempts: VoiceRepairAttempt[] = [];
  for (const candidate of value.repair_attempts) {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.segment_id) ||
      typeof candidate.attempt !== 'number' ||
      !Number.isSafeInteger(candidate.attempt) ||
      candidate.attempt < 1 ||
      !isNonEmptyString(candidate.status)
    ) {
      return null;
    }
    repairAttempts.push({
      ...candidate,
      segment_id: candidate.segment_id,
      attempt: candidate.attempt,
      status: candidate.status,
    });
  }

  const replacements: VoiceRepairReplacement[] = [];
  for (const candidate of value.replacements) {
    if (
      !isRecord(candidate) ||
      !isFiniteNumber(candidate.start_sec) ||
      !isFiniteNumber(candidate.end_sec) ||
      candidate.start_sec < 0 ||
      candidate.end_sec <= candidate.start_sec ||
      !isNonEmptyString(candidate.path) ||
      !isNonEmptyString(candidate.segment_id)
    ) {
      return null;
    }
    replacements.push({
      start_sec: candidate.start_sec,
      end_sec: candidate.end_sec,
      path: candidate.path,
      segment_id: candidate.segment_id,
    });
  }

  return {
    version: value.version,
    created_at: value.created_at,
    expires_at: value.expires_at,
    request_id: value.request_id,
    sample_id: value.sample_id,
    prompt_text: value.prompt_text,
    initial_recording: value.initial_recording,
    initial_transcript: value.initial_transcript,
    verification: value.verification,
    repair_attempts: repairAttempts,
    replacements,
    next_action: value.next_action,
  };
}
