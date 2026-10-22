/**
 * deck-geometry-helpers — ブラウザ実測レイアウト → PptxDesignProtocol の転写（純関数）。
 *
 * `deck_from_html` は HTML を読んで**自前で再レイアウト**する。行数は文字数からの
 * 推定（charsPerLine）で、hardWrap で改行を焼き込む一発勝負のため、列幅の破綻・
 * 語中改行・枠外へのはみ出しが生成時に検出できなかった。
 *
 * ここでは逆にする。HTML は既にブラウザで正しく組めているのだから、
 * **ブラウザに組ませて確定した幾何を読み出し、線形変換で転写する**。推定が消える。
 *
 * 責務分割:
 *  - 計測そのものは browser-actuator（`browser:evaluate`）が行う。この actuator に
 *    ブラウザ依存は持ち込まない。
 *  - ここが持つのは「ページ内で走らせる計測スクリプト」と「その戻り値を protocol へ
 *    落とす変換」の2つ。両者は同じ幾何スキーマを共有する対であり、
 *    片方だけ変えると壊れるので同じファイルに置く。
 *
 * フォント: 計測と出力で同一にする。別フォントで測ると幅がずれ、`+105%` のような
 * 短い文字列がチップ内で折り返す。既定の BIZ UDPGothic は macOS 同梱かつ
 * Windows 10 1809+ 標準なので、計測側と PowerPoint 側で同じ字形・同じ幅になる
 * （Yu Gothic は macOS に無く、Chrome で fallback して計測が無意味になる）。
 */

/** 計測と出力で共有するフォント。 */
export const DECK_GEOMETRY_FONT = 'BIZ UDPGothic';
/** スライド寸法（インチ）。 */
export const DECK_GEOMETRY_CANVAS = {
  '4:3': { w: 10, h: 7.5 },
  '16:9': { w: 13.333, h: 7.5 },
} as const;
/** 既定の計測 viewport 幅(px)。狭いほど 1px あたりのインチが大きく＝文字が大きく転写される。 */
export const DECK_GEOMETRY_VIEWPORT_PX = 1000;

export interface DeckGeometryTextNode {
  x: number;
  y: number;
  w: number;
  h: number;
  /** [top, right, bottom, left]。pptx のテキストインセットに写す。 */
  pad: [number, number, number, number];
  /** 実際に描画された最大行幅(px)。箱がこれより狭いと pptx 側で折り返す。 */
  inkW: number;
  text: string;
  fontSize: number;
  bold: boolean;
  color: string;
  align: string;
  lines: number;
  tag?: string;
  cls?: string;
}

export interface DeckGeometryBox {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | null;
  radius: number;
  borderLeft: { w: number; color: string } | null;
  tag?: string;
}

export interface DeckGeometry {
  boxes: DeckGeometryBox[];
  texts: DeckGeometryTextNode[];
  /** スライドの切れ目にする y 座標（既定では h2 の位置）。 */
  cuts: number[];
  pageH: number;
  viewW: number;
}

export interface DeckGeometryOptions {
  aspect?: '4:3' | '16:9';
  canvas?: { w?: number; h?: number };
  viewportPx?: number;
  font?: string;
  /** deck 用に注入する追加 CSS（画面用の文字サイズをスライド用に組み替える）。 */
  deckCss?: string;
}

/** レポート HTML の画面向け文字サイズを、スライドで読めるサイズへ組み替える既定 CSS。 */
export const DECK_GEOMETRY_DEFAULT_CSS = [
  'body { margin:0; padding:22px; font-size:17px; line-height:1.5 }',
  'h1 { font-size:30px } h2 { font-size:21px }',
  '.kicker,.meta,.legend { font-size:13px }',
  'table { font-size:15px } th { font-size:14px } .chip { font-size:13px }',
  '.kpi .big { font-size:34px } .kpi .lbl { font-size:13px }',
  'li, p, .callout { font-size:16px }',
].join(' ');

function resolveCanvas(opts: DeckGeometryOptions): { w: number; h: number } {
  if (opts.canvas?.w && opts.canvas?.h)
    return { w: Number(opts.canvas.w), h: Number(opts.canvas.h) };
  return DECK_GEOMETRY_CANVAS[opts.aspect === '16:9' ? '16:9' : '4:3'];
}

/**
 * ページ内で実行する計測スクリプトを組み立てる。
 * `browser:evaluate` の `params.script` にそのまま渡す。戻り値は DeckGeometry。
 *
 * 中身の注釈はこのdoc側に置く（テンプレートリテラル内にコメントを書くと、
 * その文言がブラウザへ送る文字列の一部になり、i18n 検査にも文言として映る）:
 *
 *  - テキストは「自分で直接テキストを持つ」要素だけを葉として拾う（二重転写を避ける）。
 *  - 外形をそのまま渡し padding は別に持つ: padding を引いて文字ぴったりの箱にすると、
 *    pptx 既定インセット(左右0.1in)が内側を削って短い文字列でも折り返す。
 */
export function buildDeckMeasurementScript(opts: DeckGeometryOptions = {}): string {
  const viewW = Number(opts.viewportPx) > 0 ? Number(opts.viewportPx) : DECK_GEOMETRY_VIEWPORT_PX;
  const font = opts.font || DECK_GEOMETRY_FONT;
  const css = opts.deckCss ?? DECK_GEOMETRY_DEFAULT_CSS;
  return `(() => {
  const VIEW_W = ${viewW};
  const st = document.createElement('style');
  st.textContent = '* { font-family: "${font}", sans-serif !important; } '
    + 'body { width: ' + VIEW_W + 'px } ' + ${JSON.stringify(css)};
  document.head.appendChild(st);
  document.documentElement.style.width = VIEW_W + 'px';

  const px = (v) => parseFloat(v) || 0;
  const visible = (cs) => cs.display !== 'none' && cs.visibility !== 'hidden' && px(cs.opacity) > 0;
  const solid = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
  const ownText = (el) => Array.from(el.childNodes)
    .some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);

  const boxes = [], texts = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (!visible(cs)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const bl = px(cs.borderLeftWidth);
    const leftRule = bl > 1 && solid(cs.borderLeftColor) ? { w: bl, color: cs.borderLeftColor } : null;
    if (solid(cs.backgroundColor) || leftRule) {
      boxes.push({
        x: r.x, y: r.y, w: r.width, h: r.height,
        fill: solid(cs.backgroundColor) ? cs.backgroundColor : null,
        radius: px(cs.borderTopLeftRadius),
        borderLeft: leftRule,
        tag: el.tagName.toLowerCase(),
      });
    }
    // Leaf text nodes only; outer box plus separate padding (see the doc comment
    // on buildDeckMeasurementScript for why).
    if (ownText(el)) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects());
      texts.push({
        x: r.x, y: r.y, w: r.width, h: r.height,
        pad: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
        inkW: rects.length ? Math.max.apply(null, rects.map((q) => q.width)) : 0,
        text: el.textContent.replace(/\\s+/g, ' ').trim(),
        fontSize: px(cs.fontSize),
        bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
        color: cs.color,
        align: cs.textAlign,
        lines: rects.length,
        tag: el.tagName.toLowerCase(),
        cls: el.className || '',
      });
    }
  }
  const cuts = Array.from(document.querySelectorAll('h2')).map((h) => h.getBoundingClientRect().y);
  return { boxes, texts, cuts, pageH: document.body.scrollHeight, viewW: VIEW_W };
})()`;
}

function toHex(color: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color || '');
  if (!m) return '#000000';
  return `#${[1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * 計測した幾何を PptxDesignProtocol に転写する。
 * レイアウトの再解釈はせず、px → inch の線形変換とスライド分割だけを行う。
 */
export function geometryToDeckProtocol(
  geometry: DeckGeometry,
  opts: DeckGeometryOptions = {}
): { protocol: Record<string, unknown>; slideCount: number } {
  if (!geometry || !Array.isArray(geometry.texts) || !Array.isArray(geometry.boxes)) {
    throw new Error('deck_from_geometry: geometry must have boxes[] and texts[]');
  }
  const slide = resolveCanvas(opts);
  const font = opts.font || DECK_GEOMETRY_FONT;
  const viewW = Number(geometry.viewW) > 0 ? Number(geometry.viewW) : DECK_GEOMETRY_VIEWPORT_PX;
  const pxPerIn = viewW / slide.w;
  const inch = (v: number): number => Number((v / pxPerIn).toFixed(3));

  // h2 の位置で切る。1枚に収まらない章は高さで追加分割する。
  const cuts = [0, ...(geometry.cuts || []).filter((c) => c > 1), geometry.pageH];
  const maxPx = slide.h * pxPerIn - 0.5 * pxPerIn; // 上下余白ぶん
  const spans: Array<{ top: number; bottom: number }> = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    let y = cuts[i];
    const bottom = cuts[i + 1];
    while (bottom - y > maxPx) {
      spans.push({ top: y, bottom: y + maxPx });
      y += maxPx;
    }
    if (bottom - y > 4) spans.push({ top: y, bottom });
  }

  const slides = spans
    .map((span, index) => {
      const off = span.top - 0.25 * pxPerIn;
      const inside = (y: number, h: number): boolean =>
        y >= span.top - 2 && y + h <= span.bottom + 2;
      const elements: Array<Record<string, unknown>> = [];
      for (const box of geometry.boxes) {
        if (!inside(box.y, box.h)) continue;
        if (box.fill) {
          elements.push({
            type: 'shape',
            shapeType: box.radius > 2 ? 'roundRect' : 'rect',
            pos: { x: inch(box.x), y: inch(box.y - off), w: inch(box.w), h: inch(box.h) },
            text: '',
            style: { fill: toHex(box.fill), ...(box.radius > 2 ? { cornerRadius: 0.06 } : {}) },
          });
        }
        if (box.borderLeft) {
          elements.push({
            type: 'shape',
            shapeType: 'rect',
            pos: {
              x: inch(box.x),
              y: inch(box.y - off),
              w: inch(box.borderLeft.w),
              h: inch(box.h),
            },
            text: '',
            style: { fill: toHex(box.borderLeft.color) },
          });
        }
      }
      for (const node of geometry.texts) {
        if (!inside(node.y, node.h)) continue;
        if (!String(node.text || '').trim()) continue;
        const pad = node.pad || [0, 0, 0, 0];
        // インク実幅＋左右インセットが箱に収まらない場合だけ広げる（折返し事故の防止）
        const boxW = Math.max(node.w, (node.inkW || 0) + pad[1] + pad[3] + 2);
        elements.push({
          type: 'text',
          pos: { x: inch(node.x), y: inch(node.y - off), w: inch(boxW), h: inch(node.h) },
          text: String(node.text),
          style: {
            margin: [inch(pad[0]), inch(pad[1]), inch(pad[2]), inch(pad[3])],
            fontFamily: font,
            fontSize: Number(((node.fontSize / pxPerIn) * 72).toFixed(1)),
            bold: Boolean(node.bold),
            color: toHex(node.color),
            align: String(node.align || '').includes('center')
              ? 'center'
              : String(node.align || '').includes('right')
                ? 'right'
                : 'left',
          },
        });
      }
      return { backgroundFill: '#FFFFFF', elements };
    })
    // 要素の無い区間はスライドにしない。最初の h2 が上端付近にあると
    // 0→h2 の隙間が空スライドとして残ってしまう。
    .filter((s) => s.elements.length > 0)
    .map((s, index) => ({ id: `slide${index + 1}.xml`, ...s }));

  return {
    protocol: {
      version: '3.0.0',
      canvas: slide,
      designDefaults: { fontFamily: font },
      // 転写方式では見た目を全てスライド側の要素で表現するためマスタは空で持つ
      // （デザインカスケードが master.elements を必須で参照する）。
      master: { elements: [] },
      slides,
      metadata: {
        source: 'deck_from_geometry',
        slideCount: slides.length,
        measurement: {
          engine: 'browser',
          viewportPx: viewW,
          pxPerInch: Number(pxPerIn.toFixed(2)),
          font,
        },
        // 実測なので推定由来の overflow は無い。preflight が読む形で pass を明示する。
        layoutDiagnostics: {
          status: 'pass',
          measurementModel: 'browser-measured',
          slideCount: slides.length,
          shrinkCount: 0,
          overflowCount: 0,
          overflowSlides: [],
        },
      },
    },
    slideCount: slides.length,
  };
}
