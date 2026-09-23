/*
 * Kyberion UI — `ui:talking-avatar` (PA-09, PADS_A2UI_AND_AVATAR_PLAN_2026-09-23
 * §6) for the vanilla renderer, plus the view helpers and the DOM
 * controller the React renderer (`src/avatar/*`) shares.
 *
 * Markup (both renderers, parity-tested):
 *   div.kb-talking-avatar[data-name][data-size][data-shape][data-expression]
 *       [data-state][data-mouth-mode]            style: --kb-mouth-x/y/width/open
 *     div.kb-talking-avatar__figure[role=img][aria-label]
 *       span.kb-talking-avatar__initials         (shows when no image loads)
 *       img.kb-talking-avatar__image[data-expression][data-active]  × expressions
 *       img.kb-talking-avatar__blink             (optional eyes-closed frame)
 *       img.kb-talking-avatar__mouth-frame       (`frames` mode)
 *       svg.kb-talking-avatar__mouth             (`overlay` mode)
 *     div.kb-voice-state …                       (`show_state`, voice.js markup)
 *
 * Runtime contract:
 *   - Mouth openness is the `--kb-mouth-open` custom property (0..1) on the
 *     root, written by the lip-sync engine (`lipsync.js`) every frame — never
 *     a re-render. `renderA2UI` replaces the whole container, so hosts drive
 *     the avatar through the controller handed out in
 *     `avatar.ready { name, controller }`.
 *   - Image URLs are http(s) / same-origin only (`data:`, `blob:`, other
 *     schemes are dropped). Images are decorative inside `role=img`.
 *   - Under `prefers-reduced-motion` the mouth still moves (damped) while the
 *     CSS drops breathing, blinking and crossfades.
 */
import { createLipsync } from './lipsync.js';
import { KB_VOICE_STATE_LABEL_KEYS, voiceStateView } from './voice.js';

export {
  KB_LIPSYNC_DEFAULTS,
  KB_VISEME_OPENNESS,
  KB_AZURE_VISEME_CANONICAL,
  clamp01,
  createLipsync,
  createSyntheticEnvelope,
  cueFromLevel,
  seededRandom,
  smoothToward,
  timeDomainRms,
  visemeOpenness,
} from './lipsync.js';

/** Mirrors `KB_AVATAR_ACTIONS` in libs/core/a2ui-catalog.ts (pinned by tests). */
export const KB_AVATAR_ACTIONS = Object.freeze({ ready: 'avatar.ready' });

export const KB_AVATAR_EXPRESSIONS = Object.freeze(['neutral', 'joy', 'thinking', 'listening']);
export const KB_AVATAR_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);
export const KB_AVATAR_MOUTH_MODES = Object.freeze(['auto', 'overlay', 'frames']);
/** Mouth anchor (fractions of the image box) when `mouth` is not given. */
export const KB_AVATAR_DEFAULT_MOUTH = Object.freeze({ x: 0.5, y: 0.68, width: 0.22 });

export const KB_AVATAR_MESSAGE_KEYS = Object.freeze({
  labelState: 'ui:talking_avatar_label_state',
});

const SVG_NS = 'http://www.w3.org/2000/svg';
const STATES = Object.keys(KB_VOICE_STATE_LABEL_KEYS);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\s]/;

/** Overlay mouth geometry (viewBox 0 0 100 60): lips, cavity, tongue. */
export const KB_AVATAR_MOUTH_SHAPES = Object.freeze([
  { part: 'lips', cx: '50', cy: '30', rx: '48', ry: '28' },
  { part: 'cavity', cx: '50', cy: '30', rx: '40', ry: '21' },
  { part: 'tongue', cx: '50', cy: '43', rx: '22', ry: '9' },
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An image URL safe for `<img src>` from props: same-origin paths or
 * absolute http(s). `data:`, `blob:`, `javascript:`, protocol-relative
 * `//host` and anything with whitespace / control characters → null.
 */
export function avatarImageUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > 2048 || CONTROL.test(url)) return null;
  if (url.startsWith('//') || url.startsWith('\\') || url.startsWith('/\\')) return null;
  const scheme = SCHEME.exec(url);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    return name === 'http' || name === 'https' ? url : null;
  }
  return url;
}

function fraction(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(min, n));
}

/** Initials for the no-image fallback: `fallback_initials`, else from `label`. */
export function avatarInitials(p) {
  if (typeof p.fallback_initials === 'string' && p.fallback_initials.trim()) {
    return p.fallback_initials.trim().slice(0, 3);
  }
  const words = String(p.label ?? p.name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = words.map((word) => Array.from(word)[0] || '');
  // A second initial only from a Latin / digit word (a CJK second word adds none).
  const second = first[1] && /[A-Za-z0-9]/.test(first[1]) ? first[1] : '';
  return `${first[0] || ''}${second}`.toUpperCase();
}

/**
 * The expression shown: an explicit `expression` (when its image exists),
 * else `listening` / `thinking` follow `state` (when that image exists),
 * else `neutral`.
 */
export function displayedExpression(explicit, state, available) {
  const has = (name) => available.includes(name);
  if (explicit && KB_AVATAR_EXPRESSIONS.includes(explicit))
    return has(explicit) ? explicit : 'neutral';
  if ((state === 'listening' || state === 'thinking') && has(state)) return state;
  return 'neutral';
}

/** Accessible name: the label, plus the localized state when `state` is set. */
export function avatarAriaLabel(label, state, t) {
  if (!state) return label;
  return t(KB_AVATAR_MESSAGE_KEYS.labelState, {
    label,
    state: t(KB_VOICE_STATE_LABEL_KEYS[state]),
  });
}

/**
 * Everything both renderers need for `ui:talking-avatar`:
 * `{ name, label, ariaLabel, explicit, expression, state, showState, mouth,
 *    mouthMode, size, shape, initials, images: [{ key, url }], blink, mouthFrame }`.
 */
export function talkingAvatarView(p, t) {
  const given = isRecord(p.images) ? p.images : {};
  const images = [];
  for (const key of KB_AVATAR_EXPRESSIONS) {
    const url = avatarImageUrl(given[key]);
    if (url) images.push({ key, url });
  }
  const available = images.map((image) => image.key);
  const openFrame = avatarImageUrl(given.mouth_open) || avatarImageUrl(given.speaking);
  const requested = KB_AVATAR_MOUTH_MODES.includes(p.mouth_mode) ? p.mouth_mode : 'auto';
  const mouthMode = requested === 'overlay' || !openFrame ? 'overlay' : 'frames';
  const state = STATES.includes(p.state) ? p.state : null;
  const explicit = KB_AVATAR_EXPRESSIONS.includes(p.expression) ? p.expression : null;
  const mouth = isRecord(p.mouth) ? p.mouth : {};
  const D = KB_AVATAR_DEFAULT_MOUTH;
  const label = typeof p.label === 'string' ? p.label : '';
  return {
    name: typeof p.name === 'string' ? p.name : '',
    label,
    ariaLabel: avatarAriaLabel(label, state, t),
    explicit,
    expression: displayedExpression(explicit, state, available),
    state,
    showState: p.show_state === true,
    mouth: {
      x: fraction(mouth.x, D.x, 0),
      y: fraction(mouth.y, D.y, 0),
      width: fraction(mouth.width, D.width, 0.02),
    },
    mouthMode,
    size: KB_AVATAR_SIZES.includes(p.size) ? p.size : 'md',
    shape: p.shape === 'rounded' ? 'rounded' : 'circle',
    initials: avatarInitials(p),
    images,
    blink: avatarImageUrl(given.blink),
    mouthFrame: mouthMode === 'frames' ? openFrame : null,
  };
}

/** The root's custom properties (mouth anchor + closed mouth). */
export function avatarStyleVars(view) {
  return {
    '--kb-mouth-x': String(view.mouth.x),
    '--kb-mouth-y': String(view.mouth.y),
    '--kb-mouth-width': String(view.mouth.width),
    '--kb-mouth-open': '0',
  };
}

/** The `ui:voice-state` props of the `show_state` indicator. */
export function avatarStateProps(state) {
  return { state: state || 'idle', variant: 'dot', size: 'sm' };
}

/** `(prefers-reduced-motion: reduce)` on `win` (false when unknown). */
export function prefersReducedMotion(win) {
  try {
    return Boolean(
      win &&
      typeof win.matchMedia === 'function' &&
      win.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

function hasClass(node, name) {
  return (
    node &&
    typeof node.getAttribute === 'function' &&
    String(node.getAttribute('class') || node.className || '')
      .split(/\s+/)
      .includes(name)
  );
}

function walk(node, visit) {
  for (const child of Array.from(node.children || node.childNodes || [])) {
    if (!child || child.nodeType !== 1) continue;
    visit(child);
    walk(child, visit);
  }
}

/** Find the controller's DOM parts under a `.kb-talking-avatar` root. */
export function avatarParts(root) {
  const parts = { figure: null, images: [], stateRoot: null, stateLabel: null };
  walk(root, (node) => {
    if (hasClass(node, 'kb-talking-avatar__figure')) parts.figure = node;
    else if (hasClass(node, 'kb-talking-avatar__image')) parts.images.push(node);
    else if (hasClass(node, 'kb-voice-state')) parts.stateRoot = node;
    else if (hasClass(node, 'kb-voice-state__label')) parts.stateLabel = node;
  });
  return parts;
}

/** Write `--kb-mouth-open` (3 decimals) on the root. */
export function setMouthOpen(root, openness) {
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
  root.style.setProperty('--kb-mouth-open', String(Math.round(openness * 1000) / 1000));
}

/**
 * The runtime controller over a rendered `.kb-talking-avatar` root (both
 * renderers). Updates the DOM in place; `dispose` cancels the frame loop and
 * stops reading any analyser (the caller's audio graph is left untouched).
 * @param {{
 *   root: any,
 *   label: string,
 *   explicit?: string | null,
 *   t: (key: string, params?: Record<string, unknown>) => string,
 *   win?: any,
 *   now?: () => number,
 *   raf?: (cb: (t: number) => void) => unknown,
 *   caf?: (handle: unknown) => void,
 *   reducedMotion?: boolean,
 * }} options
 */
export function createAvatarController(options) {
  const { root } = options;
  const parts = avatarParts(root);
  const available = parts.images.map((node) => node.getAttribute('data-expression'));
  let explicit = options.explicit || null;
  let disposed = false;
  const currentState = () => {
    const value = root.getAttribute('data-state');
    return STATES.includes(value) ? value : null;
  };

  const showExpression = () => {
    const shown = displayedExpression(explicit, currentState(), available);
    root.setAttribute('data-expression', shown);
    for (const node of parts.images) {
      node.setAttribute(
        'data-active',
        node.getAttribute('data-expression') === shown ? 'true' : 'false'
      );
    }
  };

  const engine = createLipsync({
    onMouth: (openness) => setMouthOpen(root, openness),
    onExpression: (name) => controller.setExpression(name),
    now:
      options.now ||
      (options.win && options.win.performance && typeof options.win.performance.now === 'function'
        ? () => options.win.performance.now()
        : undefined),
    raf:
      options.raf ||
      (options.win && typeof options.win.requestAnimationFrame === 'function'
        ? (cb) => options.win.requestAnimationFrame(cb)
        : undefined),
    caf:
      options.caf ||
      (options.win && typeof options.win.cancelAnimationFrame === 'function'
        ? (h) => options.win.cancelAnimationFrame(h)
        : undefined),
    reducedMotion:
      options.reducedMotion === undefined
        ? prefersReducedMotion(options.win)
        : options.reducedMotion,
    avatarId: root.getAttribute('data-name') || undefined,
  });

  const controller = {
    setLevel: (level) => engine.setLevel(level),
    applyCue: (cue) => engine.applyCue(cue),
    attachAnalyser: (node) => engine.attachAnalyser(node),
    detachAnalyser: () => engine.detachAnalyser(),
    startSynthetic: (opts) => engine.startSynthetic(opts),
    stopSynthetic: () => engine.stopSynthetic(),
    pulse: () => engine.pulse(),
    /** `neutral` | `joy` | `thinking` | `listening`; null follows `state`. Unknown → false. */
    setExpression(name) {
      if (disposed) return false;
      if (name !== null && !KB_AVATAR_EXPRESSIONS.includes(name)) return false;
      explicit = name;
      showExpression();
      return true;
    },
    /** A `ui:voice-state` state, or null to clear it. Unknown → false. */
    setState(state) {
      if (disposed) return false;
      if (state !== null && !STATES.includes(state)) return false;
      if (state) root.setAttribute('data-state', state);
      else root.removeAttribute('data-state');
      if (parts.figure) {
        parts.figure.setAttribute('aria-label', avatarAriaLabel(options.label, state, options.t));
      }
      if (parts.stateRoot) {
        const view = voiceStateView(avatarStateProps(state), options.t);
        parts.stateRoot.setAttribute('data-state', view.state);
        if (parts.stateLabel) parts.stateLabel.textContent = view.label;
      }
      showExpression();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      engine.dispose();
    },
  };
  return controller;
}

// ---------------------------------------------------------------------------
// Vanilla DOM renderer
// ---------------------------------------------------------------------------

/**
 * @param {{ el: Function, setData: Function, voiceState: (ctx: any, p: any) => any }} h
 *   `voiceState` = the `ui:voice-state` renderer (same markup contract).
 */
export function createAvatarRenderers(h) {
  const { el, setData } = h;

  const img = (ctx, className, url) => {
    const node = el(ctx, 'img', className);
    node.setAttribute('src', url);
    node.setAttribute('alt', '');
    node.setAttribute('draggable', 'false');
    node.addEventListener('error', () => node.setAttribute('data-failed', 'true'));
    return node;
  };

  const mouthSvg = (ctx) => {
    const svg = ctx.doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'kb-talking-avatar__mouth');
    svg.setAttribute('viewBox', '0 0 100 60');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const shape of KB_AVATAR_MOUTH_SHAPES) {
      const node = ctx.doc.createElementNS(SVG_NS, 'ellipse');
      node.setAttribute('class', `kb-talking-avatar__mouth-${shape.part}`);
      for (const attr of ['cx', 'cy', 'rx', 'ry']) node.setAttribute(attr, shape[attr]);
      svg.appendChild(node);
    }
    return svg;
  };

  const talkingAvatar = (ctx, p, c) => {
    const view = talkingAvatarView(p, ctx.t);
    const root = el(ctx, 'div', 'kb-talking-avatar');
    setData(root, 'name', view.name);
    setData(root, 'size', view.size);
    setData(root, 'shape', view.shape);
    setData(root, 'expression', view.expression);
    setData(root, 'state', view.state);
    setData(root, 'mouth-mode', view.mouthMode);
    if (root.style && typeof root.style.setProperty === 'function') {
      for (const [name, value] of Object.entries(avatarStyleVars(view))) {
        root.style.setProperty(name, value);
      }
    }

    const figure = el(ctx, 'div', 'kb-talking-avatar__figure');
    figure.setAttribute('role', 'img');
    figure.setAttribute('aria-label', view.ariaLabel);
    const initials = el(ctx, 'span', 'kb-talking-avatar__initials', view.initials);
    initials.setAttribute('aria-hidden', 'true');
    figure.appendChild(initials);
    for (const image of view.images) {
      const node = img(ctx, 'kb-talking-avatar__image', image.url);
      setData(node, 'expression', image.key);
      setData(node, 'active', image.key === view.expression ? 'true' : 'false');
      figure.appendChild(node);
    }
    if (view.blink) figure.appendChild(img(ctx, 'kb-talking-avatar__blink', view.blink));
    if (view.mouthFrame) {
      figure.appendChild(img(ctx, 'kb-talking-avatar__mouth-frame', view.mouthFrame));
    } else {
      figure.appendChild(mouthSvg(ctx));
    }
    root.appendChild(figure);
    if (view.showState) root.appendChild(h.voiceState(ctx, avatarStateProps(view.state)));

    const controller = createAvatarController({
      root,
      label: view.label,
      explicit: view.explicit,
      t: ctx.t,
      win: ctx.win,
    });
    let disposed = false;
    Promise.resolve().then(() => {
      if (disposed || typeof ctx.onAction !== 'function') return;
      ctx.onAction({ id: KB_AVATAR_ACTIONS.ready, payload: { name: view.name, controller } }, c);
    });
    if (Array.isArray(ctx.cleanups)) {
      ctx.cleanups.push(() => {
        disposed = true;
        controller.dispose();
      });
    }
    return root;
  };

  return {
    'ui:talking-avatar'(ctx, p, c) {
      return talkingAvatar(ctx, p, c);
    },
  };
}
