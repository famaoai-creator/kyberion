/*
 * partner-avatar.js — PA-09: the 相棒 (partner) talking avatar for the
 * presence-studio pages (`/work`, `/ask`).
 *
 * ES module. Renders one `ui:talking-avatar` through the shared vanilla kit
 * (`/shared-ui/kyberion-ui.js`) into its own container ONCE, then drives it
 * only through the controller handed out in `avatar.ready` — state and
 * expression changes never re-render (the kit's contract: `renderA2UI`
 * replaces the whole container).
 *
 * Images: the user's adopted personal set (`GET /api/me/avatar`, owner
 * session only — any other viewer gets 403 and falls back) when
 * `avatar.adopted`, else the agent profile's expression map (the product
 * SVGs under `/assets/avatars/`).
 *
 * Mouth, per path (`/shared-ui/speech-player.js`):
 *   - `speak(text)`   the page speaks: voice-hub audio via
 *                     `POST /api/voice/synthesize` played in the browser
 *                     (AnalyserNode lip-sync), falling back to
 *                     `speechSynthesis` (synthetic mouth + boundary pulses).
 *   - `followHost()`  voice-hub speaks on the host speakers (the `/work`
 *                     conversation loop): synthetic motion while SSE
 *                     `speech_state` says speaking, bounded by `estimated_ms`.
 *   - `unlock()`      call from the user's send / mic gesture (autoplay).
 *
 * Classic scripts (`ask.js`) reach it through `window.KyberionPartnerAvatar`.
 */
/* global window, document */
import { renderA2UI } from '/shared-ui/kyberion-ui.js';
import { createSpeechPlayer } from '/shared-ui/speech-player.js';

/** The product agent set (knowledge/product/presence/avatar-profiles.json, presence-surface-agent). */
export const PARTNER_DEFAULT_IMAGES = Object.freeze({
  neutral: '/assets/avatars/kyberion-neutral.svg',
  joy: '/assets/avatars/kyberion-joy.svg',
  thinking: '/assets/avatars/kyberion-thinking.svg',
  listening: '/assets/avatars/kyberion-listening.svg',
  blink: '/assets/avatars/kyberion-blink.svg',
});
/** Mouth anchor of the product SVGs (same as the gallery fixture). */
export const PARTNER_DEFAULT_MOUTH = Object.freeze({ x: 0.5, y: 0.51, width: 0.16 });

const PERSONAL_AVATAR_URL = '/api/me/avatar';
const SYNTHESIZE_URL = '/api/voice/synthesize';
const EXPRESSIONS = ['neutral', 'joy', 'thinking', 'listening'];
const STATES = ['idle', 'listening', 'thinking', 'speaking', 'muted', 'error'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** BCP-47 speech language for a page locale. */
export function partnerSpeechLang(locale) {
  return locale === 'ja' ? 'ja-JP' : 'en-US';
}

/** Same-origin string URLs only, keyed by the `ui:talking-avatar` image names. */
export function partnerImages(map) {
  const out = {};
  if (!isRecord(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
      out[key] = value;
    }
  }
  return out;
}

/** The adopted personal set from `/api/me/avatar`, or null (not owner / none / not adopted). */
export async function loadAdoptedPersonalAvatar(fetchImpl) {
  try {
    const response = await fetchImpl(PERSONAL_AVATAR_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const body = await response.json();
    const avatar = body && body.avatar;
    if (!isRecord(avatar) || avatar.adopted !== true) return null;
    const images = partnerImages(avatar.images);
    if (!images.neutral) return null;
    const version = encodeURIComponent(String(avatar.generated_at || ''));
    for (const key of Object.keys(images)) images[key] = `${images[key]}?v=${version}`;
    return { images, mouth: isRecord(avatar.mouth) ? avatar.mouth : undefined };
  } catch {
    return null;
  }
}

async function loadUiMessages(fetchImpl, locale) {
  try {
    const response = await fetchImpl(`/shared-ui/messages/${encodeURIComponent(locale)}.json`, {
      cache: 'no-store',
    });
    const body = response.ok ? await response.json() : null;
    return body && isRecord(body.messages) ? body.messages : {};
  } catch {
    return {};
  }
}

/** The single `ui:talking-avatar` component this module renders. */
export function partnerAvatarComponent({ name, label, images, mouth, size, showState, state }) {
  return {
    id: `${name}-avatar`,
    type: 'ui:talking-avatar',
    props: {
      name,
      label,
      images,
      ...(mouth ? { mouth } : {}),
      mouth_mode: 'auto',
      size,
      show_state: showState,
      ...(state ? { state } : {}),
    },
  };
}

/**
 * Mount the partner avatar into `container`. Returns a handle immediately;
 * calls made before the avatar is ready are applied once it is.
 * @param {Element} container
 * @param {{
 *   name?: string, label?: string, personalLabel?: string, size?: string,
 *   showState?: boolean, locale?: string, fallbackImages?: Record<string, string>,
 *   fallbackMouth?: { x: number, y: number, width: number },
 *   win?: any, fetchImpl?: Function, onSpeechState?: (state: string, detail: object) => void,
 * }} [options]
 */
export function mountPartnerAvatar(container, options = {}) {
  const win = options.win || window;
  const fetchImpl = options.fetchImpl || win.fetch.bind(win);
  const locale = options.locale || document.documentElement.getAttribute('lang') || 'en';
  const name = options.name || 'partner';
  let controller = null;
  let disposed = false;
  let baseState = null;
  let expression = null;
  let playerSpeaking = false;
  let personal = false;
  let renderedKey = '';
  let fallbackImages = partnerImages(options.fallbackImages || PARTNER_DEFAULT_IMAGES);
  let fallbackMouth = options.fallbackMouth || PARTNER_DEFAULT_MOUTH;
  let messages = null;

  const effectiveState = () => (playerSpeaking ? 'speaking' : baseState);
  const apply = () => {
    if (!controller) return;
    controller.setState(effectiveState());
    controller.setExpression(expression);
    container.setAttribute('data-avatar-state', effectiveState() || 'idle');
  };

  const player = createSpeechPlayer({
    win,
    synthesizeUrl: SYNTHESIZE_URL,
    lang: partnerSpeechLang(locale),
    onState: (state, detail) => {
      playerSpeaking = state === 'speaking';
      apply();
      if (state === 'idle' && pendingRender) render(...pendingRender);
      if (typeof options.onSpeechState === 'function') options.onSpeechState(state, detail);
    },
  });

  const onAction = (action) => {
    if (!action || action.id !== 'avatar.ready') return;
    const payload = action.payload || {};
    if (payload.name !== name || disposed) return;
    controller = payload.controller;
    player.setLipsync(controller);
    // A re-render while the host is speaking: keep the synthetic mouth going.
    if (player.state === 'speaking' && player.mode === 'host') controller.startSynthetic();
    apply();
  };

  // Image changes wait until the current utterance ends (browser audio keeps
  // its analyser on the controller it started with).
  let pendingRender = null;

  const render = (images, mouth, label) => {
    const key = JSON.stringify([images, mouth, label]);
    if (key === renderedKey || disposed) return;
    if (controller && playerSpeaking && player.mode !== 'host') {
      pendingRender = [images, mouth, label];
      return;
    }
    pendingRender = null;
    renderedKey = key;
    controller = null;
    renderA2UI(
      container,
      [
        partnerAvatarComponent({
          name,
          label,
          images,
          mouth,
          size: options.size || 'lg',
          showState: options.showState !== false,
          state: effectiveState(),
        }),
      ],
      { locale, messages: messages || {}, onAction }
    );
    container.setAttribute('data-avatar-source', personal ? 'personal' : 'agent');
  };

  const label = () =>
    personal ? options.personalLabel || options.label || '' : options.label || '';

  Promise.all([loadUiMessages(fetchImpl, locale), loadAdoptedPersonalAvatar(fetchImpl)]).then(
    ([loadedMessages, own]) => {
      messages = loadedMessages;
      if (own) {
        personal = true;
        render(own.images, own.mouth, label());
      } else {
        render(fallbackImages, fallbackMouth, label());
      }
    }
  );

  const handle = {
    /** Page state (`listening` / `thinking` / `speaking` / null); browser playback overlays `speaking`. */
    setState(state) {
      baseState = STATES.includes(state) ? state : null;
      apply();
    },
    /** `neutral` / `joy` / `thinking` / `listening`, or null to follow the state. */
    setExpression(next) {
      expression = EXPRESSIONS.includes(next) ? next : null;
      apply();
    },
    /** The agent profile map changed (e.g. a `set_agent` timeline); ignored while the personal set shows. */
    setFallbackImages(map, mouth) {
      const images = partnerImages(map);
      if (!images.neutral) return;
      fallbackImages = images;
      if (mouth) fallbackMouth = mouth;
      if (!personal && messages) render(fallbackImages, fallbackMouth, label());
    },
    speak(text, opts) {
      return player.speak(text, opts);
    },
    followHost(input) {
      return player.followHostSpeech(input || { speaking: false });
    },
    unlock() {
      return player.unlock();
    },
    stop() {
      player.stop();
    },
    get speaking() {
      return playerSpeaking;
    },
    dispose() {
      disposed = true;
      player.dispose();
      if (controller) controller.dispose();
      controller = null;
    },
  };
  return handle;
}

if (typeof window !== 'undefined') {
  window.KyberionPartnerAvatar = { mount: mountPartnerAvatar };
}
