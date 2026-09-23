/**
 * The single menu contract for the local pads surface.
 *
 * Pad implementations may continue to keep their legacy CLI/server while they
 * are migrated. The unified surface only depends on this typed registry and
 * never starts those legacy listeners as a side effect.
 */
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { padsT } from './i18n.js';

export const PAD_IDS = [
  'memory-capture',
  'meeting-notepad',
  'sketch-input',
  'clipboard-inbox',
  'daily-desk',
  'doc-drop',
  'screenshot-annotate',
  'personal-workbench',
] as const;

export type PadId = (typeof PAD_IDS)[number];

export type PadInputKind = 'text' | 'document' | 'image' | 'drawing' | 'mixed';
export type PadTier = 'public' | 'confidential' | 'personal';

export interface PadRegistryEntry {
  id: PadId;
  /** Vocabulary key of the menu label (resolved per request locale). */
  label_key: VocabularyKey;
  /** Vocabulary key of the one-line menu description. */
  description_key: VocabularyKey;
  input_kind: PadInputKind;
  adapter_id: string;
  /** Storage policy is explicit for every selectable tier. */
  storage_policy_ids: Readonly<Record<PadTier, string>>;
  /** Default policy used by the legacy CLI during migration. */
  storage_policy_id: string;
  /** Vocabulary key of the human-facing storage label. No physical path is exposed. */
  storage_label_key: VocabularyKey;
  max_body_bytes: number;
  /** Maximum concurrent capture requests for this adapter. */
  max_concurrent: number;
}

export const PAD_REGISTRY: readonly PadRegistryEntry[] = [
  {
    id: 'memory-capture',
    label_key: 'personal_pads:pad_memory_capture',
    description_key: 'personal_pads:pad_memory_capture_description',
    input_kind: 'text',
    adapter_id: 'memory-capture.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label_key: 'personal_pads:storage_scope_managed',
    max_body_bytes: 12 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'meeting-notepad',
    label_key: 'personal_pads:pad_meeting_notepad',
    description_key: 'personal_pads:pad_meeting_notepad_description',
    input_kind: 'mixed',
    adapter_id: 'meeting-notepad.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.confidential.v1',
    storage_label_key: 'personal_pads:storage_scope_managed',
    max_body_bytes: 24 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'sketch-input',
    label_key: 'personal_pads:pad_sketch_input',
    description_key: 'personal_pads:pad_sketch_input_description',
    input_kind: 'drawing',
    adapter_id: 'sketch-input.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label_key: 'personal_pads:storage_scope_managed',
    max_body_bytes: 12 * 1024 * 1024,
    max_concurrent: 1,
  },
  {
    id: 'clipboard-inbox',
    label_key: 'personal_pads:pad_clipboard_inbox',
    description_key: 'personal_pads:pad_clipboard_inbox_description',
    input_kind: 'text',
    adapter_id: 'clipboard-inbox.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label_key: 'personal_pads:storage_scope_managed',
    max_body_bytes: 12 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'daily-desk',
    label_key: 'personal_pads:pad_daily_desk',
    description_key: 'personal_pads:pad_daily_desk_description',
    input_kind: 'mixed',
    adapter_id: 'daily-desk.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label_key: 'personal_pads:storage_scope_managed',
    max_body_bytes: 4 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'doc-drop',
    label_key: 'personal_pads:pad_doc_drop',
    description_key: 'personal_pads:pad_doc_drop_description',
    input_kind: 'document',
    adapter_id: 'doc-drop.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.confidential.v1',
    storage_label_key: 'personal_pads:storage_scope_managed',
    max_body_bytes: 24 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'screenshot-annotate',
    label_key: 'personal_pads:pad_screenshot_annotate',
    description_key: 'personal_pads:pad_screenshot_annotate_description',
    input_kind: 'image',
    adapter_id: 'screenshot-annotate.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.confidential.v1',
    storage_label_key: 'personal_pads:storage_scope_managed',
    max_body_bytes: 24 * 1024 * 1024,
    max_concurrent: 1,
  },
  {
    id: 'personal-workbench',
    label_key: 'personal_pads:pad_personal_workbench',
    description_key: 'personal_pads:pad_personal_workbench_description',
    input_kind: 'mixed',
    adapter_id: 'personal-workbench.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label_key: 'personal_pads:storage_scope_managed',
    max_body_bytes: 4 * 1024 * 1024,
    max_concurrent: 2,
  },
] as const;

export function getPadRegistryEntry(id: string): PadRegistryEntry | undefined {
  return PAD_REGISTRY.find((entry) => entry.id === id);
}

export function isPadId(value: unknown): value is PadId {
  return typeof value === 'string' && (PAD_IDS as readonly string[]).includes(value);
}

export interface PublicPadRegistryEntry {
  id: PadId;
  label: string;
  description: string;
  input_kind: PadInputKind;
  storage_label: string;
}

/** Return only metadata safe for the browser menu, localized for `locale`. */
export function publicPadRegistry(locale?: SupportedLocale): readonly PublicPadRegistryEntry[] {
  const t = padsT(locale);
  return PAD_REGISTRY.map(({ id, label_key, description_key, input_kind, storage_label_key }) => ({
    id,
    label: t(label_key),
    description: t(description_key),
    input_kind,
    storage_label: t(storage_label_key),
  }));
}
