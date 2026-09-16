import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import { PERSONAL_PADS_SURFACE, type PersonalPadsSurface } from './surface.js';
import { personalPadsClientScript } from './client-runtime.js';
import { allowedPadTiers, type PadTier } from './storage.js';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function storageLabelForTier(tier: string, padLabel: string): string {
  if (tier === 'personal') return 'このテナントの個人記録';
  if (tier === 'confidential') return 'このテナントの共有記録';
  return `公開 scope の ${padLabel}`;
}

export function personalPadsPage(
  token: string,
  context: LocalPadContext,
  surface: PersonalPadsSurface = PERSONAL_PADS_SURFACE
): string {
  const menuItems = surface.getMenu();
  const defaultPad = menuItems[0];
  const top = surface.getTop(context);
  const surfaceContract = surface.getSurfaceContract();
  const menu = menuItems
    .map(
      (pad) =>
        `<button class="pad" data-pad="${esc(pad.id)}" aria-pressed="false"><span>${esc(pad.label)}</span><small>${esc(pad.description)}</small></button>`
    )
    .join('');
  const initialStorageLabel = storageLabelForTier(
    String(top.scope.tier),
    defaultPad?.label ?? 'pad'
  );
  const allowedTiers = allowedPadTiers(top.scope.tier as PadTier);
  const tierOptions = (['personal', 'confidential', 'public'] as const)
    .map((tier) => {
      const label =
        tier === 'personal'
          ? 'personal · 個人'
          : tier === 'confidential'
            ? 'confidential · テナント共有'
            : 'public · 公開';
      return `<option value="${tier}"${allowedTiers.includes(tier) ? '' : ' disabled'}>${label}</option>`;
    })
    .join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kyberion · Pads</title><style>
:root{color-scheme:light;--ink:#172231;--muted:#637083;--line:#dce3eb;--bg:#f3f6f8;--panel:#fff;--accent:#246b61;--accent-2:#dff1ec;--danger:#a94b52;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Yu Gothic",Meiryo,sans-serif}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:radial-gradient(circle at 75% -20%,#e4f3ef,transparent 42%),var(--bg)}header{padding:28px clamp(18px,4vw,52px) 20px;display:flex;justify-content:space-between;gap:18px;align-items:end}h1,h2,p{margin:0}h1{font-size:clamp(24px,4vw,36px);letter-spacing:-.03em}header p{color:var(--muted);margin-top:7px;font-size:13px}.scope{display:flex;gap:8px;flex-wrap:wrap;justify-content:end}.chip{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:7px 11px;font-size:12px}.chip strong{font-weight:650}.layout{display:grid;grid-template-columns:minmax(190px,260px) minmax(280px,1fr) minmax(240px,340px);gap:16px;padding:0 clamp(18px,4vw,52px) 42px}.panel{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:18px;box-shadow:0 12px 35px #31465b12;padding:14px}.nav{display:grid;gap:7px;align-content:start}.pad{display:grid;gap:3px;text-align:left;border:1px solid transparent;background:transparent;border-radius:12px;padding:11px;cursor:pointer;color:var(--ink);font:inherit}.pad:hover,.pad.active{background:var(--accent-2);border-color:#b8ded5}.pad span{font-size:13px;font-weight:650}.pad small{font-size:11px;color:var(--muted);line-height:1.35}.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}.editor{display:grid;gap:13px}.editor h2{font-size:22px}.editor-fields{display:grid;gap:13px}.field{display:grid;gap:6px;font-size:12px;color:var(--muted)}.file-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.file-row input{flex:1;min-width:180px}input,textarea,select{width:100%;font:inherit;color:var(--ink);background:#fbfcfd;border:1px solid var(--line);border-radius:10px;padding:11px}textarea{min-height:170px;resize:vertical;line-height:1.6}.actions{display:flex;gap:8px;align-items:center}.drawing-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}.action-list{flex-wrap:wrap;padding-top:2px}.action-item{display:grid;gap:3px;min-width:150px}.action-list button{font-size:12px}.action-list small{display:block;color:var(--muted);font-size:11px;width:100%}.action-result{margin:0;background:#f7faf9;border:1px solid var(--line);border-radius:10px;padding:11px;white-space:pre-wrap;max-height:240px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.primary{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:11px 16px;font:inherit;cursor:pointer}.secondary{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px 13px;font:inherit;cursor:pointer}.status{font-size:12px;color:var(--muted);min-height:18px}.history{display:grid;gap:10px;align-content:start}.history-head{display:flex;justify-content:space-between;align-items:center}.history h2{font-size:17px}.history-list{display:grid;gap:8px;max-height:64vh;overflow:auto}.record{border:1px solid var(--line);border-radius:11px;background:#fbfcfd;padding:10px;cursor:pointer}.record:hover{border-color:#9ac9be}.record strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.record time{display:block;color:var(--muted);font-size:11px;margin-top:4px}.empty{font-size:12px;color:var(--muted);line-height:1.5;padding:12px 4px}.help{color:var(--muted);font-size:11px;line-height:1.5}.drawing-field canvas{display:block;width:100%;height:220px;touch-action:none;cursor:crosshair;background:#f6faf9;border:1px dashed #94c9bf;border-radius:10px}.annotation-stage{position:relative;width:100%;min-height:220px;background:#f6faf9;border:1px dashed #94c9bf;border-radius:10px;overflow:hidden}.annotation-stage .annotation-overlay{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.annotation-stage canvas{position:relative;background:transparent;border:0}.image-preview{display:block;max-width:100%;max-height:220px;border-radius:10px;border:1px solid var(--line);margin-top:7px}@media(max-width:900px){.layout{grid-template-columns:190px minmax(280px,1fr)}.history{grid-column:1/-1}.history-list{max-height:260px}}@media(max-width:620px){header{display:grid}.scope{justify-content:start}.layout{grid-template-columns:1fr}.nav{display:flex;overflow:auto}.pad{min-width:180px}.history{grid-column:auto}}
</style></head><body><header><div><div class="eyebrow">Kyberion local pads</div><h1>${esc(top.title)}</h1><p>${esc(top.subtitle)}</p></div><div class="scope"><span class="chip">tenant <strong id="tenant">${esc(top.scope.tenant_slug || 'public')}</strong></span><span class="chip">tier <strong id="tier">${esc(top.scope.tier)}</strong></span><span class="chip">viewer <strong>${esc(top.viewer_principal)}</strong></span></div></header><main class="layout"><nav class="panel nav" aria-label="Pad menu">${menu}</nav><section class="panel editor"><div><div class="eyebrow" id="pad-kind">${esc(defaultPad?.id ?? '')}</div><h2 id="pad-title">${esc(defaultPad?.label ?? '')}</h2><p class="help" id="pad-description">${esc(defaultPad?.description ?? '')}</p></div><label class="field">保存する tier<select id="tier-select">${tierOptions}</select></label><div id="pad-fields" class="editor-fields"></div><div id="pad-actions" class="actions action-list" aria-label="Pad actions"></div><label class="field">タイトル<input id="title" maxlength="200" placeholder="あとで見つけやすい名前"></label><label class="field" id="body-field"><span>内容</span><textarea id="body" placeholder="ここに記録します"></textarea></label><div class="actions"><button class="primary" id="save">保存する</button><button class="secondary" id="clear">下書きを消去</button></div><div class="status" id="status" role="status"></div><pre class="action-result" id="action-result" hidden></pre><p class="help">保存先: <span id="storage-label">${esc(initialStorageLabel)}</span> · 物理パスは表示しません</p></section><aside class="panel history"><div class="history-head"><h2>履歴</h2><button class="secondary" id="refresh">更新</button></div><div class="history-list" id="history"><div class="empty">この pad の保存履歴はまだありません。</div></div></aside></main>${personalPadsClientScript(token, context, surfaceContract)}</body></html>`;
}

/** Kept as a seam for future CSP nonce and shell-level instrumentation. */
export function augmentPersonalPadsPage(page: string): string {
  return page;
}
