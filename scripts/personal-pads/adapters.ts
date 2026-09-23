/** Typed adapter seams for the unified local-pads desk.
 *
 * The server owns transport and authorization. Adapters own the input shape
 * and canonical capture representation, so adding a pad does not require a
 * new route or a branch in the server.
 *
 * PA-07: adapter definitions carry vocabulary keys (`personal_pads:*`), never
 * literal text. `getPadAdapter(padId, locale)` resolves them for one request
 * locale; the browser receives the localized descriptors.
 */
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { defaultPadLocale, padsText } from './i18n.js';
import { getPadRegistryEntry, PAD_REGISTRY, type PadId, type PadInputKind } from './registry.js';

export type AdapterFieldKind =
  'text' | 'textarea' | 'select' | 'file' | 'image' | 'drawing' | 'recording';

/** Drawing tools of the shared `ui:sketch-board` (the kit renders their localized labels). */
export type DrawingToolId = 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'eraser';

export interface DrawingToolDescriptor {
  id: DrawingToolId;
}

export interface VoiceInputDescriptor {
  label: string;
}

export interface DrawingDownloadDescriptor {
  filename: string;
}

/**
 * Actions are deliberately declarative at the adapter boundary.  The
 * browser only receives this safe descriptor; the server resolves the
 * executor from the typed action registry after scope authorization.
 */
export type PadActionEffect = 'read' | 'derive' | 'propose' | 'apply';

export type PadActionCapability =
  'os-clipboard' | 'os-screenshot' | 'speech-to-text' | 'reasoning' | 'governed';

export interface PadActionDescriptor {
  id: string;
  label: string;
  description: string;
  effect: PadActionEffect;
  /** Capability hint for the host. It never grants permission by itself. */
  capability?: PadActionCapability;
  /** Fail fast when an expensive local action is already running. */
  max_concurrent?: number;
  /** Optional typed form rendered only for this action. */
  input_fields?: readonly AdapterField[];
}

export interface AdapterField {
  id: string;
  label: string;
  kind: AdapterFieldKind;
  placeholder?: string;
  help?: string;
  accept?: string;
  /** File inputs may promote more than one original attachment. */
  multiple?: boolean;
  options?: readonly { value: string; label: string }[];
  /** Optional image field rendered beneath this drawing layer. */
  overlay_field?: string;
  /** Image fields may accept clipboard paste and drag/drop through the shell. */
  paste_drop?: boolean;
  /** Drawing controls are declared by the adapter and rendered by the shared shell. */
  drawing_tools?: readonly DrawingToolDescriptor[];
  /** Optional browser speech affordance for a text field. */
  voice_input?: VoiceInputDescriptor;
  /** Optional local PNG export affordance for a drawing field. */
  download?: DrawingDownloadDescriptor;
}

/** An adapter field as declared: every user-visible string is a vocabulary key. */
export interface AdapterFieldDefinition extends Omit<
  AdapterField,
  'label' | 'placeholder' | 'help' | 'options' | 'voice_input'
> {
  label: VocabularyKey;
  placeholder?: VocabularyKey;
  help?: VocabularyKey;
  options?: readonly { value: string; label: VocabularyKey }[];
  voice_input?: { label: VocabularyKey };
}

export interface PadActionDefinition extends Omit<
  PadActionDescriptor,
  'label' | 'description' | 'input_fields'
> {
  label: VocabularyKey;
  description: VocabularyKey;
  input_fields?: readonly AdapterFieldDefinition[];
}

export interface PadAdapterDefinition {
  id: string;
  pad_id: PadId;
  input_kind: PadInputKind;
  body_mode: 'freeform' | 'composed';
  fields: readonly AdapterFieldDefinition[];
  actions: readonly PadActionDefinition[];
  /** Vocabulary key of the `{field}` template that composes the saved body. */
  preview_template: VocabularyKey;
}

export interface AdapterCaptureInput {
  body: string;
  title?: string;
  fields: Record<string, unknown>;
  artifact_manifest?: readonly string[];
  /** Legacy routes may preserve their historical empty-submit behavior. */
  allow_empty?: boolean;
}

export interface AdapterCaptureResult {
  body: string;
  artifact_manifest: readonly string[];
  artifacts: readonly AdapterArtifact[];
  /** Restorable, non-binary field state for history editing. */
  payload: Readonly<Record<string, string>>;
}

export interface AdapterArtifact {
  field_id: string;
  name: string;
  mime: string;
  data_base64: string;
}

export interface PadAdapter {
  id: string;
  pad_id: PadId;
  input_kind: PadInputKind;
  body_mode: 'freeform' | 'composed';
  fields: readonly AdapterField[];
  actions: readonly PadActionDescriptor[];
  preview_template: string;
  parseInput(input: AdapterCaptureInput): AdapterCaptureInput;
  validateInput(input: AdapterCaptureInput): void;
  renderPreview(input: AdapterCaptureInput): string;
  composeCapture(input: AdapterCaptureInput): AdapterCaptureResult;
}

type AdapterConfig = Omit<
  PadAdapter,
  'parseInput' | 'validateInput' | 'renderPreview' | 'composeCapture'
>;

function text(fields: Record<string, unknown>, id: string): string {
  return typeof fields[id] === 'string' ? fields[id].trim() : '';
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z0-9_]+)\}/gu, (_, key: string) => values[key] ?? '').trim();
}

function manifest(input: AdapterCaptureInput, fields: Record<string, unknown>): string[] {
  const names = [
    ...(input.artifact_manifest ?? []),
    ...Object.entries(fields)
      .filter(([key, value]) => key.endsWith('_name') && typeof value === 'string')
      .map(([, value]) => String(value)),
  ];
  return [...new Set(names.map(String).filter(Boolean))].slice(0, 100);
}

function dataUrl(value: string): { mime: string; data_base64: string } | undefined {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/u.exec(value.trim());
  if (!match) return undefined;
  const data_base64 = match[2].replace(/\s+/g, '');
  if (!data_base64) return undefined;
  return { mime: match[1] || 'application/octet-stream', data_base64 };
}

function makeAdapter(config: AdapterConfig, drawingMarker: string): PadAdapter {
  const declaredFields = [
    ...config.fields,
    ...config.actions.flatMap((action) => action.input_fields ?? []),
  ];
  const parseInput = (input: AdapterCaptureInput): AdapterCaptureInput => ({
    body: String(input.body ?? ''),
    title: String(input.title ?? ''),
    fields:
      input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)
        ? input.fields
        : {},
    artifact_manifest: Array.isArray(input.artifact_manifest)
      ? input.artifact_manifest.filter((value): value is string => typeof value === 'string')
      : [],
    allow_empty: input.allow_empty === true,
  });
  const valuesFor = (input: AdapterCaptureInput): Record<string, string> => {
    const values: Record<string, string> = {
      body: config.body_mode === 'composed' ? '' : input.body.trim(),
    };
    for (const field of declaredFields) values[field.id] = text(input.fields, field.id);
    return values;
  };
  return {
    ...config,
    parseInput,
    validateInput(input) {
      const hasInput =
        (config.body_mode === 'freeform' && Boolean(input.body.trim())) ||
        declaredFields.some((field) => text(input.fields, field.id).length > 0);
      if (!hasInput && !input.allow_empty) {
        throw new Error(`${config.pad_id} capture input is required`);
      }
    },
    renderPreview(input) {
      return interpolate(config.preview_template, valuesFor(input));
    },
    composeCapture(input) {
      const parsed = parseInput(input);
      const fields = parsed.fields;
      if (config.body_mode === 'freeform') parsed.body = parsed.body.trim();
      (this as PadAdapter).validateInput(parsed);
      const values = valuesFor(parsed);
      const artifacts: AdapterArtifact[] = [];
      for (const field of declaredFields) {
        values[field.id] = text(fields, field.id);
        Object.entries(fields)
          .filter(
            ([key, value]) =>
              (key === `${field.id}_data` || key.startsWith(`${field.id}_data_`)) &&
              typeof value === 'string' &&
              value.length <= 200_000
          )
          .forEach(([key, value]) => {
            values[key] = String(value);
          });
        Object.entries(fields)
          .filter(
            ([key, value]) =>
              key.startsWith(`${field.id}_name_`) &&
              typeof value === 'string' &&
              value.length <= 500
          )
          .forEach(([key, value]) => {
            values[key] = String(value);
          });
        const artifactValues =
          field.kind === 'drawing'
            ? [values[field.id]]
            : Object.entries(fields)
                .filter(
                  ([key, value]) =>
                    (key === `${field.id}_data` || key.startsWith(`${field.id}_data_`)) &&
                    typeof value === 'string'
                )
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([, value]) => String(value));
        artifactValues.forEach((rawArtifact, artifactIndex) => {
          const decoded = dataUrl(rawArtifact);
          if (!decoded) return;
          const nameValue =
            values[`${field.id}_name_${artifactIndex}`] ||
            (artifactIndex === 0 ? values[field.id] : '');
          artifacts.push({
            field_id: field.id,
            name:
              nameValue && !dataUrl(nameValue)
                ? nameValue
                : `${field.id}-${artifactIndex + 1}.${decoded.mime === 'image/png' ? 'png' : 'bin'}`,
            ...decoded,
          });
        });
      }
      // Keep binary data in the managed artifact/payload channels.  Preview
      // text is durable record content, so never duplicate a drawing's data
      // URL into the searchable body.
      const previewValues = { ...values };
      for (const field of declaredFields) {
        if (field.kind === 'drawing' && dataUrl(previewValues[field.id])) {
          previewValues[field.id] = drawingMarker;
        }
      }
      const body = (this as PadAdapter).renderPreview({ ...parsed, fields: previewValues });
      if (!body) throw new Error(`${config.pad_id} capture body is required`);
      return {
        body,
        artifact_manifest: manifest(parsed, fields),
        artifacts,
        payload: values,
      };
    },
  };
}

const TARGET_OPTIONS = {
  choose: { value: '', label: 'personal_pads:option_choose' },
  note: { value: 'note', label: 'personal_pads:option_note' },
  now: { value: 'now', label: 'personal_pads:option_now' },
  todo: { value: 'todo', label: 'personal_pads:option_todo' },
  ingest: { value: 'ingest', label: 'personal_pads:option_ingest' },
} as const;

const VOICE_INPUT = { label: 'personal_pads:voice_input' } as const;

export const PAD_ADAPTER_DEFINITIONS: readonly PadAdapterDefinition[] = [
  {
    id: 'memory-capture.v1',
    pad_id: 'memory-capture',
    input_kind: 'text',
    body_mode: 'freeform',
    fields: [
      {
        id: 'tags',
        label: 'personal_pads:field_tags',
        kind: 'text',
        placeholder: 'personal_pads:field_tags_placeholder',
      },
      {
        id: 'next_action',
        label: 'personal_pads:field_next_action',
        kind: 'text',
        placeholder: 'personal_pads:field_next_action_placeholder',
      },
      {
        id: 'instruction',
        label: 'personal_pads:field_capture_note',
        kind: 'text',
        placeholder: 'personal_pads:field_capture_note_placeholder',
        voice_input: VOICE_INPUT,
      },
      {
        id: 'target',
        label: 'personal_pads:field_target',
        kind: 'select',
        options: [
          TARGET_OPTIONS.choose,
          TARGET_OPTIONS.note,
          TARGET_OPTIONS.now,
          TARGET_OPTIONS.todo,
          TARGET_OPTIONS.ingest,
        ],
      },
    ],
    actions: [],
    preview_template: 'personal_pads:preview_memory_capture',
  },
  {
    id: 'meeting-notepad.v1',
    pad_id: 'meeting-notepad',
    input_kind: 'mixed',
    body_mode: 'composed',
    fields: [
      {
        id: 'attendees',
        label: 'personal_pads:field_attendees',
        kind: 'text',
        placeholder: 'personal_pads:field_attendees_placeholder',
      },
      {
        id: 'instruction',
        label: 'personal_pads:field_minutes_instruction',
        kind: 'textarea',
        placeholder: 'personal_pads:field_minutes_instruction_placeholder',
        voice_input: VOICE_INPUT,
      },
      {
        id: 'decisions',
        label: 'personal_pads:field_decisions',
        kind: 'textarea',
        placeholder: 'personal_pads:field_decisions_placeholder',
      },
      {
        id: 'handoff',
        label: 'personal_pads:field_handoff',
        kind: 'textarea',
        placeholder: 'personal_pads:field_handoff_placeholder',
      },
      {
        id: 'action_items',
        label: 'personal_pads:field_action_items',
        kind: 'textarea',
        placeholder: 'personal_pads:field_action_items_placeholder',
      },
      {
        id: 'summary',
        label: 'personal_pads:field_summary',
        kind: 'textarea',
        placeholder: 'personal_pads:field_summary_placeholder',
      },
      {
        id: 'open_questions',
        label: 'personal_pads:field_open_questions',
        kind: 'textarea',
        placeholder: 'personal_pads:field_open_questions_placeholder',
      },
      {
        id: 'notes',
        label: 'personal_pads:field_raw_notes',
        kind: 'textarea',
        placeholder: 'personal_pads:field_raw_notes_placeholder',
      },
      {
        id: 'transcript',
        label: 'personal_pads:field_transcript',
        kind: 'textarea',
        placeholder: 'personal_pads:field_transcript_placeholder',
      },
      {
        id: 'language',
        label: 'personal_pads:field_language',
        kind: 'select',
        options: [
          TARGET_OPTIONS.choose,
          { value: 'ja', label: 'personal_pads:option_language_ja' },
          { value: 'en', label: 'personal_pads:option_language_en' },
        ],
      },
      {
        id: 'audio_name',
        label: 'personal_pads:field_recording',
        kind: 'recording',
        accept: 'audio/*',
        help: 'personal_pads:field_recording_help',
      },
      {
        id: 'attachment_name',
        label: 'personal_pads:field_meeting_attachments',
        kind: 'file',
        multiple: true,
        accept: '.txt,.md,.json,.csv,image/*,application/pdf',
        help: 'personal_pads:field_meeting_attachments_help',
      },
    ],
    actions: [
      {
        id: 'meeting.transcribe',
        label: 'personal_pads:action_meeting_transcribe',
        description: 'personal_pads:action_meeting_transcribe_description',
        effect: 'derive',
        capability: 'speech-to-text',
        max_concurrent: 2,
      },
      {
        id: 'meeting.minutes',
        label: 'personal_pads:action_meeting_minutes',
        description: 'personal_pads:action_meeting_minutes_description',
        effect: 'derive',
        capability: 'reasoning',
        max_concurrent: 2,
      },
    ],
    preview_template: 'personal_pads:preview_meeting_notepad',
  },
  {
    id: 'sketch-input.v1',
    pad_id: 'sketch-input',
    input_kind: 'drawing',
    body_mode: 'composed',
    fields: [
      {
        id: 'instruction',
        label: 'personal_pads:field_drawing_note',
        kind: 'textarea',
        placeholder: 'personal_pads:field_drawing_note_placeholder',
        voice_input: VOICE_INPUT,
      },
      {
        id: 'drawing_data',
        label: 'personal_pads:field_canvas',
        kind: 'drawing',
        drawing_tools: [
          { id: 'pen' },
          { id: 'rect' },
          { id: 'ellipse' },
          { id: 'line' },
          { id: 'arrow' },
          { id: 'text' },
          { id: 'eraser' },
        ],
        download: { filename: 'sketch-input.png' },
        help: 'personal_pads:field_canvas_help',
      },
    ],
    actions: [],
    preview_template: 'personal_pads:preview_sketch_input',
  },
  {
    id: 'clipboard-inbox.v1',
    pad_id: 'clipboard-inbox',
    input_kind: 'text',
    body_mode: 'freeform',
    fields: [
      {
        id: 'source',
        label: 'personal_pads:field_source',
        kind: 'text',
        placeholder: 'personal_pads:field_source_placeholder',
      },
      {
        id: 'url',
        label: 'personal_pads:field_link',
        kind: 'text',
        placeholder: 'personal_pads:field_link_placeholder',
      },
      {
        id: 'items',
        label: 'personal_pads:field_clip_items',
        kind: 'textarea',
        placeholder: 'personal_pads:field_clip_items_placeholder',
      },
      {
        id: 'instruction',
        label: 'personal_pads:field_capture_note',
        kind: 'text',
        placeholder: 'personal_pads:field_capture_note_placeholder',
      },
      {
        id: 'target',
        label: 'personal_pads:field_target',
        kind: 'select',
        options: [
          TARGET_OPTIONS.choose,
          TARGET_OPTIONS.note,
          TARGET_OPTIONS.todo,
          TARGET_OPTIONS.ingest,
        ],
      },
    ],
    actions: [
      {
        id: 'clipboard.read',
        label: 'personal_pads:action_clipboard_read',
        description: 'personal_pads:action_clipboard_read_description',
        effect: 'read',
        capability: 'os-clipboard',
        max_concurrent: 2,
      },
    ],
    preview_template: 'personal_pads:preview_clipboard_inbox',
  },
  {
    id: 'daily-desk.v1',
    pad_id: 'daily-desk',
    input_kind: 'mixed',
    body_mode: 'composed',
    fields: [
      {
        id: 'journal',
        label: 'personal_pads:field_journal',
        kind: 'textarea',
        placeholder: 'personal_pads:field_journal_placeholder',
      },
      {
        id: 'todo',
        label: 'personal_pads:field_todo',
        kind: 'textarea',
        placeholder: 'personal_pads:field_todo_placeholder',
      },
      {
        id: 'now',
        label: 'personal_pads:field_now',
        kind: 'textarea',
        placeholder: 'personal_pads:field_now_placeholder',
      },
      {
        id: 'period_key',
        label: 'personal_pads:field_period_key',
        kind: 'text',
        placeholder: 'personal_pads:field_period_key_placeholder',
      },
      {
        id: 'instruction',
        label: 'personal_pads:field_daily_note',
        kind: 'textarea',
        placeholder: 'personal_pads:field_daily_note_placeholder',
      },
    ],
    actions: [
      {
        id: 'daily.load-working-memory',
        label: 'personal_pads:action_daily_load',
        description: 'personal_pads:action_daily_load_description',
        effect: 'read',
        max_concurrent: 2,
      },
    ],
    preview_template: 'personal_pads:preview_daily_desk',
  },
  {
    id: 'doc-drop.v1',
    pad_id: 'doc-drop',
    input_kind: 'document',
    body_mode: 'composed',
    fields: [
      {
        id: 'file_name',
        label: 'personal_pads:field_documents',
        kind: 'file',
        multiple: true,
        accept:
          '.txt,.md,.json,.csv,.doc,.docx,text/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        help: 'personal_pads:field_documents_help',
      },
      {
        id: 'review_note',
        label: 'personal_pads:field_review_note',
        kind: 'textarea',
        placeholder: 'personal_pads:field_review_note_placeholder',
      },
    ],
    actions: [],
    preview_template: 'personal_pads:preview_doc_drop',
  },
  {
    id: 'screenshot-annotate.v1',
    pad_id: 'screenshot-annotate',
    input_kind: 'image',
    body_mode: 'composed',
    fields: [
      {
        id: 'image_name',
        label: 'personal_pads:field_screenshot',
        kind: 'image',
        accept: 'image/*',
        paste_drop: true,
        help: 'personal_pads:field_screenshot_help',
      },
      {
        id: 'annotation',
        label: 'personal_pads:field_annotation',
        kind: 'textarea',
        placeholder: 'personal_pads:field_annotation_placeholder',
        voice_input: VOICE_INPUT,
      },
      {
        id: 'annotation_data',
        label: 'personal_pads:field_drawn_annotation',
        kind: 'drawing',
        overlay_field: 'image_name',
        drawing_tools: [
          { id: 'pen' },
          { id: 'rect' },
          { id: 'arrow' },
          { id: 'text' },
          { id: 'eraser' },
        ],
        download: { filename: 'screenshot-annotate.png' },
        help: 'personal_pads:field_drawn_annotation_help',
      },
    ],
    actions: [
      {
        id: 'screenshot.capture-screen',
        label: 'personal_pads:action_screenshot_capture',
        description: 'personal_pads:action_screenshot_capture_description',
        effect: 'read',
        capability: 'os-screenshot',
        max_concurrent: 1,
      },
    ],
    preview_template: 'personal_pads:preview_screenshot_annotate',
  },
  {
    id: 'personal-workbench.v1',
    pad_id: 'personal-workbench',
    input_kind: 'mixed',
    body_mode: 'composed',
    fields: [
      {
        id: 'entry_type',
        label: 'personal_pads:field_entry_type',
        kind: 'select',
        options: [
          TARGET_OPTIONS.choose,
          { value: 'link', label: 'personal_pads:option_entry_link' },
          { value: 'task', label: 'personal_pads:option_entry_task' },
          { value: 'follow-up', label: 'personal_pads:option_entry_follow_up' },
          { value: 'decision', label: 'personal_pads:option_entry_decision' },
          { value: 'expense', label: 'personal_pads:option_entry_expense' },
          { value: 'daily-review', label: 'personal_pads:option_entry_daily_review' },
        ],
      },
      {
        id: 'due',
        label: 'personal_pads:field_due',
        kind: 'text',
        placeholder: 'personal_pads:field_date_placeholder',
      },
    ],
    actions: [
      {
        id: 'workbench.email-draft',
        label: 'personal_pads:action_email_draft',
        description: 'personal_pads:action_email_draft_description',
        effect: 'propose',
        capability: 'governed',
        max_concurrent: 2,
        input_fields: [
          {
            id: 'email_to',
            label: 'personal_pads:field_email_to',
            kind: 'text',
            placeholder: 'personal_pads:field_email_to_placeholder',
          },
          { id: 'email_subject', label: 'personal_pads:field_email_subject', kind: 'text' },
          { id: 'email_body', label: 'personal_pads:field_email_body', kind: 'textarea' },
          { id: 'email_account', label: 'personal_pads:field_email_account', kind: 'text' },
        ],
      },
      {
        id: 'workbench.calendar-propose',
        label: 'personal_pads:action_calendar_propose',
        description: 'personal_pads:action_calendar_propose_description',
        effect: 'propose',
        capability: 'governed',
        max_concurrent: 2,
        input_fields: [
          { id: 'calendar_summary', label: 'personal_pads:field_calendar_summary', kind: 'text' },
          {
            id: 'calendar_start',
            label: 'personal_pads:field_calendar_start',
            kind: 'text',
            placeholder: 'personal_pads:field_calendar_start_placeholder',
          },
          {
            id: 'calendar_end',
            label: 'personal_pads:field_calendar_end',
            kind: 'text',
            placeholder: 'personal_pads:field_calendar_end_placeholder',
          },
          {
            id: 'calendar_description',
            label: 'personal_pads:field_calendar_description',
            kind: 'textarea',
          },
          { id: 'calendar_location', label: 'personal_pads:field_calendar_location', kind: 'text' },
          {
            id: 'calendar_attendees',
            label: 'personal_pads:field_attendees',
            kind: 'text',
            placeholder: 'personal_pads:field_calendar_attendees_placeholder',
          },
          {
            id: 'calendar_provider',
            label: 'personal_pads:field_calendar_provider',
            kind: 'select',
            options: [
              { value: 'google-workspace', label: 'personal_pads:option_provider_google' },
              { value: 'm365', label: 'personal_pads:option_provider_m365' },
            ],
          },
          { id: 'calendar_id', label: 'personal_pads:field_calendar_id', kind: 'text' },
          {
            id: 'calendar_time_zone',
            label: 'personal_pads:field_calendar_time_zone',
            kind: 'text',
            placeholder: 'personal_pads:field_calendar_time_zone_placeholder',
          },
        ],
      },
      {
        id: 'workbench.calendar-apply',
        label: 'personal_pads:action_calendar_apply',
        description: 'personal_pads:action_calendar_apply_description',
        effect: 'apply',
        capability: 'governed',
        max_concurrent: 1,
        input_fields: [
          {
            id: 'calendar_approval_request_id',
            label: 'personal_pads:field_approval_request_id',
            kind: 'text',
          },
          {
            id: 'calendar_confirm',
            label: 'personal_pads:field_calendar_confirm',
            kind: 'select',
            options: [
              { value: '', label: 'personal_pads:option_confirm_required' },
              { value: 'yes', label: 'personal_pads:option_confirm_create' },
            ],
          },
        ],
      },
      {
        id: 'workbench.calendar-reconcile',
        label: 'personal_pads:action_calendar_reconcile',
        description: 'personal_pads:action_calendar_reconcile_description',
        effect: 'derive',
        capability: 'governed',
        max_concurrent: 1,
        input_fields: [
          {
            id: 'calendar_reconcile_approval_request_id',
            label: 'personal_pads:field_approval_request_id',
            kind: 'text',
          },
        ],
      },
      {
        id: 'workbench.ocr-extract',
        label: 'personal_pads:action_ocr_extract',
        description: 'personal_pads:action_ocr_extract_description',
        effect: 'derive',
        capability: 'governed',
        max_concurrent: 2,
        input_fields: [
          {
            id: 'ocr_artifact_id',
            label: 'personal_pads:field_ocr_artifact_id',
            kind: 'text',
            placeholder: 'personal_pads:field_ocr_artifact_id_placeholder',
          },
          {
            id: 'ocr_language',
            label: 'personal_pads:field_ocr_language',
            kind: 'text',
            placeholder: 'personal_pads:field_ocr_language_placeholder',
          },
          {
            id: 'ocr_mode',
            label: 'personal_pads:field_ocr_mode',
            kind: 'select',
            options: [
              { value: 'privacy_first', label: 'personal_pads:option_ocr_privacy_first' },
              { value: 'balanced', label: 'personal_pads:option_ocr_balanced' },
            ],
          },
          {
            id: 'ocr_extract_structure',
            label: 'personal_pads:field_ocr_structure',
            kind: 'select',
            options: [
              { value: '', label: 'personal_pads:option_no' },
              { value: 'yes', label: 'personal_pads:option_yes' },
            ],
          },
        ],
      },
      {
        id: 'workbench.knowledge-propose',
        label: 'personal_pads:action_knowledge_propose',
        description: 'personal_pads:action_knowledge_propose_description',
        effect: 'propose',
        capability: 'governed',
        max_concurrent: 2,
        input_fields: [
          {
            id: 'knowledge_summary',
            label: 'personal_pads:field_knowledge_summary',
            kind: 'textarea',
          },
        ],
      },
    ],
    preview_template: 'personal_pads:preview_personal_workbench',
  },
];

function localizeField(field: AdapterFieldDefinition, locale: SupportedLocale): AdapterField {
  const { label, placeholder, help, options, voice_input, ...rest } = field;
  return {
    ...rest,
    label: padsText(label, locale),
    ...(placeholder ? { placeholder: padsText(placeholder, locale) } : {}),
    ...(help ? { help: padsText(help, locale) } : {}),
    ...(options
      ? {
          options: options.map((option) => ({
            value: option.value,
            label: padsText(option.label, locale),
          })),
        }
      : {}),
    ...(voice_input ? { voice_input: { label: padsText(voice_input.label, locale) } } : {}),
  };
}

function localizeAction(action: PadActionDefinition, locale: SupportedLocale): PadActionDescriptor {
  const { label, description, input_fields, ...rest } = action;
  return {
    ...rest,
    label: padsText(label, locale),
    description: padsText(description, locale),
    ...(input_fields
      ? { input_fields: input_fields.map((field) => localizeField(field, locale)) }
      : {}),
  };
}

/** Resolve one adapter definition's vocabulary for `locale`. */
export function localizePadAdapter(
  definition: PadAdapterDefinition,
  locale?: SupportedLocale
): PadAdapter {
  const resolved = defaultPadLocale(locale);
  return makeAdapter(
    {
      ...definition,
      fields: definition.fields.map((field) => localizeField(field, resolved)),
      actions: definition.actions.map((action) => localizeAction(action, resolved)),
      preview_template: padsText(definition.preview_template, resolved),
    },
    padsText('personal_pads:drawing_attached_marker', resolved)
  );
}

const LOCALIZED_ADAPTERS = new Map<SupportedLocale, readonly PadAdapter[]>();

/** Every adapter, localized for `locale` (cached per locale). */
export function padAdaptersFor(locale?: SupportedLocale): readonly PadAdapter[] {
  const resolved = defaultPadLocale(locale);
  let adapters = LOCALIZED_ADAPTERS.get(resolved);
  if (!adapters) {
    adapters = PAD_ADAPTER_DEFINITIONS.map((definition) =>
      localizePadAdapter(definition, resolved)
    );
    LOCALIZED_ADAPTERS.set(resolved, adapters);
  }
  return adapters;
}

export function getPadAdapter(padId: PadId, locale?: SupportedLocale): PadAdapter {
  const adapter = padAdaptersFor(locale).find((candidate) => candidate.pad_id === padId);
  if (!adapter || !getPadRegistryEntry(padId))
    throw new Error(`adapter is not registered: ${padId}`);
  return adapter;
}

export function assertPadAdaptersComplete(): void {
  for (const entry of PAD_REGISTRY) {
    const definition = PAD_ADAPTER_DEFINITIONS.find((candidate) => candidate.pad_id === entry.id);
    if (!definition) throw new Error(`adapter is not registered: ${entry.id}`);
    if (definition.id !== entry.adapter_id || definition.input_kind !== entry.input_kind) {
      throw new Error(`adapter contract mismatch: ${entry.id}`);
    }
  }
}

export interface PublicPadAdapterConfig {
  pad_id: PadId;
  input_kind: PadInputKind;
  body_mode: PadAdapter['body_mode'];
  fields: readonly AdapterField[];
  actions: readonly PadActionDescriptor[];
  preview_template: string;
  /** Localized marker the browser preview shows instead of a drawing's data URL. */
  drawing_marker: string;
}

export function publicPadAdapterConfigs(
  locale?: SupportedLocale
): readonly PublicPadAdapterConfig[] {
  const marker = padsText('personal_pads:drawing_attached_marker', defaultPadLocale(locale));
  return padAdaptersFor(locale).map(
    ({ pad_id, input_kind, body_mode, fields, actions, preview_template }) => ({
      pad_id,
      input_kind,
      body_mode,
      fields,
      actions,
      preview_template,
      drawing_marker: marker,
    })
  );
}
