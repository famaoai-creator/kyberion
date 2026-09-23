/**
 * Compatibility contract for the eight legacy pad servers.
 *
 * Legacy transports keep their historical routes and output layout during the
 * migration window, but payload normalization and the handoff shape are owned
 * here so a new unified adapter cannot silently diverge from an old CLI.
 */
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { PadRecord } from './storage.js';
import { getPadAdapter, type AdapterCaptureInput, type AdapterCaptureResult } from './adapters.js';
import type { PadId } from './registry.js';

export type LegacyPayload = Readonly<Record<string, unknown>>;

function text(payload: LegacyPayload, key: string): string {
  return typeof payload[key] === 'string' ? String(payload[key]) : '';
}

function list(payload: LegacyPayload, key: string): string {
  const value = payload[key];
  if (Array.isArray(value)) return value.map(String).join(', ');
  return text(payload, key);
}

function dataUrl(mime: string, value: string): string {
  return value.startsWith('data:') ? value : `data:${mime};base64,${value}`;
}

function attachments(value: unknown): Array<{ name: string; mime: string; data_base64: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Record<string, unknown>;
    const encoded = typeof row.data_base64 === 'string' ? row.data_base64.trim() : '';
    if (!encoded) return [];
    return [
      {
        name: typeof row.name === 'string' ? row.name : 'attachment',
        mime: typeof row.mime === 'string' ? row.mime : 'application/octet-stream',
        data_base64: encoded,
      },
    ];
  });
}

/** Convert one historical route body into the adapter's canonical fields. */
export function legacyPayloadToAdapterInput(
  padId: PadId,
  payload: LegacyPayload
): AdapterCaptureInput {
  switch (padId) {
    case 'memory-capture': {
      const target = text(payload, 'target').toLowerCase();
      return {
        body: text(payload, 'notes'),
        fields: {
          tags: list(payload, 'tags'),
          instruction: text(payload, 'instruction'),
          target: target === 'now' ? 'now' : target === 'todo' ? 'todo' : 'note',
        },
      };
    }
    case 'meeting-notepad': {
      const files = attachments(payload.attachments);
      const fields: Record<string, unknown> = {
        notes: text(payload, 'notes'),
        transcript: text(payload, 'transcript'),
        instruction: text(payload, 'instruction'),
        action_items: list(payload, 'action_items'),
        language: text(payload, 'language'),
        attendees: list(payload, 'attendees'),
        audio_name: text(payload, 'audio_name'),
      };
      files.forEach((file, index) => {
        fields.attachment_name = files.map((item) => item.name).join('\n');
        fields[index === 0 ? 'attachment_name_data' : `attachment_name_data_${index}`] = dataUrl(
          file.mime,
          file.data_base64
        );
      });
      if (typeof payload.audio_base64 === 'string' && payload.audio_base64.trim()) {
        fields.audio_name = text(payload, 'audio_name') || 'recording.webm';
        fields.audio_name_data = dataUrl(
          text(payload, 'mime') || 'audio/webm',
          payload.audio_base64
        );
      }
      return { body: '', title: text(payload, 'title'), fields };
    }
    case 'sketch-input':
      return {
        body: '',
        fields: {
          instruction: text(payload, 'instruction'),
          drawing_data:
            typeof payload.png_base64 === 'string' ? dataUrl('image/png', payload.png_base64) : '',
        },
      };
    case 'clipboard-inbox': {
      const items = Array.isArray(payload.items)
        ? payload.items
            .map((item) => {
              if (!item || typeof item !== 'object') return '';
              const row = item as Record<string, unknown>;
              const label = text(row, 'label');
              const itemText = text(row, 'text');
              return label ? `${label}: ${itemText}` : itemText;
            })
            .filter(Boolean)
            .join('\n')
        : text(payload, 'items');
      return {
        body: items,
        fields: {
          items,
          instruction: text(payload, 'instruction'),
          source: text(payload, 'source'),
          url: text(payload, 'url'),
        },
      };
    }
    case 'daily-desk':
      return {
        body: '',
        fields: {
          journal: text(payload, 'journal'),
          todo: text(payload, 'todo'),
          now: text(payload, 'now'),
          period_key: text(payload, 'period_key'),
          instruction: text(payload, 'instruction'),
        },
      };
    case 'doc-drop': {
      const files = attachments(payload.attachments);
      const fields: Record<string, unknown> = { review_note: text(payload, 'instruction') };
      files.forEach((file, index) => {
        fields.file_name = files.map((item) => item.name).join('\n');
        fields[index === 0 ? 'file_name_data' : `file_name_data_${index}`] = dataUrl(
          file.mime,
          file.data_base64
        );
      });
      return { body: '', fields };
    }
    case 'screenshot-annotate':
      return {
        body: '',
        fields: {
          image_name: text(payload, 'image_name') || 'screenshot.png',
          image_name_data:
            typeof payload.png_base64 === 'string' ? dataUrl('image/png', payload.png_base64) : '',
          annotation: text(payload, 'instruction'),
        },
      };
    case 'personal-workbench':
      return { body: text(payload, 'body'), title: text(payload, 'title'), fields: payload };
  }
}

/**
 * Parse and validate a legacy body through the same adapter as the unified UI.
 * `locale` selects the composed body's wording (defaults to the process locale).
 */
export function composeLegacyCapture(
  padId: PadId,
  payload: LegacyPayload,
  locale?: SupportedLocale
): AdapterCaptureResult {
  const adapter = getPadAdapter(padId, locale);
  // Preserve historical route semantics (memory/daily/meeting accepted an
  // explicit empty submit) while still forcing every payload through the
  // typed adapter. The unified shell keeps its stricter input gate.
  return adapter.composeCapture({
    ...legacyPayloadToAdapterInput(padId, payload),
    allow_empty: true,
  });
}

const LEGACY_KIND: Readonly<Record<PadId, string>> = {
  'memory-capture': 'memory-capture-handoff',
  'meeting-notepad': 'meeting-notepad-handoff',
  'sketch-input': 'sketch-input-handoff',
  'clipboard-inbox': 'clipboard-inbox-handoff',
  'daily-desk': 'daily-desk-handoff',
  'doc-drop': 'doc-drop-handoff',
  'screenshot-annotate': 'screenshot-annotate-handoff',
  'personal-workbench': 'personal-workbench-handoff',
};

/** Stable handoff projection consumed by legacy follow-up tooling. */
export function toLegacyHandoffProjection(record: PadRecord): {
  kind: string;
  version: 1;
  record_id: string;
  pad_id: PadId;
  title: string;
  body: string;
  payload: Readonly<Record<string, string>>;
  artifact_manifest: readonly string[];
  artifact_refs: PadRecord['artifact_refs'];
  scope: PadRecord['scope'];
  viewer_principal: string;
  processing: { auto_start_mission: false; auto_knowledge_commit: false };
} {
  return {
    kind: LEGACY_KIND[record.pad_id],
    version: 1,
    record_id: record.record_id,
    pad_id: record.pad_id,
    title: record.title,
    body: record.body,
    payload: record.payload,
    artifact_manifest: record.artifact_manifest,
    artifact_refs: record.artifact_refs,
    scope: record.scope,
    viewer_principal: record.viewer_principal,
    processing: { auto_start_mission: false, auto_knowledge_commit: false },
  };
}
