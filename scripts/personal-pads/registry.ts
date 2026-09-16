/**
 * The single menu contract for the local pads surface.
 *
 * Pad implementations may continue to keep their legacy CLI/server while they
 * are migrated. The unified surface only depends on this typed registry and
 * never starts those legacy listeners as a side effect.
 */

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
  label: string;
  description: string;
  input_kind: PadInputKind;
  adapter_id: string;
  /** Storage policy is explicit for every selectable tier. */
  storage_policy_ids: Readonly<Record<PadTier, string>>;
  /** Default policy used by the legacy CLI during migration. */
  storage_policy_id: string;
  /** Human-facing label used by the shell. No physical path is exposed. */
  storage_label: string;
  max_body_bytes: number;
  /** Maximum concurrent capture requests for this adapter. */
  max_concurrent: number;
}

export const PAD_REGISTRY: readonly PadRegistryEntry[] = [
  {
    id: 'memory-capture',
    label: 'Memory capture',
    description: '思いつき、タグ、次の行動をすばやく記録',
    input_kind: 'text',
    adapter_id: 'memory-capture.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label: 'scope に応じた管理領域',
    max_body_bytes: 12 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'meeting-notepad',
    label: 'Meeting notepad',
    description: '会議のメモ、決定事項、受け渡しを整理',
    input_kind: 'mixed',
    adapter_id: 'meeting-notepad.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.confidential.v1',
    storage_label: 'scope に応じた管理領域',
    max_body_bytes: 24 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'sketch-input',
    label: 'Sketch input',
    description: '画面やアイデアを手描きで残す',
    input_kind: 'drawing',
    adapter_id: 'sketch-input.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label: 'scope に応じた管理領域',
    max_body_bytes: 12 * 1024 * 1024,
    max_concurrent: 1,
  },
  {
    id: 'clipboard-inbox',
    label: 'Clipboard inbox',
    description: 'コピーした文章やリンクを一時受信箱へ',
    input_kind: 'text',
    adapter_id: 'clipboard-inbox.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label: 'scope に応じた管理領域',
    max_body_bytes: 12 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'daily-desk',
    label: 'Daily desk',
    description: 'Journal、TODO、NOW を一つの机で見渡す',
    input_kind: 'mixed',
    adapter_id: 'daily-desk.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label: 'scope に応じた管理領域',
    max_body_bytes: 4 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'doc-drop',
    label: 'Doc drop',
    description: '文書を受け取り、確認待ちの記録にする',
    input_kind: 'document',
    adapter_id: 'doc-drop.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.confidential.v1',
    storage_label: 'scope に応じた管理領域',
    max_body_bytes: 24 * 1024 * 1024,
    max_concurrent: 2,
  },
  {
    id: 'screenshot-annotate',
    label: 'Screenshot annotate',
    description: 'スクリーンショットに気づきを重ねる',
    input_kind: 'image',
    adapter_id: 'screenshot-annotate.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.confidential.v1',
    storage_label: 'scope に応じた管理領域',
    max_body_bytes: 24 * 1024 * 1024,
    max_concurrent: 1,
  },
  {
    id: 'personal-workbench',
    label: 'Personal workbench',
    description: 'リンク、タスク、フォローアップを秘書 inbox へ',
    input_kind: 'mixed',
    adapter_id: 'personal-workbench.v1',
    storage_policy_ids: {
      personal: 'pad.personal.v1',
      confidential: 'pad.confidential.v1',
      public: 'pad.public.v1',
    },
    storage_policy_id: 'pad.personal.v1',
    storage_label: 'scope に応じた管理領域',
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

/** Return only metadata safe for the browser menu. */
export function publicPadRegistry(): readonly Pick<
  PadRegistryEntry,
  'id' | 'label' | 'description' | 'input_kind' | 'storage_label'
>[] {
  return PAD_REGISTRY.map(({ id, label, description, input_kind, storage_label }) => ({
    id,
    label,
    description,
    input_kind,
    storage_label,
  }));
}
