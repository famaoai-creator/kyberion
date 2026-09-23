import type {
  KbStatus,
  KbStatusDomain,
  KbStatusTone,
  KyberionBaseAlias,
  KyberionBaseComponentType,
} from '@agent/core/a2ui-catalog';

/**
 * Client-safe mirror of the runtime constants in `@agent/core/a2ui-catalog`.
 *
 * The core module compiles the catalog JSON schema with ajv and reads it from
 * disk, so it must never be bundled into a browser. Only its *types* are
 * imported here; the few runtime tables a renderer needs are mirrored and
 * pinned to the core originals by `catalog.test.ts`.
 */

export const KB_COMPONENT_TYPES: readonly KyberionBaseComponentType[] = [
  'ui:app-shell',
  'ui:page-header',
  'ui:nav-rail',
  'ui:tabs',
  'ui:stack',
  'ui:grid',
  'ui:section',
  'ui:next-action',
  'ui:metric',
  'ui:kv',
  'ui:table',
  'ui:list',
  'ui:text',
  'ui:status-pill',
  'ui:badge',
  'ui:callout',
  'ui:empty-state',
  'ui:skeleton',
  'ui:button',
  'ui:disclosure',
];

export const KB_ALIASES: Readonly<Record<KyberionBaseAlias, KyberionBaseComponentType>> =
  Object.freeze({
    text: 'ui:text',
    button: 'ui:button',
    card: 'ui:section',
    container: 'ui:stack',
  });

/** Action id dispatched through `A2UIActionProvider` when a button tab is chosen without `onSelect`. */
export const TABS_SELECT_ACTION = 'ui:tabs.select';

const TYPE_SET: ReadonlySet<string> = new Set(KB_COMPONENT_TYPES);

/** Resolve a catalog type or legacy alias; `null` when the type is outside the catalog. */
export function resolveKbType(type: string): KyberionBaseComponentType | null {
  if (TYPE_SET.has(type)) return type as KyberionBaseComponentType;
  return Object.prototype.hasOwnProperty.call(KB_ALIASES, type)
    ? KB_ALIASES[type as KyberionBaseAlias]
    : null;
}

export const KB_STATUS_TONE_MAP: Readonly<Record<KbStatus, KbStatusTone>> = Object.freeze({
  ready: 'success',
  fully_automatable: 'success',
  connected: 'success',
  available: 'success',
  done: 'success',
  completed: 'success',
  recovered: 'success',
  running: 'success',
  active: 'info',
  connecting: 'info',
  working: 'info',
  busy: 'info',
  review: 'info',
  distilling: 'info',
  needs_clarification: 'warning',
  needs_external_assets: 'warning',
  needs_assets: 'warning',
  needs_setup: 'warning',
  missing_runtime_prerequisites: 'warning',
  needs_runtime_prerequisites: 'warning',
  pending: 'warning',
  degraded: 'warning',
  fallback: 'warning',
  paused: 'warning',
  stale: 'warning',
  blocked: 'danger',
  missing: 'danger',
  error: 'danger',
  unavailable: 'danger',
  failed: 'danger',
  disconnected: 'danger',
  offline: 'danger',
  'n/a': 'neutral',
  planned: 'neutral',
  archived: 'neutral',
  stopped: 'neutral',
});

/**
 * Default Japanese status labels, following the `status` namespace of
 * `user-facing-vocabulary.json` (the strings `renderStatus()` returns for
 * `ja`); a pill with an explicit `label` prop never consults this map.
 */
export const KB_STATUS_LABELS_JA: Readonly<Record<KbStatus, string>> = Object.freeze({
  active: '進行中',
  archived: '保管済み',
  available: '利用可能',
  blocked: '要対応',
  busy: '処理中',
  completed: '完了',
  connected: '接続済み',
  connecting: '接続中',
  degraded: '品質低下',
  disconnected: '未接続',
  distilling: '学習整理中',
  done: '完了',
  error: 'エラー',
  failed: '失敗',
  fallback: '代替',
  fully_automatable: 'そのまま実行可能',
  missing: '未設定',
  missing_runtime_prerequisites: '実行環境が不足',
  'n/a': '不要',
  needs_assets: '外部素材が必要',
  needs_clarification: '追加確認が必要',
  needs_external_assets: '外部素材が必要',
  needs_runtime_prerequisites: '実行環境が不足',
  needs_setup: '設定が必要',
  offline: '未接続',
  paused: '一時停止',
  pending: '確認待ち',
  planned: '予定',
  ready: '準備完了',
  recovered: '復旧',
  review: 'レビュー',
  running: '稼働中',
  stale: '応答遅延',
  stopped: '停止',
  unavailable: '利用不可',
  working: '処理中',
});

/** Domain-specific wording where the vocabulary differs from the default. */
const DOMAIN_LABEL_OVERRIDES_JA: Partial<
  Record<KbStatusDomain, Partial<Record<KbStatus, string>>>
> = {
  readiness: { ready: 'そのまま実行可能' },
  connection: { ready: '接続済み', degraded: '接続品質が低下' },
  provider: { ready: '利用可能', missing: '未導入', unavailable: 'エラー' },
  mission: { blocked: '停止中' },
};

export function isKbStatus(value: unknown): value is KbStatus {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(KB_STATUS_TONE_MAP, value)
  );
}

export function statusTone(status: string): KbStatusTone {
  return isKbStatus(status) ? KB_STATUS_TONE_MAP[status] : 'neutral';
}

/** Japanese label for a status; unknown values are shown verbatim rather than hidden. */
export function statusLabelJa(status: string, domain?: KbStatusDomain): string {
  if (!isKbStatus(status)) return status;
  return (domain && DOMAIN_LABEL_OVERRIDES_JA[domain]?.[status]) || KB_STATUS_LABELS_JA[status];
}
