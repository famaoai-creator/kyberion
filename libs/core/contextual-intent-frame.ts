import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { resolveDefaultScheduleSource, type ScheduleSourceKind } from './contextual-intent-memory.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const CONTEXTUAL_INTENT_FRAME_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/contextual-intent-frame.schema.json'
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
    value: 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'this_month' | 'next_month' | 'custom';
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
  contextualIntentFrameValidateFn = compileSchemaFromPath(ajv, CONTEXTUAL_INTENT_FRAME_SCHEMA_PATH);
  return contextualIntentFrameValidateFn;
}

function hasJapaneseChars(text: string): boolean {
  return /[ぁ-んァ-ン一-龯]/.test(text);
}

function inferAction(text: string): ContextualIntentAction {
  if (
    /(調整|変更|リスケ|ずら|移動|移して|修正|入れ替え|前倒し|後ろ|見直し|再調整|詰め直し|組み直|並べ替え|再編成|再配置|整えて|change|update|resched|reschedule)/i.test(
      text
    )
  )
    return 'change';
  if (/(教えて|見せて|確認|見る|空き|予定|会議|ミーティング|打ち合わせ|アポイント|agenda|available|availability|show|see)/i.test(text))
    return 'read';
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
  if (
    /(調整|変更|リスケ|ずら|移動|移して|修正|入れ替え|前倒し|後ろ|見直し|再調整|詰め直し|組み直|並べ替え|再編成|再配置|整えて|calendar|schedule)/i.test(
      text
    )
  )
    return 'calendar_schedule';
  if (/(予定|スケジュール|日程|空き時間|会議|ミーティング|打ち合わせ|アポイント|calendar|agenda|availability)/i.test(text))
    return 'calendar_events';
  return 'unknown';
}

function inferSubject(text: string): ContextualIntentFrame['subject'] {
  if (/(私|自分|俺|僕|私の|自分の|my|me|mine|operator|本人)/i.test(text)) return 'operator_self';
  if (/(チーム|みんな|全員|team|our)/i.test(text)) return 'team';
  if (/(予定|スケジュール|日程|空き時間|会議|ミーティング|アポイント|打ち合わせ|カレンダー|calendar|リスケ|調整|変更|ずら|移動|修正|schedule)/i.test(text))
    return 'operator_self';
  return 'unknown';
}

function inferDateRange(text: string): ContextualIntentFrame['date_range'] | undefined {
  const timezone = 'Asia/Tokyo';
  if (/(今日|本日|today)/i.test(text)) return { value: 'today', normalized: { timezone } };
  if (/(明日|tomorrow)/i.test(text)) return { value: 'tomorrow', normalized: { timezone } };
  if (/(今週|this week)/i.test(text)) return { value: 'this_week', normalized: { timezone } };
  if (/(来週|next week)/i.test(text)) return { value: 'next_week', normalized: { timezone } };
  if (/(今月|this month)/i.test(text)) return { value: 'this_month', normalized: { timezone } };
  if (/(来月|next month)/i.test(text)) return { value: 'next_month', normalized: { timezone } };
  return undefined;
}

function inferSourceCandidates(text: string): ScheduleSourceKind[] {
  const candidates: ScheduleSourceKind[] = [];
  if (/(Outlook|Microsoft 365|Microsoft|Teams)/i.test(text)) candidates.push('outlook_calendar');
  if (/(Google Calendar|Googleカレンダー|calendar\.google\.com|Google)/i.test(text)) {
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
  if (subject === 'operator_self') assumptions.push('Treat the request as the operator\'s own calendar unless stated otherwise.');
  if (action === 'read') assumptions.push('Do not mutate the calendar.');
  if (selected) assumptions.push(`Prefer ${selected} as the source binding.`);

  const confidence = Math.min(
    0.98,
    Math.max(
      0.42,
      scoreActionConfidence(action) * 0.3 +
        scoreObjectConfidence(object) * 0.25 +
        scoreSubjectConfidence(subject) * 0.2 +
        dateRangeConfidence * 0.15 +
        selectedConfidence * 0.1
    )
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

export function validateContextualIntentFrame(
  value: unknown
): { valid: boolean; errors: string[]; value?: ContextualIntentFrame } {
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
