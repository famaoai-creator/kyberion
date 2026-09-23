/**
 * review-layer.ts — 任意のHTMLレポートに後付けする「推敲・修正・音声・保存」レイヤ（正本）
 *
 * このモジュールが単一の正本。server.ts（配信時注入）、stamp.ts（ファイル焼き込み）、
 * mission-alignment-gate/render-brief.ts が共用する。
 *
 * PA-05: UI は共有 A2UI キット（kyberion-base）で描画する。
 *  - ツールバー ui:toolbar（編集 / コメント / 一覧 トグル、復元、HTML書出し、コメントMD、
 *    保存(window.__RV_SAVE__ がある時のみ＝方式B)、破棄、状態表示）
 *  - 確認とコメント入力 ui:dialog（confirm() は使わない）、コメント音声入力 ui:voice-input
 *  - コメント一覧 ui:section + ui:list
 * レイヤは `<kb-review-layer id="rv-bar">` の Shadow DOM 内に描画し、レポート側 CSS と
 * キット CSS を互いに隔離する（トークンの `:root` は `:host` に置き換えて注入）。
 *
 * アセット:
 *  - `assets: 'inline'`（既定）: キットの vanilla モジュール一式をレイヤ内に同梱し、
 *    ブラウザで blob: モジュールとして読み込む。file:// でもサーバ無しで動く（stamp / brief）。
 *  - `assets: 'served'`: `/shared-ui/kyberion-ui.js` を読む（report-review server が
 *    handlePadUiAsset で配信）。
 *
 * マーカー: レイヤ全体を <!--RV-LAYER-->…<!--/RV-LAYER--> で囲む。server.ts は保存時にこの範囲を除去し、
 * 正本HTMLにレイヤが焼き込まれない（配信時オーバーレイ）ようにする。レイヤ内の JSON / スクリプトは
 * `<` をエスケープしているので、この範囲の途中にマーカー文字列が現れることはない。
 * コメントの保存形式（mark.rv-cmt[data-note][data-anchor]）と localStorage キー（rvedit:<path>）は従来どおり。
 */
import * as path from 'node:path';
import { getUiMessageBundle } from '@agent/core';
import { resolveLocale } from '@agent/core/locale';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeReaddir } from '@agent/core/secure-io';
import type { VocabularyKey } from '@agent/core/t';
import {
  escapePadHtml,
  inlinePadStylesheets,
  PAD_UI_ROUTES,
  PAD_UI_VANILLA_DIR,
  padT,
  padTexts,
  toPadInlineJson,
} from '../lib/pad-ui.js';

export const RV_LAYER_OPEN = '<!--RV-LAYER-->';
export const RV_LAYER_CLOSE = '<!--/RV-LAYER-->';

export const REVIEW_LAYER_CLIENT_SCRIPT = 'scripts/report-review/review-layer-client.js';
/** Entry module of the kit (the vanilla renderer). */
export const REVIEW_LAYER_KIT_ENTRY = 'kyberion-ui.js';
/** Stand-in for a bundled module's URL inside another module's source (replaced in the browser). */
export const REVIEW_LAYER_MODULE_PLACEHOLDER = 'kb-review-layer-module:';

export type ReviewLayerAssets = 'inline' | 'served';

/** 本文とみなす要素のCSSセレクタ（既定は .wrap → 無ければ body）。レポート側で変えたい場合に指定。 */
export interface ReviewLayerOptions {
  contentSelector?: string;
  /** Layer language (default: `resolveLocale()`). */
  locale?: SupportedLocale;
  /** `inline` (default, works offline) or `served` (kit from the pad-ui routes). */
  assets?: ReviewLayerAssets;
}

/** Vocabulary the browser layer reads via `t(key)`. */
export const REVIEW_LAYER_TEXT_KEYS = [
  'report_review:toolbar_label',
  'report_review:edit',
  'report_review:comment',
  'report_review:list',
  'report_review:restore',
  'report_review:export_html',
  'report_review:export_md',
  'report_review:save',
  'report_review:discard',
  'report_review:comments_title',
  'report_review:comment_item_meta',
  'report_review:no_comments',
  'report_review:comment_dialog_title',
  'report_review:comment_dialog_message',
  'report_review:comment_label',
  'report_review:note_placeholder',
  'report_review:register',
  'report_review:cancel',
  'report_review:comment_voice_label',
  'report_review:dictation_note',
  'report_review:restore_title',
  'report_review:restore_confirm',
  'report_review:discard_title',
  'report_review:discard_confirm',
  'report_review:review_available',
  'report_review:previous_edit',
  'report_review:saved',
  'report_review:save_failed',
  'report_review:edit_on',
  'report_review:edit_off',
  'report_review:comment_on',
  'report_review:comment_off',
  'report_review:no_restore',
  'report_review:restored',
  'report_review:html_exported',
  'report_review:md_empty',
  'report_review:md_exported',
  'report_review:discarded',
  'report_review:saving',
  'report_review:saved_to_file',
  'report_review:markdown_title',
  'report_review:generated',
  'report_review:target',
] as const satisfies readonly VocabularyKey[];

export interface ReviewLayerModule {
  name: string;
  /** Source with every bundled relative import replaced by `PLACEHOLDER + name`. */
  source: string;
  /** Bundled modules this one imports (all listed earlier in the bundle). */
  deps: string[];
}

const MODULE_NAME = /^[a-z0-9-]+\.js$/;
const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])\.\/([a-z0-9-]+\.js)\2/g;

/**
 * The kit's vanilla modules reachable from `kyberion-ui.js`, dependencies
 * first, with relative imports turned into placeholders the browser swaps for
 * blob: URLs. Throws on an import cycle (blob: modules cannot express one).
 */
export function buildReviewLayerModuleBundle(
  readModule: (name: string) => string | null
): ReviewLayerModule[] {
  const ordered: ReviewLayerModule[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`review layer: import cycle through ${name}`);
    const raw = readModule(name);
    if (raw === null) throw new Error(`review layer: kit module ${name} not found`);
    visiting.add(name);
    const deps: string[] = [];
    const source = raw.replace(
      RELATIVE_IMPORT,
      (match, lead: string, quote: string, dep: string) => {
        if (readModule(dep) === null) return match;
        if (!deps.includes(dep)) deps.push(dep);
        return `${lead}${quote}${REVIEW_LAYER_MODULE_PLACEHOLDER}${dep}${quote}`;
      }
    );
    for (const dep of deps) visit(dep);
    visiting.delete(name);
    done.add(name);
    ordered.push({ name, source, deps });
  };
  visit(REVIEW_LAYER_KIT_ENTRY);
  return ordered;
}

let cachedBundle: ReviewLayerModule[] | null = null;

/** The bundle for the repository's kit (read once per process). */
export function reviewLayerModuleBundle(): ReviewLayerModule[] {
  if (cachedBundle) return cachedBundle;
  const dir = pathResolver.rootResolve(PAD_UI_VANILLA_DIR);
  const available = new Set(safeReaddir(dir).filter((file) => MODULE_NAME.test(file)));
  const cache = new Map<string, string>();
  cachedBundle = buildReviewLayerModuleBundle((name) => {
    if (!available.has(name)) return null;
    if (!cache.has(name)) {
      cache.set(name, String(safeReadFile(path.join(dir, name), { encoding: 'utf8' })));
    }
    return cache.get(name) ?? null;
  });
  return cachedBundle;
}

/**
 * Re-key the page token layer for a shadow root: `:root` → `:host`, with its
 * attribute / `:not()` qualifiers moved into `:host(...)`.
 */
export function scopePadCssToShadowRoot(css: string): string {
  return css.replace(
    /:root((?:\[[^\]]*\]|:not\((?:[^()]|\([^()]*\))*\))*)/g,
    (_match, qualifiers: string) => (qualifiers ? `:host(${qualifiers})` : ':host')
  );
}

/** Layout of the layer inside its shadow root (tokens only; no literals of the kit's own). */
const REVIEW_LAYER_SHADOW_CSS = `
:host { color-scheme: var(--kb-ui-color-scheme); }
.rv-root {
  color: var(--kb-ui-text);
  font-family: var(--kb-ui-font-sans);
  font-size: var(--kb-ui-font-size-sm);
  line-height: 1.5;
}
.rv-root :where(*, *::before, *::after) { box-sizing: border-box; }
.rv-toolbar {
  position: fixed;
  top: var(--kb-ui-space-2);
  left: var(--kb-ui-space-3);
  max-width: calc(100vw - 2 * var(--kb-ui-space-3));
}
.rv-toolbar .kb-toolbar { box-shadow: var(--kb-ui-shadow-md); }
.rv-comments {
  position: fixed;
  right: var(--kb-ui-space-3);
  bottom: var(--kb-ui-space-3);
  width: 360px;
  max-width: 88vw;
  max-height: 46vh;
  overflow: auto;
  border-radius: var(--kb-ui-radius-lg);
  box-shadow: var(--kb-ui-shadow-md);
}
.rv-comments[hidden] { display: none; }
.rv-comments .kb-section { padding: var(--kb-ui-space-3) var(--kb-ui-space-4); }
.rv-voice { margin-top: var(--kb-ui-space-1); }
@media print { .rv-root { display: none; } }
`;

let cachedShadowCss: string | null = null;

/** The kit stylesheet (tokens + components) scoped to the layer's shadow root. */
export function reviewLayerShadowCss(): string {
  if (!cachedShadowCss) {
    cachedShadowCss = `${scopePadCssToShadowRoot(inlinePadStylesheets())}\n${REVIEW_LAYER_SHADOW_CSS}`;
  }
  return cachedShadowCss;
}

/** Page-side CSS: comment highlights and the edit outline live in the report, not the layer. */
function hostPageCss(selector: string): string {
  return [
    `body.rv-editing ${selector}{outline:2px dashed #2f5c9e;outline-offset:6px}`,
    'mark.rv-cmt{background:rgba(216,187,82,.45);border-bottom:2px solid #b8860b;cursor:help;border-radius:2px}',
    `@media print{#rv-bar{display:none!important}body.rv-editing ${selector}{outline:none}}`,
  ]
    .join('\n')
    .replace(/</g, '\\3c ');
}

/** Script source that cannot close its element or open an HTML comment. */
function inlineModuleSource(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function clientModuleSource(): string {
  return String(
    safeReadFile(pathResolver.rootResolve(REVIEW_LAYER_CLIENT_SCRIPT), { encoding: 'utf8' })
  );
}

/** The data the browser layer reads from `#rv-layer-data`. */
export function buildReviewLayerData(options: ReviewLayerOptions = {}): Record<string, unknown> {
  const locale = options.locale ?? resolveLocale();
  const assets: ReviewLayerAssets = options.assets === 'served' ? 'served' : 'inline';
  return {
    version: 2,
    locale,
    assets,
    contentSelector: options.contentSelector || '.wrap',
    messages: getUiMessageBundle(locale).messages,
    texts: padTexts(REVIEW_LAYER_TEXT_KEYS, locale),
    css: reviewLayerShadowCss(),
    ...(assets === 'served'
      ? { renderer: PAD_UI_ROUTES.renderer }
      : {
          entry: REVIEW_LAYER_KIT_ENTRY,
          placeholder: REVIEW_LAYER_MODULE_PLACEHOLDER,
          modules: reviewLayerModuleBundle(),
        }),
  };
}

export function reviewLayerMarkup(opts: ReviewLayerOptions = {}): string {
  const selector = opts.contentSelector || '.wrap';
  const locale = opts.locale ?? resolveLocale();
  const t = padT(locale);
  const data = buildReviewLayerData({ ...opts, contentSelector: selector, locale });
  return [
    RV_LAYER_OPEN,
    `<style id="rv-layer-style">${hostPageCss(selector)}</style>`,
    `<kb-review-layer id="rv-bar" contenteditable="false" title="${escapePadHtml(
      t('report_review:bar_title')
    )}" style="all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000"></kb-review-layer>`,
    `<script type="application/json" id="rv-layer-data">${toPadInlineJson(data)}</script>`,
    `<script type="module">${inlineModuleSource(clientModuleSource())}</script>`,
    RV_LAYER_CLOSE,
  ].join('\n');
}
