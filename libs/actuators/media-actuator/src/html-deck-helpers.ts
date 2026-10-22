/**
 * html-deck-helpers — convention-based HTML → PptxDesignProtocol conversion.
 *
 * Backs the `media:deck_from_html` transform op. Parses Kyberion's
 * machine-generated report HTML (a known vocabulary: hero / h2 / h3 / p /
 * .callout / table / .chip|.sev / ul / .kpis / .grpttl), reads the report's own
 * :root design tokens, and emits an editable-native PptxDesignProtocol for
 * `media:pptx_render` — not a screenshot.
 *
 * Pure (string in → protocol out); all file IO lives in the op. No external
 * dependency: a small self-generated-HTML parser rather than cheerio/jsdom.
 */

import { semanticToken } from '@agent/core/semantic-design-tokens';

// ───────────────────────── minimal HTML parser ─────────────────────────
export interface HNode {
  tag: string; // '' for text nodes
  attrs: Record<string, string>;
  classes: string[];
  children: HNode[];
  text?: string;
}

const VOID = new Set([
  'br',
  'img',
  'meta',
  'link',
  'hr',
  'input',
  'source',
  'col',
  'wbr',
  'area',
  'base',
]);
const RAWTEXT = new Set(['style', 'script', 'textarea', 'title']);
export const MAX_HTML_DECK_INPUT_CHARS = 8 * 1024 * 1024;
const BULLET_PREFIX = String.fromCodePoint(0x30fb);
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  times: '×',
  bull: '•',
  larr: '←',
  rarr: '→',
  hairsp: ' ',
  ensp: ' ',
  emsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m: string, code: string) => {
    if (code[0] === '#') {
      const cp =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code) ? ENTITIES[code] : m;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const val = m[3] ?? m[4] ?? m[5] ?? '';
    attrs[m[1].toLowerCase()] = decodeEntities(val);
  }
  return attrs;
}

function mkEl(tag: string, attrs: Record<string, string>): HNode {
  return { tag, attrs, classes: (attrs.class || '').split(/\s+/).filter(Boolean), children: [] };
}

export function parseHtml(html: string): HNode {
  const root: HNode = { tag: '#root', attrs: {}, classes: [], children: [] };
  const stack: HNode[] = [root];
  const top = (): HNode => stack[stack.length - 1];
  let i = 0;
  const n = html.length;
  const pushText = (t: string): void => {
    if (!t) return;
    const decoded = decodeEntities(t);
    if (!decoded.trim()) {
      if (decoded.length)
        top().children.push({ tag: '', attrs: {}, classes: [], children: [], text: ' ' });
      return;
    }
    top().children.push({ tag: '', attrs: {}, classes: [], children: [], text: decoded });
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) {
      pushText(html.slice(lt));
      break;
    }
    let tagContent = html.slice(lt + 1, gt);
    i = gt + 1;
    if (tagContent[0] === '/') {
      const name = tagContent.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    const selfClose = tagContent.endsWith('/');
    if (selfClose) tagContent = tagContent.slice(0, -1);
    const sp = tagContent.search(/[\s/]/);
    const tag = (sp === -1 ? tagContent : tagContent.slice(0, sp)).toLowerCase();
    const el = mkEl(tag, parseAttrs(sp === -1 ? '' : tagContent.slice(sp + 1)));
    if (RAWTEXT.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = close.exec(rest);
      el.children.push({
        tag: '',
        attrs: {},
        classes: [],
        children: [],
        text: m ? rest.slice(0, m.index) : rest,
      });
      top().children.push(el);
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }
    const t = top().tag;
    if (
      (tag === 'li' && t === 'li') ||
      (tag === 'p' && t === 'p') ||
      ((tag === 'td' || tag === 'th') && (t === 'td' || t === 'th')) ||
      (tag === 'tr' && (t === 'tr' || t === 'td' || t === 'th'))
    ) {
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === t) {
          stack.length = s;
          break;
        }
      }
    }
    top().children.push(el);
    if (!selfClose && !VOID.has(tag)) stack.push(el);
  }
  return root;
}

function innerText(node: HNode): string {
  if (node.tag === '') return node.text || '';
  if (node.tag === 'script' || node.tag === 'style') return '';
  if (node.tag === 'br') return '\n';
  return node.children.map(innerText).join('');
}
function normText(node: HNode): string {
  return innerText(node).replace(/\s+/g, ' ').trim();
}
function hasClass(node: HNode, cls: string): boolean {
  return node.classes.includes(cls);
}
function findFirst(node: HNode, pred: (n: HNode) => boolean): HNode | undefined {
  for (const c of node.children) {
    if (pred(c)) return c;
    const r = findFirst(c, pred);
    if (r) return r;
  }
  return undefined;
}
function findAll(node: HNode, pred: (n: HNode) => boolean): HNode[] {
  const out: HNode[] = [];
  const walk = (x: HNode): void => {
    for (const c of x.children) {
      if (pred(c)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

// ───────────────────────── design tokens (from HTML :root) ─────────────────────────
type Palette = Record<string, string>;
function hex(v: string | undefined, fallback: string): string {
  if (!v) return fallback;
  let s = v.trim();
  if (/^[0-9a-fA-F]{6}$/.test(s)) s = '#' + s;
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s.toUpperCase() : fallback;
}
function extractTokens(root: HNode): Palette {
  const styles = findAll(root, (n) => n.tag === 'style')
    .map((n) => n.children[0]?.text ?? '')
    .join('\n');
  const m = /:root\s*\{([^}]*)\}/.exec(styles);
  const vars: Palette = {};
  if (m)
    for (const decl of m[1].split(';')) {
      const kv = decl.split(':');
      if (kv.length >= 2) vars[kv[0].trim()] = kv.slice(1).join(':').trim();
    }
  return vars;
}
const tok = (name: string): string => semanticToken('deck', name);
function palette(v: Palette) {
  return {
    bg: hex(v['--bg'], tok('deck.bg')),
    panel: hex(v['--panel'], tok('deck.panel')),
    ink: hex(v['--ink'], tok('deck.ink')),
    muted: hex(v['--muted'], tok('deck.muted')),
    line: hex(v['--line'], tok('deck.line')),
    navy: hex(v['--accent'], tok('deck.navy')),
    navy2: hex(v['--accent2'], tok('deck.navy2')),
    soft: hex(v['--soft'], tok('deck.soft')),
    crit: hex(v['--crit'], tok('status.crit')),
    critBg: hex(v['--crit-bg'], tok('status.crit.bg')),
    high: hex(v['--high'], tok('status.high')),
    highBg: hex(v['--high-bg'], tok('status.high.bg')),
    med: hex(v['--med'], tok('status.med')),
    medBg: hex(v['--med-bg'], tok('status.med.bg')),
    low: hex(v['--low'], tok('status.low')),
    lowBg: hex(v['--low-bg'], tok('status.low.bg')),
    good: hex(v['--good'], tok('status.good')),
    goodBg: hex(v['--good-bg'], tok('status.good.bg')),
    white: tok('deck.white'),
    navyInk: tok('deck.navyInk'),
    navyMute: tok('deck.navyMute'),
  };
}
type PaletteResolved = ReturnType<typeof palette>;

// ───────────────────────── deck model ─────────────────────────
interface Chip {
  kind: string;
  label: string;
}
interface Cell {
  text: string;
  chips: Chip[];
}
type Block =
  | { t: 'para'; text: string; small?: boolean }
  | { t: 'subhead'; text: string }
  | { t: 'grouptitle'; text: string }
  | { t: 'bullets'; items: string[] }
  | { t: 'callout'; variant: 'warn' | 'good' | 'info'; title?: string; lines: string[] }
  | { t: 'table'; header: string[]; rows: Cell[][] }
  | { t: 'kpis'; items: { big: string; lbl: string }[] };
interface Slide {
  title: string;
  blocks: Block[];
}
interface Deck {
  conf?: string;
  hero?: { kicker?: string; title: string; sub?: string; meta?: string };
  slides: Slide[];
}

const CHIP_RE = /\b[sc]-(crit|high|med|low|zero)\b/;
function chipKind(node: HNode): string | undefined {
  for (const c of node.classes) {
    const m = CHIP_RE.exec(c);
    if (m) return m[1];
  }
  return undefined;
}
function parseCell(td: HNode): Cell {
  const chips: Chip[] = [];
  for (const s of findAll(td, (n) => (n.tag === 'span' || n.tag === 'mark') && !!chipKind(n)))
    chips.push({ kind: chipKind(s) as string, label: normText(s) });
  return { text: normText(td), chips };
}
function calloutLines(node: HNode): { title?: string; lines: string[] } {
  const b = findFirst(node, (n) => n.tag === 'b' || n.tag === 'strong');
  const title = b ? normText(b) : undefined;
  const lines: string[] = [];
  const lis = findAll(node, (n) => n.tag === 'li');
  if (lis.length) {
    for (const li of lis) lines.push(normText(li));
  } else {
    let body = innerText(node).replace(/\r/g, '');
    if (title) body = body.replace(title, '');
    for (const ln of body.split('\n')) {
      const t = ln.replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
  }
  return { title, lines };
}
function buildDeck(root: HNode): Deck {
  const deck: Deck = { slides: [] };
  const confbar = findFirst(root, (n) => hasClass(n, 'confbar'));
  if (confbar) deck.conf = normText(confbar);
  const hero = findFirst(root, (n) => hasClass(n, 'hero'));
  if (hero) {
    const h1 = findFirst(hero, (n) => n.tag === 'h1');
    const sub = findFirst(hero, (n) => hasClass(n, 'sub'));
    const meta = findFirst(hero, (n) => hasClass(n, 'meta'));
    const kicker = findFirst(hero, (n) => hasClass(n, 'kicker'));
    deck.hero = {
      title: h1 ? normText(h1) : 'Untitled',
      sub: sub ? normText(sub) : undefined,
      meta: meta ? normText(meta) : undefined,
      kicker: kicker ? normText(kicker) : undefined,
    };
  }
  const wrap =
    findFirst(root, (n) => hasClass(n, 'wrap')) || findFirst(root, (n) => n.tag === 'body') || root;
  let cur: Slide | null = null;
  const push = (b: Block): void => {
    if (cur) cur.blocks.push(b);
  };
  const emptyNode: HNode = { tag: '', attrs: {}, classes: [], children: [] };
  const walk = (parent: HNode): void => {
    for (const el of parent.children) {
      if (el.tag === '') continue;
      if (el.tag === 'h2') {
        cur = { title: normText(el), blocks: [] };
        deck.slides.push(cur);
        continue;
      }
      if (!cur) continue;
      if (el.tag === 'h3') {
        push({ t: 'subhead', text: normText(el) });
        continue;
      }
      if (el.tag === 'p') {
        const txt = normText(el);
        if (txt) push({ t: 'para', text: txt, small: hasClass(el, 'legend') });
        continue;
      }
      if (hasClass(el, 'grpttl')) {
        push({ t: 'grouptitle', text: normText(el) });
        continue;
      }
      if (hasClass(el, 'callout')) {
        const variant: 'warn' | 'good' | 'info' = hasClass(el, 'warn')
          ? 'warn'
          : hasClass(el, 'good')
            ? 'good'
            : 'info';
        const { title, lines } = calloutLines(el);
        push({ t: 'callout', variant, title, lines });
        continue;
      }
      if (hasClass(el, 'kpis')) {
        const items = findAll(el, (n) => hasClass(n, 'kpi')).map((k) => ({
          big: normText(findFirst(k, (n) => hasClass(n, 'big')) || k),
          lbl: normText(findFirst(k, (n) => hasClass(n, 'lbl')) || emptyNode),
        }));
        push({ t: 'kpis', items });
        continue;
      }
      const table =
        el.tag === 'table'
          ? el
          : hasClass(el, 'tblwrap')
            ? findFirst(el, (n) => n.tag === 'table')
            : undefined;
      if (table) {
        const header = findAll(table, (n) => n.tag === 'th').map(normText);
        const rows: Cell[][] = [];
        for (const tr of findAll(table, (n) => n.tag === 'tr')) {
          const tds = tr.children.filter((c) => c.tag === 'td');
          if (tds.length) rows.push(tds.map(parseCell));
        }
        push({ t: 'table', header, rows });
        continue;
      }
      if (el.tag === 'ul') {
        const items = el.children
          .filter((c) => c.tag === 'li')
          .map(normText)
          .filter(Boolean);
        if (items.length) push({ t: 'bullets', items });
        continue;
      }
      if (el.tag === 'div' || el.tag === 'section') walk(el);
    }
  };
  walk(wrap);
  return deck;
}

// ───────────────────────── layout → PptxDesignProtocol ─────────────────────────
const FONT = 'Yu Gothic';
/** 既定は 16:9（13.333in × 7.5in）。4:3 の既存デッキへ差し込む場合は 10 × 7.5 を渡す。 */
export const DECK_CANVAS_16_9 = { w: 13.333, h: 7.5 } as const;
export const DECK_CANVAS_4_3 = { w: 10, h: 7.5 } as const;
const M = 0.6;
type El = Record<string, unknown>;

function charsPerLine(w: number, fs: number): number {
  return Math.max(6, Math.floor((w * 72) / (fs * 1.35)));
}
function estLines(text: string, w: number, fs: number): number {
  const cpl = charsPerLine(w, fs);
  return text.split('\n').reduce((a, s) => a + Math.max(1, Math.ceil(s.length / cpl)), 0);
}
function hardWrap(text: string, w: number, fs: number): string {
  const cpl = charsPerLine(w, fs);
  const out: string[] = [];
  for (const seg of text.split('\n')) {
    let s = seg;
    while (s.length > cpl) {
      let cut = cpl;
      const sp = s.lastIndexOf(' ', cpl);
      if (sp >= cpl * 0.6) cut = sp;
      out.push(s.slice(0, cut).replace(/\s+$/, ''));
      s = s.slice(cut).replace(/^\s+/, '');
    }
    out.push(s);
  }
  return out.join('\n');
}

/**
 * スライド1枚ぶんの収まりを実測する（deck_from_html 経路の layoutFit）。
 *
 * この経路は charsPerLine による推定＋hardWrap の一発勝負で、実測へのフィードバックが
 * 無かった。結果として枠外へ出たチップ・折返しで潰れた表セルが、生成時に検出されず
 * pptx_layout_preflight も常に pass を返していた（layoutFit を誰も書いていなかったため）。
 * ここで幾何を突き合わせ、preflight が読む形に落とす。
 */
function measureSlideFit(
  elements: Array<Record<string, unknown>>,
  W: number,
  H: number
): {
  status: 'pass' | 'shrunk' | 'overflow';
  shrinkCount: number;
  overflowCount: number;
  shrunkZones: Array<{ zone: string; fontSize: number; designedFontSize: number }>;
  overflows: Array<{ zone: string; fillRatio: number; overflowAtParagraph?: number }>;
} {
  const EPS = 0.02; // in。丸め誤差でのフラグ乱発を避ける
  const overflows: Array<{ zone: string; fillRatio: number; overflowAtParagraph?: number }> = [];
  const shrunkZones: Array<{ zone: string; fontSize: number; designedFontSize: number }> = [];

  elements.forEach((el, i) => {
    const pos = (el as { pos?: { x: number; y: number; w: number; h: number } }).pos;
    if (!pos) return;
    const style = ((el as { style?: Record<string, unknown> }).style ?? {}) as Record<
      string,
      unknown
    >;
    const kind = String((el as { type?: string }).type ?? 'el');
    const zone = `${kind}#${i}`;

    // 枠外（右／下）。チップが右へ突き抜ける事故はここで捕まる
    const right = pos.x + pos.w;
    const bottom = pos.y + pos.h;
    if (right > W + EPS)
      overflows.push({ zone: `${zone}:right`, fillRatio: Number((right / W).toFixed(3)) });
    if (bottom > H + EPS)
      overflows.push({ zone: `${zone}:bottom`, fillRatio: Number((bottom / H).toFixed(3)) });

    // テキストが自分の箱に収まるか（推定行数 × 行高 vs 箱の高さ）
    const raw = String((el as { text?: string }).text ?? '');
    if (kind === 'text' && raw.trim() && pos.h > 0) {
      const fs = Number(style.fontSize ?? 12);
      const lines = estLines(raw, pos.w, fs);
      const needed = (lines * fs * 1.25) / 72; // pt → in
      const ratio = needed / pos.h;
      if (ratio > 1 + 0.08) {
        const over = raw.split('\n').findIndex((_, n) => ((n + 1) * fs * 1.25) / 72 > pos.h);
        overflows.push({
          zone: `${zone}:text`,
          fillRatio: Number(ratio.toFixed(3)),
          ...(over >= 0 ? { overflowAtParagraph: over } : {}),
        });
      } else if (ratio > 1) {
        shrunkZones.push({ zone: `${zone}:text`, fontSize: fs, designedFontSize: fs });
      }
    }
  });

  return {
    status: overflows.length > 0 ? 'overflow' : shrunkZones.length > 0 ? 'shrunk' : 'pass',
    shrinkCount: shrunkZones.length,
    overflowCount: overflows.length,
    shrunkZones,
    overflows,
  };
}

function layout(deck: Deck, C: PaletteResolved, W: number, H: number) {
  const SEV: Record<string, [string, string]> = {
    crit: [C.crit, C.critBg],
    high: [C.high, C.highBg],
    med: [C.med, C.medBg],
    low: [C.low, C.lowBg],
    zero: [C.muted, C.soft],
    good: [C.good, C.goodBg],
  };
  const slidesOut: unknown[] = [];
  const text = (x: number, y: number, w: number, h: number, t: string, style: El = {}): El => ({
    type: 'text',
    pos: { x, y, w, h },
    text: t,
    style: { fontFamily: FONT, ...style },
  });
  const rect = (x: number, y: number, w: number, h: number, fill: string, extra: El = {}): El => ({
    type: 'shape',
    shapeType: 'rect',
    pos: { x, y, w, h },
    text: '',
    style: { fill, ...extra },
  });
  const rrect = (x: number, y: number, w: number, h: number, fill: string, extra: El = {}): El => ({
    type: 'shape',
    shapeType: 'roundRect',
    pos: { x, y, w, h },
    text: '',
    style: { fill, cornerRadius: 0.08, ...extra },
  });
  const line = (x: number, y: number, w: number, col: string, lw = 3): El => ({
    type: 'line',
    pos: { x, y, w, h: 0 },
    style: { line: col, lineWidth: lw },
  });

  const confText = deck.conf || '社外秘 / CONFIDENTIAL';
  const chrome = (e: El[], title: string): void => {
    e.push(rect(0, 0, W, 0.32, C.crit));
    e.push(
      text(0, 0.02, W, 0.28, confText, {
        fontSize: 10.5,
        bold: true,
        color: C.white,
        align: 'center',
        valign: 'middle',
      })
    );
    e.push(
      text(M, 0.55, W - 2 * M, 0.62, title, {
        fontSize: 23,
        bold: true,
        color: C.navy,
        valign: 'top',
      })
    );
    e.push(line(M, 1.28, 3.2, C.navy2, 3.5));
  };
  const chipEls = (e: El[], x: number, y: number, label: string, kind: string): number => {
    const [fg, bg] = SEV[kind] || [C.muted, C.soft];
    const w = Math.max(0.5, 0.26 + label.length * 0.135);
    if (kind === 'zero') e.push(rrect(x, y, w, 0.32, C.panel, { line: C.line, lineWidth: 1 }));
    else e.push(rrect(x, y, w, 0.32, bg));
    e.push(
      text(x, y - 0.02, w, 0.36, label, {
        fontSize: 11.5,
        bold: true,
        color: fg,
        align: 'center',
        valign: 'middle',
      })
    );
    return w;
  };
  const calloutEls = (
    e: El[],
    x: number,
    y: number,
    w: number,
    h: number,
    variant: string,
    title: string | undefined,
    lines: string[]
  ): void => {
    const map: Record<string, [string, string]> = {
      warn: [C.crit, C.critBg],
      good: [C.good, C.goodBg],
      info: [C.navy2, C.soft],
    };
    const [ac, bg] = map[variant] || map.info;
    e.push(rrect(x, y, w, h, bg));
    e.push(rect(x, y, 0.07, h, ac));
    const iw = w - 0.5;
    let cy = y + 0.18;
    if (title) {
      const wt = hardWrap(title, iw, 14);
      const th = wt.split('\n').length * 0.32;
      e.push(
        text(x + 0.25, cy, iw, th, wt, { fontSize: 14, bold: true, color: ac, valign: 'top' })
      );
      cy += th + 0.14;
    }
    if (lines.length)
      e.push(
        text(
          x + 0.25,
          cy,
          iw,
          h - (cy - y) - 0.12,
          lines.map((l) => hardWrap(BULLET_PREFIX + l, iw, 12.5)).join('\n'),
          { fontSize: 12.5, color: C.ink, lineSpacing: 1.2, valign: 'top' }
        )
      );
  };

  if (deck.hero) {
    const e: El[] = [];
    e.push(rect(0, 0, W, H, C.navy));
    e.push(rect(0, 0, W, 0.16, C.navy2));
    if (deck.hero.kicker)
      e.push(
        text(M, 1.5, W - 2 * M, 0.4, deck.hero.kicker, {
          fontSize: 15,
          bold: true,
          color: C.navyInk,
        })
      );
    e.push(
      text(M, 2.1, W - 2 * M, 1.5, hardWrap(deck.hero.title, W - 2 * M, 34), {
        fontSize: 34,
        bold: true,
        color: C.white,
        valign: 'top',
      })
    );
    e.push(line(M, 3.75, 5.0, C.navy2, 3.5));
    if (deck.hero.sub)
      e.push(
        text(M, 4.0, W - 2 * M, 1.1, hardWrap(deck.hero.sub, W - 2 * M, 15), {
          fontSize: 15,
          color: C.navyMute,
          lineSpacing: 1.3,
        })
      );
    e.push(rrect(M, 6.05, 2.9, 0.42, C.crit));
    e.push(
      text(M, 6.04, 2.9, 0.44, confText.split('—')[0].trim(), {
        fontSize: 12,
        bold: true,
        color: C.white,
        align: 'center',
        valign: 'middle',
      })
    );
    if (deck.hero.meta)
      e.push(
        text(M + 3.1, 6.05, W - 2 * M - 3.1, 0.42, deck.hero.meta, {
          fontSize: 12.5,
          color: C.navyMute,
          valign: 'middle',
        })
      );
    slidesOut.push({ id: `slide${slidesOut.length + 1}.xml`, backgroundFill: C.navy, elements: e });
  }

  const START_Y = 1.55,
    BOTTOM = H - 0.35;
  for (const s of deck.slides) {
    let e: El[] = [];
    chrome(e, s.title);
    let y = START_Y;
    const flush = (cont: boolean): void => {
      slidesOut.push({
        id: `slide${slidesOut.length + 1}.xml`,
        backgroundFill: C.bg,
        elements: e,
        metadata: { layoutFit: measureSlideFit(e as Array<Record<string, unknown>>, W, H) },
      });
      e = [];
      chrome(e, s.title + (cont ? '…' : ''));
      y = START_Y;
    };
    const ensure = (need: number): void => {
      if (y + need > BOTTOM && y > START_Y) flush(true);
    };

    for (const b of s.blocks) {
      if (b.t === 'subhead') {
        ensure(0.5);
        e.push(text(M, y, W - 2 * M, 0.4, b.text, { fontSize: 15.5, bold: true, color: C.navy2 }));
        y += 0.5;
      } else if (b.t === 'grouptitle') {
        ensure(0.45);
        e.push(text(M, y, W - 2 * M, 0.38, b.text, { fontSize: 14.5, bold: true, color: C.navy }));
        e.push(line(M, y + 0.4, 2.2, C.line, 2));
        y += 0.55;
      } else if (b.t === 'para') {
        const fs = b.small ? 11.5 : 13.5;
        const wt = hardWrap(b.text, W - 2 * M, fs);
        const h = wt.split('\n').length * 0.32 + 0.06;
        ensure(h);
        e.push(
          text(M, y, W - 2 * M, h, wt, {
            fontSize: fs,
            color: b.small ? C.muted : C.ink,
            lineSpacing: 1.2,
            valign: 'top',
          })
        );
        y += h + 0.14;
      } else if (b.t === 'bullets') {
        const iw = W - 2 * M - 0.2;
        const wrapped = b.items.map((i) => hardWrap(BULLET_PREFIX + i, iw, 13.5));
        const h = wrapped.reduce((a, w) => a + w.split('\n').length * 0.34, 0) + 0.08;
        ensure(Math.min(h, 1.2));
        e.push(
          text(M + 0.05, y, iw, h, wrapped.join('\n'), {
            fontSize: 13.5,
            color: C.ink,
            lineSpacing: 1.25,
            valign: 'top',
          })
        );
        y += h + 0.12;
      } else if (b.t === 'kpis') {
        ensure(1.35);
        const n = Math.max(1, b.items.length);
        const gap = 0.25;
        const cw = (W - 2 * M - gap * (n - 1)) / n;
        let x = M;
        for (const k of b.items) {
          e.push(rrect(x, y, cw, 1.2, C.panel, { line: C.line, lineWidth: 1 }));
          e.push(
            text(x, y + 0.15, cw, 0.6, k.big, {
              fontSize: 26,
              bold: true,
              color: C.navy2,
              align: 'center',
            })
          );
          e.push(
            text(x + 0.1, y + 0.78, cw - 0.2, 0.4, k.lbl, {
              fontSize: 11.5,
              color: C.muted,
              align: 'center',
            })
          );
          x += cw + gap;
        }
        y += 1.4;
      } else if (b.t === 'callout') {
        const iw = W - 2 * M - 0.45;
        const linesH = b.lines.reduce(
          (a, l) => a + estLines(BULLET_PREFIX + l, iw, 12.5) * 0.32,
          0
        );
        const h = (b.title ? estLines(b.title, iw, 14) * 0.34 + 0.16 : 0.1) + linesH + 0.3;
        ensure(Math.min(h, 3));
        calloutEls(e, M, y, W - 2 * M, h, b.variant, b.title, b.lines);
        y += h + 0.15;
      } else if (b.t === 'table') {
        const ncol = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
        const w0 = ncol > 1 ? Math.min(4.6, (W - 2 * M) * 0.34) : W - 2 * M;
        const rest = (W - 2 * M - w0) / Math.max(1, ncol - 1);
        const colX = (i: number): number => M + (i === 0 ? 0 : w0 + rest * (i - 1));
        const colW = (i: number): number => (i === 0 ? w0 : rest);
        const CFS = 11;
        const rowHeight = (cells: (Cell | string)[], pad = 0.2): number => {
          let mx = 0.5;
          for (let i = 0; i < ncol; i++) {
            const cell = cells[i];
            if (typeof cell === 'string') {
              if (cell) mx = Math.max(mx, estLines(cell, colW(i) - 0.2, 12.5) * 0.26 + pad);
            } else if (cell && cell.chips.length) mx = Math.max(mx, 0.5);
            else if (cell) mx = Math.max(mx, estLines(cell.text, colW(i) - 0.24, CFS) * 0.24 + pad);
          }
          return mx;
        };
        const hh = b.header.length ? rowHeight(b.header, 0.18) : 0;
        const drawHeader = (): void => {
          if (!b.header.length) return;
          for (let i = 0; i < ncol; i++) {
            e.push(rect(colX(i), y, colW(i), hh, C.navy));
            e.push(
              text(
                colX(i) + (i === 0 ? 0.12 : 0.03),
                y,
                colW(i) - (i === 0 ? 0.12 : 0.06),
                hh,
                hardWrap(b.header[i] || '', colW(i) - 0.1, 12),
                {
                  fontSize: 12,
                  bold: true,
                  color: C.white,
                  align: i === 0 ? 'left' : 'center',
                  valign: 'middle',
                  lineSpacing: 1.05,
                }
              )
            );
          }
          y += hh;
        };
        ensure(hh + 0.6);
        drawHeader();
        for (const row of b.rows) {
          const rh = rowHeight(row);
          if (y + rh > BOTTOM && y > START_Y) {
            flush(true);
            drawHeader();
          }
          for (let i = 0; i < ncol; i++) {
            const cell = row[i];
            e.push(rect(colX(i), y, colW(i), rh, C.panel, { line: C.line, lineWidth: 1 }));
            if (cell && cell.chips.length) {
              let cx = colX(i) + 0.12;
              for (const ch of cell.chips)
                cx += chipEls(e, cx, y + rh / 2 - 0.16, ch.label, ch.kind) + 0.08;
            } else if (cell)
              e.push(
                text(
                  colX(i) + (i === 0 ? 0.12 : 0.05),
                  y,
                  colW(i) - (i === 0 ? 0.16 : 0.1),
                  rh,
                  hardWrap(cell.text, colW(i) - (i === 0 ? 0.2 : 0.14), CFS),
                  {
                    fontSize: CFS,
                    color: C.ink,
                    align: i === 0 ? 'left' : 'center',
                    valign: 'middle',
                    lineSpacing: 1.1,
                  }
                )
              );
          }
          y += rh;
        }
        y += 0.2;
      }
    }
    e.push(
      text(M, H - 0.34, W - 2 * M, 0.26, '分類 Confidential', { fontSize: 9.5, color: C.muted })
    );
    slidesOut.push({
      id: `slide${slidesOut.length + 1}.xml`,
      backgroundFill: C.bg,
      elements: e,
      metadata: { layoutFit: measureSlideFit(e as Array<Record<string, unknown>>, W, H) },
    });
  }

  // デッキ全体の診断。pptx_layout_preflight が protocol.metadata.layoutDiagnostics を読む
  const overflowSlides: Array<{
    slideIndex: number;
    slideId: string | undefined;
    overflows: unknown[];
  }> = slidesOut.flatMap((s, i) => {
    const fit = (s as { metadata?: { layoutFit?: { overflows?: unknown[] } } }).metadata?.layoutFit;
    return fit?.overflows?.length
      ? [{ slideIndex: i + 1, slideId: (s as { id?: string }).id, overflows: fit.overflows }]
      : [];
  });
  // `slidesOut` is unknown[]: reduce then resolves to its unknown-accumulator
  // overload (methods are bivariant, so annotating the callback parameter is
  // not enough) and the tallies come back as unknown. The explicit type
  // argument selects the numeric overload.
  const shrinkCount = slidesOut.reduce<number>(
    (n, s) =>
      n +
      Number(
        (s as { metadata?: { layoutFit?: { shrinkCount?: number } } }).metadata?.layoutFit
          ?.shrinkCount ?? 0
      ),
    0
  );
  const overflowCount = overflowSlides.reduce<number>((n, s) => n + s.overflows.length, 0);

  return {
    version: '3.0.0',
    canvas: { w: W, h: H },
    designDefaults: { fontFamily: FONT },
    theme: {
      dk1: '0F1F33',
      lt1: 'FFFFFF',
      dk2: '1E3A5F',
      lt2: 'F3F4F6',
      accent1: C.navy2.slice(1),
      accent2: C.good.slice(1),
      accent3: C.med.slice(1),
      accent4: C.high.slice(1),
      accent5: C.crit.slice(1),
      accent6: C.muted.slice(1),
      hlink: C.navy2.slice(1),
      folHlink: '8B5CF6',
    },
    master: { elements: [] },
    slides: slidesOut,
    metadata: {
      source: 'deck_from_html',
      slideCount: slidesOut.length,
      layoutDiagnostics: {
        status: overflowCount > 0 ? 'overflow' : shrinkCount > 0 ? 'shrunk' : 'pass',
        measurementModel: 'deterministic-width-table',
        slideCount: slidesOut.length,
        shrinkCount,
        overflowCount,
        overflowSlides,
      },
    },
  };
}

/** Convert report HTML into an editable PptxDesignProtocol (pure). */
export function htmlToDeckProtocol(
  html: string,
  canvas?: { w?: number; h?: number }
): {
  protocol: ReturnType<typeof layout>;
  slideCount: number;
} {
  if (typeof html !== 'string' || !html.trim()) throw new Error('deck_from_html: empty HTML input');
  if (html.length > MAX_HTML_DECK_INPUT_CHARS) {
    throw new Error(`deck_from_html: HTML input exceeds ${MAX_HTML_DECK_INPUT_CHARS} characters`);
  }
  const root = parseHtml(html);
  const w = Number(canvas?.w) > 0 ? Number(canvas?.w) : DECK_CANVAS_16_9.w;
  const h = Number(canvas?.h) > 0 ? Number(canvas?.h) : DECK_CANVAS_16_9.h;
  const protocol = layout(buildDeck(root), palette(extractTokens(root)), w, h);
  return { protocol, slideCount: protocol.slides.length };
}
