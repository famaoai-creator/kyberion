/**
 * Viewer copy in Japanese and English. The host is a developer/operator tool,
 * so its strings live with the app rather than in the product vocabulary
 * catalog; producers' own copy always arrives inside the A2UI messages.
 */

export type Locale = 'ja' | 'en';

export interface ViewerStrings {
  title: string;
  subtitle: string;
  sources: string;
  providers: string;
  components: string;
  resources: string;
  loadByPath: string;
  pathPlaceholder: string;
  load: string;
  autoRefresh: string;
  paste: string;
  pastePlaceholder: string;
  apply: string;
  invalidJson: string;
  tenant: string;
  tenantPlaceholder: string;
  noSurface: string;
  loading: string;
  loadFailed: string;
  actionFailed: string;
  actionDone: string;
  pathNotAllowed: string;
  send: string;
  inputPlaceholder: string;
  inspector: string;
  report: string;
  rendered: string;
  unsupported: string;
  none: string;
  actions: string;
  dataModel: string;
  tree: string;
  history: string;
  rejected: string;
  implicitSurface: string;
  catalogUnavailable: string;
  noResources: string;
  noA2UI: string;
  rawJson: string;
  emptySurface: string;
  unsupportedComponent: string;
  clear: string;
}

const ja: ViewerStrings = {
  title: 'A2UI ホスト',
  subtitle: 'どの A2UI でも読み込み、描画し、中身を確かめる',
  sources: 'ソース',
  providers: '提供元',
  components: '部品',
  resources: 'リソース',
  loadByPath: 'パスで読み込む',
  pathPlaceholder: '/api/headless/a2ui/…',
  load: '読み込む',
  autoRefresh: '自動で更新（4 秒ごと）',
  paste: 'メッセージを貼り付ける',
  pastePlaceholder: '[{"createSurface":{"surfaceId":"demo","catalogId":"std","title":"デモ"}}, …]',
  apply: '適用',
  invalidJson: 'JSON として読めませんでした',
  tenant: 'テナント',
  tenantPlaceholder: '未指定',
  noSurface: 'まだサーフェスがありません。左のソースを選んでください。',
  loading: '読み込み中…',
  loadFailed: '読み込めませんでした',
  actionFailed: '操作に失敗しました',
  actionDone: '操作を実行しました',
  pathNotAllowed: '/api/ から始まるパスだけ読み込めます',
  send: '送る',
  inputPlaceholder: '入力して送る',
  inspector: 'インスペクタ',
  report: '描画結果',
  rendered: '描画した部品',
  unsupported: '未対応の型',
  none: 'なし',
  actions: '操作',
  dataModel: 'データモデル',
  tree: '部品ツリー',
  history: 'メッセージ履歴',
  rejected: '不正なメッセージ',
  implicitSurface: '（createSurface なし）',
  catalogUnavailable: 'カタログを取得できません（提供元が起動していない可能性があります）',
  noResources: 'この提供元には表示できるサーフェスがありません',
  noA2UI: '応答に A2UI が含まれていません',
  rawJson: '受け取った JSON をそのまま表示しています',
  emptySurface: 'このサーフェスにはまだ部品がありません',
  unsupportedComponent: '未対応の部品',
  clear: 'すべて消す',
};

const en: ViewerStrings = {
  title: 'A2UI Host',
  subtitle: 'Load, render and inspect any A2UI surface',
  sources: 'Sources',
  providers: 'Providers',
  components: 'Components',
  resources: 'Resources',
  loadByPath: 'Load by path',
  pathPlaceholder: '/api/headless/a2ui/…',
  load: 'Load',
  autoRefresh: 'Auto refresh (every 4 s)',
  paste: 'Paste messages',
  pastePlaceholder: '[{"createSurface":{"surfaceId":"demo","catalogId":"std","title":"Demo"}}, …]',
  apply: 'Apply',
  invalidJson: 'Could not parse JSON',
  tenant: 'Tenant',
  tenantPlaceholder: 'not set',
  noSurface: 'No surface yet. Pick a source on the left.',
  loading: 'Loading…',
  loadFailed: 'Could not load',
  actionFailed: 'Action failed',
  actionDone: 'Action executed',
  pathNotAllowed: 'Only paths starting with /api/ can be loaded',
  send: 'Send',
  inputPlaceholder: 'Type and send',
  inspector: 'Inspector',
  report: 'Render report',
  rendered: 'Rendered components',
  unsupported: 'Unsupported types',
  none: 'none',
  actions: 'Actions',
  dataModel: 'Data model',
  tree: 'Component tree',
  history: 'Message history',
  rejected: 'rejected message',
  implicitSurface: '(no createSurface)',
  catalogUnavailable: 'Catalog unavailable (the provider may not be running)',
  noResources: 'This provider publishes no viewable surface',
  noA2UI: 'The response contains no A2UI',
  rawJson: 'Showing the received JSON as is',
  emptySurface: 'This surface has no components yet',
  unsupportedComponent: 'Unsupported component',
  clear: 'Clear all',
};

export function stringsFor(locale: Locale): ViewerStrings {
  return locale === 'ja' ? ja : en;
}

export function detectLocale(language: string | undefined): Locale {
  return (language ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
