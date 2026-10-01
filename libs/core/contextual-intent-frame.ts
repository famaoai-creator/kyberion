import type { ValidateFunction } from 'ajv';
import { compileSchema } from './foundation/ajv.js';
import { clamp } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';
import {
  resolveDefaultScheduleSource,
  type ScheduleSourceKind,
} from './contextual-intent-memory.js';
import { matchesIntentPhrase } from './intent/intent-phrase-lexicon.js';

const CONTEXTUAL_INTENT_FRAME_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/contextual-intent-frame.schema.json'
);

export type ContextualIntentAction = 'read' | 'change' | 'unknown';

export interface ContextualIntentFrame {
  kind: 'contextual_intent_frame';
  source_text: string;
  locale: 'ja-JP' | 'en-US';
  action: ContextualIntentAction;
  object: 'calendar_events' | 'calendar_schedule' | 'unknown';
  subject: 'operator_self' | 'team' | 'unknown';
  date_range?: {
    value:
      'today' | 'tomorrow' | 'this_week' | 'next_week' | 'this_month' | 'next_month' | 'custom';
    normalized?: {
      timezone?: string;
      start_iso?: string;
      end_iso?: string;
    };
  };
  source_binding: {
    candidates: ScheduleSourceKind[];
    selected?: ScheduleSourceKind;
    confidence: number;
  };
  missing: string[];
  assumptions: string[];
  confidence: number;
  confidence_breakdown?: {
    action: number;
    object: number;
    subject: number;
    date_range: number;
    source_binding: number;
  };
}

let contextualIntentFrameValidateFn: ValidateFunction | null = null;

function ensureContextualIntentFrameValidator(): ValidateFunction {
  if (contextualIntentFrameValidateFn) return contextualIntentFrameValidateFn;
  contextualIntentFrameValidateFn = compileSchema(CONTEXTUAL_INTENT_FRAME_SCHEMA_PATH);
  return contextualIntentFrameValidateFn;
}

function hasJapaneseChars(text: string): boolean {
  return /[ぁ-んァ-ン一-龯]/.test(text);
}

function inferAction(text: string): ContextualIntentAction {
  if (matchesIntentPhrase(text, 'contextual_frame.change_action')) return 'change';
  if (matchesIntentPhrase(text, 'contextual_frame.read_action')) return 'read';
  return 'unknown';
}

function scoreActionConfidence(action: ContextualIntentAction): number {
  if (action === 'read') return 0.86;
  if (action === 'change') return 0.84;
  return 0.24;
}

function scoreObjectConfidence(object: ContextualIntentFrame['object']): number {
  if (object === 'calendar_schedule') return 0.82;
  if (object === 'calendar_events') return 0.78;
  return 0.22;
}

function scoreSubjectConfidence(subject: ContextualIntentFrame['subject']): number {
  if (subject === 'operator_self') return 0.88;
  if (subject === 'team') return 0.8;
  return 0.24;
}

function inferObject(text: string): ContextualIntentFrame['object'] {
  if (matchesIntentPhrase(text, 'contextual_frame.schedule_object')) return 'calendar_schedule';
  if (matchesIntentPhrase(text, 'schedule.agenda_topic')) return 'calendar_events';
  return 'unknown';
}

function inferSubject(text: string): ContextualIntentFrame['subject'] {
  if (matchesIntentPhrase(text, 'contextual_frame.subject_self')) return 'operator_self';
  if (matchesIntentPhrase(text, 'contextual_frame.subject_team')) return 'team';
  if (matchesIntentPhrase(text, 'contextual_frame.subject_schedule_implicit'))
    return 'operator_self';
  return 'unknown';
}

function inferDateRange(text: string): ContextualIntentFrame['date_range'] | undefined {
  const timezone = 'Asia/Tokyo';
  if (matchesIntentPhrase(text, 'date_range.today'))
    return { value: 'today', normalized: { timezone } };
  if (matchesIntentPhrase(text, 'date_range.tomorrow'))
    return { value: 'tomorrow', normalized: { timezone } };
  if (matchesIntentPhrase(text, 'date_range.this_week'))
    return { value: 'this_week', normalized: { timezone } };
  if (matchesIntentPhrase(text, 'date_range.next_week'))
    return { value: 'next_week', normalized: { timezone } };
  if (matchesIntentPhrase(text, 'date_range.this_month'))
    return { value: 'this_month', normalized: { timezone } };
  if (matchesIntentPhrase(text, 'date_range.next_month'))
    return { value: 'next_month', normalized: { timezone } };
  return undefined;
}

function inferSourceCandidates(text: string): ScheduleSourceKind[] {
  const candidates: ScheduleSourceKind[] = [];
  if (matchesIntentPhrase(text, 'calendar_source.outlook')) candidates.push('outlook_calendar');
  if (matchesIntentPhrase(text, 'calendar_source.google')) {
    candidates.push('google_calendar');
  }
  const defaultSource = resolveDefaultScheduleSource().source;
  if (defaultSource) candidates.push(defaultSource);
  if (candidates.length === 0) candidates.push('browser_calendar');
  return Array.from(new Set(candidates));
}

export function buildContextualIntentFrame(sourceText: string): ContextualIntentFrame {
  const text = sourceText.trim();
  const action = inferAction(text);
  const object = inferObject(text);
  const subject = inferSubject(text);
  const dateRange = inferDateRange(text);
  const sourceCandidates = inferSourceCandidates(text);
  const selected = sourceCandidates[0];
  const selectedFromMemory = resolveDefaultScheduleSource().source;
  const selectedConfidence = selectedFromMemory && selectedFromMemory === selected ? 0.85 : 0.58;
  const missing: string[] = [];
  if (object === 'calendar_events' && action === 'read' && !dateRange) missing.push('date_range');
  if (object === 'calendar_schedule' && !dateRange) missing.push('date_range');
  const dateRangeConfidence = dateRange ? 0.92 : 0.36;

  const assumptions: string[] = [];
  if (subject === 'operator_self')
    assumptions.push("Treat the request as the operator's own calendar unless stated otherwise.");
  if (action === 'read') assumptions.push('Do not mutate the calendar.');
  if (selected) assumptions.push(`Prefer ${selected} as the source binding.`);

  const confidence = clamp(
    scoreActionConfidence(action) * 0.3 +
      scoreObjectConfidence(object) * 0.25 +
      scoreSubjectConfidence(subject) * 0.2 +
      dateRangeConfidence * 0.15 +
      selectedConfidence * 0.1,
    0.42,
    0.98
  );

  return {
    kind: 'contextual_intent_frame',
    source_text: text,
    locale: hasJapaneseChars(text) ? 'ja-JP' : 'en-US',
    action,
    object,
    subject,
    date_range: dateRange,
    source_binding: {
      candidates: sourceCandidates,
      selected,
      confidence: selectedConfidence,
    },
    missing,
    assumptions,
    confidence,
    confidence_breakdown: {
      action: scoreActionConfidence(action),
      object: scoreObjectConfidence(object),
      subject: scoreSubjectConfidence(subject),
      date_range: dateRangeConfidence,
      source_binding: selectedConfidence,
    },
  };
}

export function validateContextualIntentFrame(value: unknown): {
  valid: boolean;
  errors: string[];
  value?: ContextualIntentFrame;
} {
  const validate = ensureContextualIntentFrameValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: valid
      ? []
      : (validate.errors || []).map((error) =>
          `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
        ),
    value: valid ? (value as ContextualIntentFrame) : undefined,
  };
}
