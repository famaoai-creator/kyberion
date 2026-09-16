/** Typed adapter seams for the unified local-pads desk.
 *
 * The server owns transport and authorization. Adapters own the input shape
 * and canonical capture representation, so adding a pad does not require a
 * new route or a branch in the server.
 */
import { getPadRegistryEntry, PAD_REGISTRY, type PadId, type PadInputKind } from './registry.js';

export type AdapterFieldKind =
  'text' | 'textarea' | 'select' | 'file' | 'image' | 'drawing' | 'recording';

export type DrawingToolId = 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'eraser';

export interface DrawingToolDescriptor {
  id: DrawingToolId;
  label: string;
}

export interface VoiceInputDescriptor {
  label: string;
  stop_label: string;
}

export interface DrawingDownloadDescriptor {
  label: string;
  filename: string;
}

/**
 * Actions are deliberately declarative at the adapter boundary.  The
 * browser only receives this safe descriptor; the server resolves the
 * executor from the typed action registry after scope authorization.
 */
export type PadActionEffect = 'read' | 'derive' | 'propose' | 'apply';

export interface PadActionDescriptor {
  id: string;
  label: string;
  description: string;
  effect: PadActionEffect;
  /** Capability hint for the host. It never grants permission by itself. */
  capability?: 'os-clipboard' | 'os-screenshot' | 'speech-to-text' | 'reasoning' | 'governed';
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

function makeAdapter(
  config: Omit<PadAdapter, 'parseInput' | 'validateInput' | 'renderPreview' | 'composeCapture'>
): PadAdapter {
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
          previewValues[field.id] = '（描画 artifact を添付）';
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

const ADAPTER_CONFIGS: readonly Omit<
  PadAdapter,
  'parseInput' | 'validateInput' | 'renderPreview' | 'composeCapture'
>[] = [
  {
    id: 'memory-capture.v1',
    pad_id: 'memory-capture',
    input_kind: 'text',
    body_mode: 'freeform',
    fields: [
      { id: 'tags', label: 'タグ', kind: 'text', placeholder: 'idea, follow-up' },
      {
        id: 'next_action',
        label: '次のアクション',
        kind: 'text',
        placeholder: '誰が、いつ、何をするか',
      },
      {
        id: 'instruction',
        label: '取り込みメモ',
        kind: 'text',
        placeholder: '整理してほしいこと',
        voice_input: { label: '🎤 音声入力', stop_label: '停止' },
      },
      {
        id: 'target',
        label: '保存先の候補',
        kind: 'select',
        options: [
          { value: '', label: '選択してください' },
          { value: 'note', label: 'Note' },
          { value: 'now', label: 'NOW' },
          { value: 'todo', label: 'TODO' },
          { value: 'ingest', label: 'Ingest' },
        ],
      },
    ],
    actions: [],
    preview_template:
      '{body}\n\nタグ: {tags}\n次のアクション: {next_action}\n取り込みメモ: {instruction}\n候補: {target}',
  },
  {
    id: 'meeting-notepad.v1',
    pad_id: 'meeting-notepad',
    input_kind: 'mixed',
    body_mode: 'composed',
    fields: [
      { id: 'attendees', label: '参加者', kind: 'text', placeholder: '名前をカンマ区切り' },
      {
        id: 'instruction',
        label: '議事録の指示',
        kind: 'textarea',
        placeholder: '要約の観点や確認事項',
        voice_input: { label: '🎤 音声入力', stop_label: '停止' },
      },
      { id: 'decisions', label: '決定事項', kind: 'textarea', placeholder: '決まったこと' },
      { id: 'handoff', label: '受け渡し', kind: 'textarea', placeholder: '次の担当へ伝えること' },
      {
        id: 'action_items',
        label: 'アクション項目',
        kind: 'textarea',
        placeholder: '担当者と次の行動',
      },
      { id: 'summary', label: '要約', kind: 'textarea', placeholder: '議事録の要約' },
      {
        id: 'open_questions',
        label: '未解決事項',
        kind: 'textarea',
        placeholder: '確認が必要なこと',
      },
      { id: 'notes', label: '原メモ', kind: 'textarea', placeholder: '会議中のメモ' },
      {
        id: 'transcript',
        label: '文字起こし',
        kind: 'textarea',
        placeholder: '音声からの文字起こし',
      },
      {
        id: 'language',
        label: '言語',
        kind: 'select',
        options: [
          { value: '', label: '選択してください' },
          { value: 'ja', label: '日本語' },
          { value: 'en', label: 'English' },
        ],
      },
      {
        id: 'audio_name',
        label: '録音ファイル',
        kind: 'recording',
        accept: 'audio/*',
        help: '録音済みファイルを選ぶか、ブラウザで連続録音できます',
      },
      {
        id: 'attachment_name',
        label: '会議資料・添付',
        kind: 'file',
        multiple: true,
        accept: '.txt,.md,.json,.csv,image/*,application/pdf',
        help: '会議資料や画像を複数選択できます',
      },
    ],
    actions: [
      {
        id: 'meeting.transcribe',
        label: '文字起こし',
        description: '選択した録音を認可済みの speech-to-text bridge で文字にします',
        effect: 'derive',
        capability: 'speech-to-text',
        max_concurrent: 2,
      },
      {
        id: 'meeting.minutes',
        label: '議事録を生成',
        description: 'メモと文字起こしから議事録の下書きを作ります',
        effect: 'derive',
        capability: 'reasoning',
        max_concurrent: 2,
      },
    ],
    preview_template:
      '会議メモ\n参加者: {attendees}\n言語: {language}\n\n要約:\n{summary}\n\n決定事項:\n{decisions}\n\n受け渡し:\n{handoff}\n\nアクション項目:\n{action_items}\n\n未解決事項:\n{open_questions}\n\n原メモ:\n{notes}\n\n文字起こし:\n{transcript}\n\n録音: {audio_name}\n添付: {attachment_name}\n\nメモ:\n{body}',
  },
  {
    id: 'sketch-input.v1',
    pad_id: 'sketch-input',
    input_kind: 'drawing',
    body_mode: 'composed',
    fields: [
      {
        id: 'instruction',
        label: '描画メモ',
        kind: 'textarea',
        placeholder: 'この図で伝えたいこと',
        voice_input: { label: '🎤 音声入力', stop_label: '停止' },
      },
      {
        id: 'drawing_data',
        label: 'キャンバス',
        kind: 'drawing',
        drawing_tools: [
          { id: 'pen', label: 'ペン' },
          { id: 'rect', label: '矩形' },
          { id: 'ellipse', label: '楕円' },
          { id: 'line', label: '線' },
          { id: 'arrow', label: '矢印' },
          { id: 'text', label: 'テキスト' },
          { id: 'eraser', label: '消しゴム' },
        ],
        download: { label: 'PNGをダウンロード', filename: 'sketch-input.png' },
        help: 'ドラッグして描画できます',
      },
    ],
    actions: [],
    preview_template: 'スケッチ\n{instruction}\n\n{body}\n\n[描画データを添付]',
  },
  {
    id: 'clipboard-inbox.v1',
    pad_id: 'clipboard-inbox',
    input_kind: 'text',
    body_mode: 'freeform',
    fields: [
      { id: 'source', label: '出典', kind: 'text', placeholder: 'どこからコピーしたか' },
      { id: 'url', label: 'リンク', kind: 'text', placeholder: 'https://…' },
      {
        id: 'items',
        label: 'クリップ項目',
        kind: 'textarea',
        placeholder: 'コピーした文章（複数可）',
      },
      { id: 'instruction', label: '取り込みメモ', kind: 'text', placeholder: '整理してほしいこと' },
      {
        id: 'target',
        label: '保存先の候補',
        kind: 'select',
        options: [
          { value: '', label: '選択してください' },
          { value: 'note', label: 'Note' },
          { value: 'todo', label: 'TODO' },
          { value: 'ingest', label: 'Ingest' },
        ],
      },
    ],
    actions: [
      {
        id: 'clipboard.read',
        label: 'クリップボードを読む',
        description: 'OS のクリップボードを読み、貼り付け前の下書きへ反映します',
        effect: 'read',
        capability: 'os-clipboard',
        max_concurrent: 2,
      },
    ],
    preview_template:
      '{body}\n\nクリップ項目:\n{items}\n\n出典: {source}\nリンク: {url}\n取り込みメモ: {instruction}\n候補: {target}',
  },
  {
    id: 'daily-desk.v1',
    pad_id: 'daily-desk',
    input_kind: 'mixed',
    body_mode: 'composed',
    fields: [
      { id: 'journal', label: 'Journal', kind: 'textarea', placeholder: '今日の記録' },
      { id: 'todo', label: 'TODO', kind: 'textarea', placeholder: '今日やること' },
      { id: 'now', label: 'NOW', kind: 'textarea', placeholder: 'いま集中すること' },
      { id: 'period_key', label: '対象日', kind: 'text', placeholder: 'YYYY-MM-DD（空欄は今日）' },
      { id: 'instruction', label: '補足', kind: 'textarea', placeholder: '今日の整理メモ' },
    ],
    actions: [
      {
        id: 'daily.load-working-memory',
        label: '今日の working-memory を読む',
        description: '現在の personal scope に紐づく Journal / TODO / NOW を下書きへ読み込みます',
        effect: 'read',
        max_concurrent: 2,
      },
    ],
    preview_template:
      'Journal\n{journal}\n\nTODO\n{todo}\n\nNOW\n{now}\n\n補足\n{instruction}\n{body}',
  },
  {
    id: 'doc-drop.v1',
    pad_id: 'doc-drop',
    input_kind: 'document',
    body_mode: 'composed',
    fields: [
      {
        id: 'file_name',
        label: '文書ファイル',
        kind: 'file',
        multiple: true,
        accept:
          '.txt,.md,.json,.csv,.doc,.docx,text/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        help: '複数の原本ファイルを選択できます。実体を保存します',
      },
      { id: 'review_note', label: '確認メモ', kind: 'textarea', placeholder: '確認してほしい点' },
    ],
    actions: [],
    preview_template: '文書: {file_name}\n確認メモ:\n{review_note}\n\n補足:\n{body}',
  },
  {
    id: 'screenshot-annotate.v1',
    pad_id: 'screenshot-annotate',
    input_kind: 'image',
    body_mode: 'composed',
    fields: [
      {
        id: 'image_name',
        label: 'スクリーンショット',
        kind: 'image',
        accept: 'image/*',
        paste_drop: true,
        help: '画像を選ぶと下にプレビューが表示されます',
      },
      {
        id: 'annotation',
        label: '注釈',
        kind: 'textarea',
        placeholder: '気づきや修正点',
        voice_input: { label: '🎤 音声入力', stop_label: '停止' },
      },
      {
        id: 'annotation_data',
        label: '描画注釈',
        kind: 'drawing',
        overlay_field: 'image_name',
        drawing_tools: [
          { id: 'pen', label: 'ペン' },
          { id: 'rect', label: '矩形' },
          { id: 'arrow', label: '矢印' },
          { id: 'text', label: 'テキスト' },
          { id: 'eraser', label: '消しゴム' },
        ],
        download: { label: 'PNGをダウンロード', filename: 'screenshot-annotate.png' },
        help: '画像の上に重ねたい線や印を描けます',
      },
    ],
    actions: [
      {
        id: 'screenshot.capture-screen',
        label: '画面をキャプチャ',
        description: 'OS の画面を PNG として下書きへ取り込みます',
        effect: 'read',
        capability: 'os-screenshot',
        max_concurrent: 1,
      },
    ],
    preview_template:
      '画像: {image_name}\n注釈:\n{annotation}\n\n描画注釈: {annotation_data}\n\n補足:\n{body}',
  },
  {
    id: 'personal-workbench.v1',
    pad_id: 'personal-workbench',
    input_kind: 'mixed',
    body_mode: 'composed',
    fields: [
      {
        id: 'entry_type',
        label: '用途',
        kind: 'select',
        options: [
          { value: '', label: '選択してください' },
          { value: 'link', label: 'Link inbox' },
          { value: 'task', label: 'Task triage' },
          { value: 'follow-up', label: 'Follow-up desk' },
          { value: 'decision', label: 'Decision log' },
          { value: 'expense', label: 'Expense' },
          { value: 'daily-review', label: 'Daily review' },
        ],
      },
      { id: 'due', label: '期限', kind: 'text', placeholder: '2026-09-30' },
    ],
    actions: [
      {
        id: 'workbench.email-draft',
        label: 'メール下書き',
        description: '宛先・件名・本文から送信しないメール下書きを作ります',
        effect: 'propose',
        capability: 'governed',
        max_concurrent: 2,
        input_fields: [
          { id: 'email_to', label: '宛先', kind: 'text', placeholder: 'name@example.com' },
          { id: 'email_subject', label: '件名', kind: 'text' },
          { id: 'email_body', label: '本文', kind: 'textarea' },
          { id: 'email_account', label: 'アカウント（任意）', kind: 'text' },
        ],
      },
      {
        id: 'workbench.calendar-propose',
        label: 'カレンダー提案',
        description: '予定を承認待ちの proposal として作ります',
        effect: 'propose',
        capability: 'governed',
        max_concurrent: 2,
        input_fields: [
          { id: 'calendar_summary', label: '予定名', kind: 'text' },
          {
            id: 'calendar_start',
            label: '開始',
            kind: 'text',
            placeholder: '2026-09-30T10:00:00+09:00',
          },
          {
            id: 'calendar_end',
            label: '終了',
            kind: 'text',
            placeholder: '2026-09-30T10:30:00+09:00',
          },
          { id: 'calendar_description', label: '説明', kind: 'textarea' },
          { id: 'calendar_location', label: '場所', kind: 'text' },
          {
            id: 'calendar_attendees',
            label: '参加者',
            kind: 'text',
            placeholder: 'a@example.com,b@example.com',
          },
          {
            id: 'calendar_provider',
            label: 'プロバイダ',
            kind: 'select',
            options: [
              { value: 'google-workspace', label: 'Google Workspace' },
              { value: 'm365', label: 'Microsoft 365' },
            ],
          },
          { id: 'calendar_id', label: 'カレンダー ID（任意）', kind: 'text' },
          {
            id: 'calendar_time_zone',
            label: 'タイムゾーン（任意）',
            kind: 'text',
            placeholder: 'Asia/Tokyo',
          },
        ],
      },
      {
        id: 'workbench.calendar-apply',
        label: '承認済み予定を作成',
        description: '保存済み proposal の approval を再検証してから作成します',
        effect: 'apply',
        capability: 'governed',
        max_concurrent: 1,
        input_fields: [
          { id: 'calendar_approval_request_id', label: '承認リクエスト ID', kind: 'text' },
          {
            id: 'calendar_confirm',
            label: '内容を確認しました',
            kind: 'select',
            options: [
              { value: '', label: '確認が必要です' },
              { value: 'yes', label: '確認して作成' },
            ],
          },
        ],
      },
      {
        id: 'workbench.calendar-reconcile',
        label: '不明な予定を照合',
        description: 'provider agenda を read-only 照合し、一意一致時だけ proposal を確定します',
        effect: 'derive',
        capability: 'governed',
        max_concurrent: 1,
        input_fields: [
          {
            id: 'calendar_reconcile_approval_request_id',
            label: '承認リクエスト ID',
            kind: 'text',
          },
        ],
      },
      {
        id: 'workbench.ocr-extract',
        label: '添付を OCR',
        description: '保存済み record の artifact ID を指定して scoped OCR を実行します',
        effect: 'derive',
        capability: 'governed',
        max_concurrent: 2,
        input_fields: [
          { id: 'ocr_artifact_id', label: 'artifact ID', kind: 'text', placeholder: '01-…' },
          { id: 'ocr_language', label: '言語（任意）', kind: 'text', placeholder: 'ja' },
          {
            id: 'ocr_mode',
            label: 'OCR モード',
            kind: 'select',
            options: [
              { value: 'privacy_first', label: 'privacy first' },
              { value: 'balanced', label: 'balanced' },
            ],
          },
          {
            id: 'ocr_extract_structure',
            label: '構造を抽出',
            kind: 'select',
            options: [
              { value: '', label: 'しない' },
              { value: 'yes', label: 'する' },
            ],
          },
        ],
      },
      {
        id: 'workbench.knowledge-propose',
        label: '知識候補を提案',
        description: '保存済み handoff を根拠に human review 用の候補を作ります',
        effect: 'propose',
        capability: 'governed',
        max_concurrent: 2,
        input_fields: [{ id: 'knowledge_summary', label: '候補の要約', kind: 'textarea' }],
      },
    ],
    preview_template: '用途: {entry_type}\n期限: {due}\n\n{body}',
  },
];

export const PAD_ADAPTERS: readonly PadAdapter[] = ADAPTER_CONFIGS.map(makeAdapter);

export function getPadAdapter(padId: PadId): PadAdapter {
  const adapter = PAD_ADAPTERS.find((candidate) => candidate.pad_id === padId);
  if (!adapter || !getPadRegistryEntry(padId))
    throw new Error(`adapter is not registered: ${padId}`);
  return adapter;
}

export function assertPadAdaptersComplete(): void {
  for (const entry of PAD_REGISTRY) {
    const adapter = getPadAdapter(entry.id);
    if (adapter.id !== entry.adapter_id || adapter.input_kind !== entry.input_kind) {
      throw new Error(`adapter contract mismatch: ${entry.id}`);
    }
  }
}

export function publicPadAdapterConfigs(): readonly {
  pad_id: PadId;
  input_kind: PadInputKind;
  body_mode: PadAdapter['body_mode'];
  fields: readonly AdapterField[];
  actions: readonly PadActionDescriptor[];
  preview_template: string;
}[] {
  return PAD_ADAPTERS.map(
    ({ pad_id, input_kind, body_mode, fields, actions, preview_template }) => ({
      pad_id,
      input_kind,
      body_mode,
      fields,
      actions,
      preview_template,
    })
  );
}
