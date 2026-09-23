/*
 * Kyberion UI — settings & form components (UI-01c,
 * SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §3.3) for the vanilla renderer.
 *
 * `kyberion-ui.js` merges `createFormRenderers(...)` into its renderer table;
 * the React renderer (`libs/shared-ui/src/forms/*`) imports the pure helpers
 * below (ids, file screening, byte formatting, the camera controller) so
 * both renderers behave the same.
 *
 * Interaction contract:
 *   - Controls are controlled by `value`; every edit dispatches
 *     `onAction({ id: 'field.change', payload: { name, value } })`.
 *   - Files, captured photos and secret values are NEVER props. They exist
 *     only as live DOM state (`input.files`, `input.value` — the property,
 *     never an attribute) and are handed to `onAction` in the payload of the
 *     declared action. Nothing here writes them to attributes, `data-*`,
 *     storage or the console.
 *   - `ui:secret-field` never emits `field.change`; its value goes out only
 *     in the submit action payload, then the input is cleared.
 *   - The camera starts only from a user action and every track is stopped
 *     on capture / confirm / cancel / re-render / `pagehide`.
 */
/* global Blob, File */

/** Mirrors `KB_FORM_ACTIONS` in libs/core/a2ui-catalog.ts (pinned by tests). */
export const KB_FORM_ACTIONS = Object.freeze({
  fieldChange: 'field.change',
  filesAdd: 'file.add',
  fileRemove: 'file.remove',
  cameraCapture: 'camera.capture',
  cameraCancel: 'camera.cancel',
  avatarChange: 'avatar.change',
  avatarRemove: 'avatar.remove',
});

/** Vocabulary keys (`ui:*`) of every form default string. */
export const KB_FORM_MESSAGE_KEYS = Object.freeze({
  required: 'ui:field_required',
  selectPlaceholder: 'ui:select_placeholder',
  textCount: 'ui:text_count',
  saveBarLabel: 'ui:save_bar_label',
  saveBarSave: 'ui:save_bar_save',
  saveBarDiscard: 'ui:save_bar_discard',
  fileDropPrompt: 'ui:file_drop_prompt',
  fileDropPromptSingle: 'ui:file_drop_prompt_single',
  fileDropBrowse: 'ui:file_drop_browse',
  fileDropBrowseSingle: 'ui:file_drop_browse_single',
  fileDropAccept: 'ui:file_drop_accept',
  fileDropMaxSize: 'ui:file_drop_max_size',
  fileDropMaxFiles: 'ui:file_drop_max_files',
  fileDropAdded: 'ui:file_drop_added',
  fileDropRejectType: 'ui:file_drop_reject_type',
  fileDropRejectSize: 'ui:file_drop_reject_size',
  fileDropRejectCount: 'ui:file_drop_reject_count',
  fileListLabel: 'ui:file_list_label',
  fileRemove: 'ui:file_remove',
  fileCancel: 'ui:file_cancel',
  cameraStart: 'ui:camera_start',
  cameraStarting: 'ui:camera_starting',
  cameraLiveLabel: 'ui:camera_live_label',
  cameraTake: 'ui:camera_take',
  cameraRetake: 'ui:camera_retake',
  cameraUse: 'ui:camera_use',
  cameraCancel: 'ui:camera_cancel',
  cameraChooseFile: 'ui:camera_choose_file',
  cameraPreviewAlt: 'ui:camera_preview_alt',
  cameraUnavailable: 'ui:camera_unavailable',
  cameraDenied: 'ui:camera_denied',
  avatarUpload: 'ui:avatar_upload',
  avatarTake: 'ui:avatar_take',
  avatarRemove: 'ui:avatar_remove',
  avatarUse: 'ui:avatar_use',
  avatarCancel: 'ui:avatar_cancel',
  avatarCurrentAlt: 'ui:avatar_current_alt',
  avatarPreviewAlt: 'ui:avatar_preview_alt',
  avatarEmpty: 'ui:avatar_empty',
  secretConfigured: 'ui:secret_configured',
  secretConfiguredPlain: 'ui:secret_configured_plain',
  secretNotConfigured: 'ui:secret_not_configured',
  secretShow: 'ui:secret_show',
  secretHide: 'ui:secret_hide',
  secretPaste: 'ui:secret_paste',
  secretPasteUnavailable: 'ui:secret_paste_unavailable',
  secretSave: 'ui:secret_save',
  secretReplace: 'ui:secret_replace',
  secretRemove: 'ui:secret_remove',
  secretCancel: 'ui:secret_cancel',
  secretSubmitted: 'ui:secret_submitted',
});

/** `ui:save-bar` default message per state. */
export const KB_SAVE_BAR_MESSAGE_KEYS = Object.freeze({
  clean: 'ui:save_bar_clean',
  dirty: 'ui:save_bar_dirty',
  saving: 'ui:save_bar_saving',
  saved: 'ui:save_bar_saved',
  error: 'ui:save_bar_error',
});

/** `ui:file-drop` entry status label keys. */
export const KB_FILE_STATUS_MESSAGE_KEYS = Object.freeze({
  queued: 'ui:file_status_queued',
  uploading: 'ui:file_status_uploading',
  done: 'ui:file_status_done',
  error: 'ui:file_status_error',
});

/**
 * `ui:integration-item.state` → the canonical status its pill reuses (for the
 * tone + icon) and the integration-specific label key.
 */
export const KB_INTEGRATION_STATES = Object.freeze({
  connected: Object.freeze({ status: 'connected', key: 'ui:integration_connected' }),
  needs_reauth: Object.freeze({ status: 'needs_setup', key: 'ui:integration_needs_reauth' }),
  disconnected: Object.freeze({ status: 'stopped', key: 'ui:integration_disconnected' }),
  error: Object.freeze({ status: 'error', key: 'ui:integration_error' }),
});

/** Icons only the form components use (24px grid, stroke = currentColor). */
export const KB_FORM_ICON_PATHS = Object.freeze({
  upload: ['M12 16V4', 'M6 10l6-6 6 6', 'M4 20h16'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  plug: ['M9 3v5', 'M15 3v5', 'M7 8h10v3a5 5 0 0 1-10 0z', 'M12 16v5'],
});

// ---------------------------------------------------------------------------
// Pure helpers (shared with the React renderer)
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deterministic DOM ids for a field (label `for`, `aria-describedby`), from
 * the A2UI component id (else the field name) so both renderers agree.
 * @param {unknown} componentId
 * @param {unknown} name
 */
export function formFieldIds(componentId, name) {
  const raw =
    typeof componentId === 'string' && componentId
      ? componentId
      : typeof name === 'string' && name
        ? name
        : 'field';
  const base = `kbf-${raw.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return {
    input: base,
    label: `${base}-label`,
    help: `${base}-help`,
    error: `${base}-error`,
    hint: `${base}-hint`,
    status: `${base}-status`,
    title: `${base}-title`,
  };
}

/** `aria-describedby` value for the field's help / error (and extra ids); undefined when none. */
export function describedBy(ids, p, extra) {
  const list = [];
  if (Array.isArray(extra)) for (const id of extra) if (id) list.push(id);
  if (typeof p.help === 'string' && p.help) list.push(ids.help);
  if (typeof p.error === 'string' && p.error) list.push(ids.error);
  return list.length ? list.join(' ') : undefined;
}

/** Human-readable byte size (`25 MB`); '' for invalid input. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

function acceptTokens(accept) {
  return typeof accept === 'string'
    ? accept
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
    : [];
}

/** Display form of an `accept` list: `.pdf,image/*` → `PDF, image/*`. */
export function describeAccept(accept) {
  return acceptTokens(accept)
    .map((token) => (token.startsWith('.') ? token.slice(1).toUpperCase() : token))
    .join(', ');
}

/** Whether a file (name + MIME type) matches an `<input accept>` list; no list accepts all. */
export function fileMatchesAccept(file, accept) {
  const tokens = acceptTokens(accept);
  if (tokens.length === 0) return true;
  const name = String((file && file.name) || '').toLowerCase();
  const type = String((file && file.type) || '').toLowerCase();
  return tokens.some((raw) => {
    const token = raw.toLowerCase();
    if (token.startsWith('.')) return name.endsWith(token);
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

/**
 * Split picked / dropped / pasted files into accepted and rejected ones by
 * `accept`, `max_bytes`, `multiple` and `max_files` (counting `existing`).
 * Rejections carry only `{ name, size, reason }`.
 */
export function screenFiles(files, p, existing = 0) {
  const accepted = [];
  const rejected = [];
  const limit =
    p.multiple === true
      ? Number.isInteger(p.max_files)
        ? Math.max(p.max_files - existing, 0)
        : Infinity
      : 1;
  for (const file of Array.from(files || [])) {
    if (!file) continue;
    const size = typeof file.size === 'number' ? file.size : 0;
    const name = String(file.name || '');
    if (!fileMatchesAccept(file, p.accept)) rejected.push({ name, size, reason: 'type' });
    else if (Number.isInteger(p.max_bytes) && size > p.max_bytes)
      rejected.push({ name, size, reason: 'size' });
    else if (accepted.length >= limit) rejected.push({ name, size, reason: 'count' });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** One-line notice for a screening result (rejections first). */
export function screeningNotice(result, p, t, K = KB_FORM_MESSAGE_KEYS) {
  const first = result.rejected[0];
  if (first) {
    if (first.reason === 'type') return t(K.fileDropRejectType, { file: first.name });
    if (first.reason === 'size')
      return t(K.fileDropRejectSize, { file: first.name, size: formatBytes(p.max_bytes) });
    return t(K.fileDropRejectCount, {
      count: p.multiple === true && Number.isInteger(p.max_files) ? p.max_files : 1,
    });
  }
  return result.accepted.length ? t(K.fileDropAdded, { count: result.accepted.length }) : '';
}

/** The constraint line under the drop zone (`Accepted: PDF · Up to 25 MB each`). */
export function fileDropHint(p, t) {
  const parts = [];
  const types = describeAccept(p.accept);
  if (types) parts.push(t(KB_FORM_MESSAGE_KEYS.fileDropAccept, { types }));
  if (Number.isInteger(p.max_bytes))
    parts.push(t(KB_FORM_MESSAGE_KEYS.fileDropMaxSize, { size: formatBytes(p.max_bytes) }));
  if (p.multiple === true && Number.isInteger(p.max_files))
    parts.push(t(KB_FORM_MESSAGE_KEYS.fileDropMaxFiles, { count: p.max_files }));
  return parts.join(' · ');
}

/** Visible status of a file entry (`Uploading 40%`). */
export function fileStatusText(entry, t) {
  const key = Object.prototype.hasOwnProperty.call(KB_FILE_STATUS_MESSAGE_KEYS, entry.status)
    ? KB_FILE_STATUS_MESSAGE_KEYS[entry.status]
    : KB_FILE_STATUS_MESSAGE_KEYS.queued;
  const label = t(key);
  if (entry.status === 'uploading' && typeof entry.progress === 'number') {
    return `${label} ${Math.round(Math.min(Math.max(entry.progress, 0), 100))}%`;
  }
  return label;
}

/** `{ name, size }` meta line of a file entry. */
export function fileMetaText(entry, t) {
  const size = formatBytes(entry.size);
  const status = fileStatusText(entry, t);
  return size ? `${size} · ${status}` : status;
}

/** Slider value text including the unit (`40%`, `3 min`). */
export function sliderValueText(value, unit) {
  const text = value === undefined || value === null ? '' : String(value);
  if (!unit) return text;
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

/** Clamp/normalise a slider's range props. */
export function sliderRange(p) {
  const min = typeof p.min === 'number' ? p.min : 0;
  const max = typeof p.max === 'number' && p.max > min ? p.max : min + 100;
  const step = typeof p.step === 'number' && p.step > 0 ? p.step : 1;
  const value =
    typeof p.value === 'number' && Number.isFinite(p.value)
      ? Math.min(Math.max(p.value, min), max)
      : min;
  return { min, max, step, value };
}

/** Status text of a configured secret (`Set · ••••x9Qa`). */
export function secretStatusText(p, t) {
  if (p.configured !== true) return t(KB_FORM_MESSAGE_KEYS.secretNotConfigured);
  return typeof p.last4 === 'string' && /^[A-Za-z0-9]{1,4}$/.test(p.last4)
    ? t(KB_FORM_MESSAGE_KEYS.secretConfigured, { last4: p.last4 })
    : t(KB_FORM_MESSAGE_KEYS.secretConfiguredPlain);
}

/** Value reported by a text field (`number` inputs report a number when valid). */
export function textFieldValue(type, raw) {
  if (type === 'number') {
    if (raw === '') return '';
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

/** Normalised `{ id, payload }` of an action prop, else the default id. */
export function formAction(action, defaultId) {
  if (typeof action === 'string' && action) return { id: action, payload: undefined };
  if (isRecord(action) && typeof action.id === 'string' && action.id) {
    return { id: action.id, payload: isRecord(action.payload) ? action.payload : undefined };
  }
  return { id: defaultId, payload: undefined };
}

/** Merge the declared payload with runtime data (runtime keys win). */
export function actionPayload(action, runtime) {
  return { ...(action.payload || {}), ...runtime };
}

/** Wrap a Blob as a File (with a name) when the platform has `File`. */
export function toFile(blob, name, win) {
  const FileCtor = (win && win.File) || (typeof File !== 'undefined' ? File : undefined);
  if (!blob || !FileCtor) return blob;
  try {
    return new FileCtor([blob], name, { type: blob.type || 'application/octet-stream' });
  } catch {
    return blob;
  }
}

/** Stop every track of a MediaStream (idempotent, never throws). */
export function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }
}

/** Whether `getUserMedia` exists in this window (secure context + support). */
export function cameraSupported(win) {
  return Boolean(
    win &&
    win.navigator &&
    win.navigator.mediaDevices &&
    typeof win.navigator.mediaDevices.getUserMedia === 'function'
  );
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/** Source rectangle for a centered crop of `w × h` to the aspect (`square` | 4:3 `landscape`). */
export function centerCrop(width, height, aspect) {
  const ratio = aspect === 'landscape' ? 4 / 3 : 1;
  let sw = width;
  let sh = Math.round(width / ratio);
  if (sh > height) {
    sh = height;
    sw = Math.round(height * ratio);
  }
  return { sx: Math.round((width - sw) / 2), sy: Math.round((height - sh) / 2), sw, sh };
}

/** Draw the current video frame (center-cropped) to a canvas and return it as a JPEG Blob. */
export async function captureVideoFrame(video, doc, aspect, maxSize = 1024) {
  const width = video && video.videoWidth;
  const height = video && video.videoHeight;
  if (!width || !height || !doc) return null;
  const crop = centerCrop(width, height, aspect);
  const scale = Math.min(1, maxSize / crop.sw);
  const canvas = doc.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.sw * scale));
  canvas.height = Math.max(1, Math.round(crop.sh * scale));
  const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!context) return null;
  context.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, 'image/jpeg', 0.92);
}

/**
 * Square-crop an image file to `size`² PNG (avatar preview/upload). Returns
 * the original file when decoding is unavailable (no createImageBitmap).
 */
export async function cropImageToSquare(file, doc, win, size = 512) {
  const decode = win && typeof win.createImageBitmap === 'function' ? win.createImageBitmap : null;
  if (!file || !doc || !decode) return file;
  try {
    const bitmap = await decode.call(win, file);
    const crop = centerCrop(bitmap.width, bitmap.height, 'square');
    const canvas = doc.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size, size);
    if (typeof bitmap.close === 'function') bitmap.close();
    const blob = await canvasToBlob(canvas, 'image/png');
    return blob ? toFile(blob, 'avatar.png', win) : file;
  } catch {
    return file;
  }
}

/**
 * Renderer-independent camera state machine. Phases: `idle` → `starting` →
 * `live` → `captured`; `fallback` when getUserMedia is missing or denied
 * (the UI then offers `<input type=file accept=image/* capture>`).
 *
 * The stream is stopped on capture, confirm, cancel, dispose and `pagehide`.
 * The captured Blob stays inside this closure until `confirm()` returns it.
 *
 * @param {{ win?: any, doc?: any, facing?: string, aspect?: string, onState?: (state: any) => void }} options
 */
export function createCameraController(options = {}) {
  const win = options.win;
  const facing = options.facing === 'environment' ? 'environment' : 'user';
  const aspect = options.aspect === 'landscape' ? 'landscape' : 'square';
  let stream = null;
  let video = null;
  let blob = null;
  let previewUrl = null;
  let disposed = false;
  let fallback = false;
  let state = { phase: 'idle', notice: null, previewUrl: null };

  const emit = (patch) => {
    state = { ...state, ...patch };
    if (!disposed && typeof options.onState === 'function') options.onState(state);
  };
  const revoke = () => {
    if (previewUrl && win && win.URL && typeof win.URL.revokeObjectURL === 'function') {
      win.URL.revokeObjectURL(previewUrl);
    }
    previewUrl = null;
  };
  const stop = () => {
    stopStream(stream);
    stream = null;
    if (video) {
      try {
        video.srcObject = null;
      } catch {
        // detached element
      }
    }
  };
  const restPhase = () => (fallback ? 'fallback' : 'idle');
  const onPageHide = () => controller.cancel();

  const controller = {
    get state() {
      return state;
    },
    /** The live stream (tests / diagnostics); null unless `live`. */
    get stream() {
      return stream;
    },
    /** Bind the `<video>` preview element (or null when it unmounts). */
    attach(element) {
      video = element || null;
      if (video && stream) {
        try {
          video.srcObject = stream;
          const played = typeof video.play === 'function' ? video.play() : null;
          if (played && typeof played.catch === 'function') played.catch(() => {});
        } catch {
          // preview only
        }
      }
    },
    /** Request the camera. Call only from a user action (click). */
    async start() {
      if (disposed || state.phase === 'starting' || state.phase === 'live') return;
      if (!cameraSupported(win)) {
        fallback = true;
        emit({ phase: 'fallback', notice: 'unavailable', previewUrl: null });
        return;
      }
      emit({ phase: 'starting', notice: null, previewUrl: null });
      try {
        const next = await win.navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing },
          audio: false,
        });
        if (disposed || state.phase !== 'starting') {
          stopStream(next);
          return;
        }
        stream = next;
        emit({ phase: 'live' });
        if (video) controller.attach(video);
      } catch {
        stop();
        fallback = true;
        emit({ phase: 'fallback', notice: 'denied' });
      }
    },
    /** Grab the current frame; stops the stream while the photo is reviewed. */
    async capture() {
      if (state.phase !== 'live' || !video) return;
      const frame = await captureVideoFrame(video, options.doc, aspect);
      if (!frame || disposed) return;
      stop();
      blob = frame;
      revoke();
      previewUrl =
        win && win.URL && typeof win.URL.createObjectURL === 'function'
          ? win.URL.createObjectURL(frame)
          : null;
      emit({ phase: 'captured', previewUrl });
    },
    /** Fallback path: a photo picked through `<input type=file capture>`. */
    useFile(file) {
      if (!file || disposed) return;
      stop();
      blob = file;
      revoke();
      previewUrl =
        win && win.URL && typeof win.URL.createObjectURL === 'function'
          ? win.URL.createObjectURL(file)
          : null;
      emit({ phase: 'captured', previewUrl });
    },
    /** Discard the photo and go back to the camera (or the file fallback). */
    async retake() {
      blob = null;
      revoke();
      emit({ phase: restPhase(), previewUrl: null });
      if (!fallback) await controller.start();
    },
    /** Hand the photo over (Blob), stop everything and reset. */
    confirm() {
      const result = blob;
      blob = null;
      stop();
      revoke();
      emit({ phase: restPhase(), previewUrl: null });
      return result;
    },
    cancel() {
      blob = null;
      stop();
      revoke();
      emit({ phase: restPhase(), previewUrl: null });
    },
    dispose() {
      blob = null;
      stop();
      revoke();
      disposed = true;
      if (win && typeof win.removeEventListener === 'function')
        win.removeEventListener('pagehide', onPageHide);
    },
  };
  if (win && typeof win.addEventListener === 'function')
    win.addEventListener('pagehide', onPageHide);
  return controller;
}

// ---------------------------------------------------------------------------
// Vanilla DOM renderers
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {{
 *   el: (ctx: any, tag: string, className?: string, text?: unknown) => any,
 *   setData: (node: any, name: string, value: unknown) => void,
 *   actionButton: (ctx: any, ref: unknown, variant: string, source: unknown) => any,
 *   statusPill: (ctx: any, status: string, domain?: string, label?: string) => any,
 *   appendChildren: (ctx: any, parent: any, component: any, depth: number) => void,
 *   safeHref: (value: unknown) => string | null,
 *   iconPaths: Readonly<Record<string, readonly string[]>>,
 * }} FormRendererHelpers
 */

/**
 * Build the `ui:*` form renderers on top of `kyberion-ui.js`'s helpers
 * (passed in to keep this module free of a circular import).
 * @param {FormRendererHelpers} h
 */
export function createFormRenderers(h) {
  const { el, setData } = h;
  const K = KB_FORM_MESSAGE_KEYS;

  const attr = (node, name, value) => {
    if (value === undefined || value === null || value === false || value === '') return;
    node.setAttribute(name, value === true ? '' : String(value));
  };

  const listen = (node, type, handler) => node.addEventListener(type, handler);

  const dispatch = (ctx, source, action, payload) => {
    if (typeof ctx.onAction === 'function') {
      ctx.onAction({ id: action.id, payload: actionPayload(action, payload) }, source);
    }
  };

  const fieldChange = (ctx, source, name, value) =>
    dispatch(ctx, source, { id: KB_FORM_ACTIONS.fieldChange }, { name, value });

  const registerCleanup = (ctx, fn) => {
    if (Array.isArray(ctx.cleanups)) ctx.cleanups.push(fn);
  };

  const svgIcon = (ctx, name, size = 18) => {
    const paths = Object.prototype.hasOwnProperty.call(KB_FORM_ICON_PATHS, name)
      ? KB_FORM_ICON_PATHS[name]
      : Object.prototype.hasOwnProperty.call(h.iconPaths, name)
        ? h.iconPaths[name]
        : null;
    if (!paths) return null;
    const svg = ctx.doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of paths) {
      const path = ctx.doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  };

  const iconWrap = (ctx, className, name) => {
    const svg = svgIcon(ctx, name);
    if (!svg) return null;
    const wrap = el(ctx, 'span', className);
    wrap.setAttribute('aria-hidden', 'true');
    wrap.appendChild(svg);
    return wrap;
  };

  const button = (ctx, className, label, onClick, extra = {}) => {
    const node = el(ctx, 'button', className, label);
    node.setAttribute('type', 'button');
    if (extra.disabled) node.disabled = true;
    if (extra.ariaLabel) node.setAttribute('aria-label', extra.ariaLabel);
    if (onClick) listen(node, 'click', onClick);
    return node;
  };

  /** Field root `div.kb-field[data-control]` (or `fieldset`). */
  const fieldRoot = (ctx, p, control, tag = 'div', extraClass = '') => {
    const root = el(ctx, tag, extraClass ? `kb-field ${extraClass}` : 'kb-field');
    setData(root, 'control', control);
    if (p.disabled === true) setData(root, 'disabled', 'true');
    if (typeof p.error === 'string' && p.error) setData(root, 'invalid', 'true');
    return root;
  };

  /** `.kb-field__label` (label[for] / span[id] / legend) with the required marker. */
  const fieldLabel = (ctx, p, ids, tag) => {
    const label = el(
      ctx,
      tag,
      p.hide_label === true ? 'kb-field__label kb-visually-hidden' : 'kb-field__label'
    );
    if (tag === 'label') label.setAttribute('for', ids.input);
    if (tag === 'span') label.setAttribute('id', ids.label);
    label.appendChild(ctx.doc.createTextNode(String(p.label ?? '')));
    if (p.required === true) {
      const mark = el(ctx, 'span', 'kb-field__required', ctx.t(K.required));
      mark.setAttribute('aria-hidden', 'true');
      label.appendChild(mark);
    }
    return label;
  };

  const appendHelpAndError = (ctx, root, p, ids) => {
    if (typeof p.help === 'string' && p.help) {
      const help = el(ctx, 'p', 'kb-field__help', p.help);
      help.setAttribute('id', ids.help);
      root.appendChild(help);
    }
    if (typeof p.error === 'string' && p.error) {
      const error = el(ctx, 'p', 'kb-field__error', p.error);
      error.setAttribute('id', ids.error);
      root.appendChild(error);
    }
  };

  /** Shared attributes of a native control (id, describedby, invalid, required, disabled). */
  const controlAttrs = (input, p, ids, extraDescribedBy) => {
    input.setAttribute('id', ids.input);
    attr(input, 'aria-describedby', describedBy(ids, p, extraDescribedBy));
    if (typeof p.error === 'string' && p.error) input.setAttribute('aria-invalid', 'true');
    if (p.required === true) input.required = true;
    if (p.disabled === true) input.disabled = true;
  };

  const liveNotice = (ctx, className) => {
    const notice = el(ctx, 'p', className);
    notice.setAttribute('role', 'status');
    return notice;
  };

  const setText = (node, text) => {
    node.textContent = text || '';
  };

  // -- toggles -----------------------------------------------------------

  const toggle = (ctx, p, c, control) => {
    const ids = formFieldIds(c.id, p.name);
    const root = fieldRoot(ctx, p, control);
    const block = control === 'switch' ? 'kb-switch' : 'kb-check';
    const wrap = el(ctx, 'label', block);
    const input = el(ctx, 'input', `${block}__input`);
    input.setAttribute('type', 'checkbox');
    if (control === 'switch') input.setAttribute('role', 'switch');
    controlAttrs(input, p, ids);
    input.checked = p.value === true;
    listen(input, 'change', () => fieldChange(ctx, c, p.name, input.checked === true));
    wrap.appendChild(input);
    if (control === 'switch') {
      const track = el(ctx, 'span', 'kb-switch__track');
      track.setAttribute('aria-hidden', 'true');
      track.appendChild(el(ctx, 'span', 'kb-switch__thumb'));
      wrap.appendChild(track);
    }
    const text = el(
      ctx,
      'span',
      p.hide_label === true ? `${block}__label kb-visually-hidden` : `${block}__label`
    );
    text.appendChild(ctx.doc.createTextNode(String(p.label ?? '')));
    if (p.required === true) {
      const mark = el(ctx, 'span', 'kb-field__required', ctx.t(K.required));
      mark.setAttribute('aria-hidden', 'true');
      text.appendChild(mark);
    }
    wrap.appendChild(text);
    root.appendChild(wrap);
    appendHelpAndError(ctx, root, p, ids);
    return root;
  };

  // -- choice groups -------------------------------------------------------

  const choiceGroup = (ctx, p, c, control) => {
    const ids = formFieldIds(c.id, p.name);
    const segmented = control === 'segmented';
    const root = fieldRoot(
      ctx,
      p,
      control,
      'fieldset',
      segmented ? 'kb-segmented' : 'kb-choice-group'
    );
    if (!segmented && p.direction === 'horizontal') setData(root, 'direction', 'horizontal');
    attr(root, 'aria-describedby', describedBy(ids, p));
    root.appendChild(fieldLabel(ctx, p, ids, 'legend'));
    const list = el(ctx, 'div', segmented ? 'kb-segmented__options' : 'kb-choice-group__options');
    const options = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
    options.forEach((option, index) => {
      const optionId = `${ids.input}-${index}`;
      const disabled = p.disabled === true || option.disabled === true;
      const label = el(ctx, 'label', segmented ? 'kb-segmented__option' : 'kb-check');
      if (disabled) setData(label, 'disabled', 'true');
      const input = el(ctx, 'input', segmented ? 'kb-segmented__input' : 'kb-check__input');
      input.setAttribute('type', 'radio');
      input.setAttribute('id', optionId);
      input.setAttribute('name', ids.input);
      input.setAttribute('value', String(option.value ?? ''));
      input.checked = p.value !== undefined && option.value === p.value;
      if (disabled) input.disabled = true;
      if (p.required === true) input.required = true;
      if (typeof p.error === 'string' && p.error) input.setAttribute('aria-invalid', 'true');
      if (!segmented && option.description)
        input.setAttribute('aria-describedby', `${optionId}-description`);
      listen(input, 'change', () => {
        if (input.checked) fieldChange(ctx, c, p.name, String(option.value ?? ''));
      });
      label.appendChild(input);
      if (segmented) {
        label.appendChild(el(ctx, 'span', 'kb-segmented__label', option.label));
      } else {
        const text = el(ctx, 'span', 'kb-check__text');
        text.appendChild(el(ctx, 'span', 'kb-check__label', option.label));
        if (option.description) {
          const description = el(ctx, 'span', 'kb-check__description', option.description);
          description.setAttribute('id', `${optionId}-description`);
          text.appendChild(description);
        }
        label.appendChild(text);
      }
      list.appendChild(label);
    });
    root.appendChild(list);
    appendHelpAndError(ctx, root, p, ids);
    return root;
  };

  // -- text ----------------------------------------------------------------

  const textInput = (ctx, p, c, multiline) => {
    const ids = formFieldIds(c.id, p.name);
    const root = fieldRoot(ctx, p, multiline ? 'textarea' : 'text-field');
    root.appendChild(fieldLabel(ctx, p, ids, 'label'));
    const type = ['email', 'url', 'number', 'search'].includes(p.type) ? p.type : 'text';
    const input = el(
      ctx,
      multiline ? 'textarea' : 'input',
      multiline ? 'kb-input kb-textarea' : 'kb-input'
    );
    if (!multiline) input.setAttribute('type', type);
    controlAttrs(input, p, ids);
    input.setAttribute('name', String(p.name ?? ''));
    attr(input, 'placeholder', p.placeholder);
    if (Number.isInteger(p.maxlength)) input.setAttribute('maxlength', String(p.maxlength));
    if (multiline && Number.isInteger(p.rows)) input.setAttribute('rows', String(p.rows));
    if (!multiline && type === 'number') {
      if (typeof p.min === 'number') input.setAttribute('min', String(p.min));
      if (typeof p.max === 'number') input.setAttribute('max', String(p.max));
      if (typeof p.step === 'number') input.setAttribute('step', String(p.step));
    }
    if (p.readonly === true) input.readOnly = true;
    const initial = p.value === undefined || p.value === null ? '' : String(p.value);
    // A textarea's initial value is its text content (what React renders too).
    if (multiline && initial) input.textContent = initial;
    input.value = initial;
    root.appendChild(input);
    let count = null;
    if (multiline && Number.isInteger(p.maxlength)) {
      count = el(
        ctx,
        'p',
        'kb-field__count',
        ctx.t(K.textCount, { count: input.value.length, max: p.maxlength })
      );
      count.setAttribute('aria-hidden', 'true');
      root.appendChild(count);
    }
    listen(input, 'input', () => {
      if (count)
        setText(count, ctx.t(K.textCount, { count: input.value.length, max: p.maxlength }));
      fieldChange(ctx, c, p.name, multiline ? input.value : textFieldValue(type, input.value));
    });
    appendHelpAndError(ctx, root, p, ids);
    return root;
  };

  // -- file drop -----------------------------------------------------------

  const fileList = (ctx, p, c) => {
    const files = Array.isArray(p.files) ? p.files.filter(isRecord) : [];
    if (files.length === 0) return null;
    const list = el(ctx, 'ul', 'kb-file-list');
    list.setAttribute('aria-label', ctx.t(K.fileListLabel));
    const removeAction = formAction(p.remove_action, KB_FORM_ACTIONS.fileRemove);
    for (const entry of files) {
      const item = el(ctx, 'li', 'kb-file-list__item');
      setData(item, 'status', entry.status);
      const body = el(ctx, 'div', 'kb-file-list__body');
      body.appendChild(el(ctx, 'span', 'kb-file-list__name', entry.name));
      body.appendChild(el(ctx, 'span', 'kb-file-list__meta', fileMetaText(entry, ctx.t)));
      if (entry.status === 'uploading') {
        const progress = el(ctx, 'progress', 'kb-file-list__progress');
        progress.setAttribute('max', '100');
        if (typeof entry.progress === 'number')
          progress.setAttribute(
            'value',
            String(Math.round(Math.min(Math.max(entry.progress, 0), 100)))
          );
        progress.setAttribute('aria-label', String(entry.name));
        body.appendChild(progress);
      }
      if (entry.status === 'error' && entry.error)
        body.appendChild(el(ctx, 'span', 'kb-file-list__error', entry.error));
      item.appendChild(body);
      const label = ctx.t(entry.status === 'uploading' ? K.fileCancel : K.fileRemove, {
        file: entry.name,
      });
      const remove = button(
        ctx,
        'kb-btn kb-btn--ghost kb-file-list__remove',
        undefined,
        () => dispatch(ctx, c, removeAction, { name: p.name, file_id: entry.id }),
        { ariaLabel: label, disabled: p.disabled === true }
      );
      const glyph = svgIcon(ctx, 'close', 16);
      if (glyph) remove.appendChild(glyph);
      item.appendChild(remove);
      list.appendChild(item);
    }
    return list;
  };

  const fileDrop = (ctx, p, c) => {
    const ids = formFieldIds(c.id, p.name);
    const root = fieldRoot(ctx, p, 'file-drop', 'div', 'kb-file-drop');
    root.appendChild(fieldLabel(ctx, p, ids, 'span'));
    if (p.description) root.appendChild(el(ctx, 'p', 'kb-field__description', p.description));
    const hintText = fileDropHint(p, ctx.t);
    const input = el(ctx, 'input', 'kb-file-drop__input kb-visually-hidden');
    input.setAttribute('type', 'file');
    controlAttrs(input, p, ids, hintText ? [ids.hint] : []);
    input.setAttribute('aria-labelledby', ids.label);
    attr(input, 'accept', typeof p.accept === 'string' ? p.accept : undefined);
    if (p.multiple === true) input.multiple = true;
    root.appendChild(input);

    const zone = el(ctx, 'label', 'kb-file-drop__zone');
    zone.setAttribute('for', ids.input);
    const glyph = iconWrap(ctx, 'kb-file-drop__icon', 'upload');
    if (glyph) zone.appendChild(glyph);
    const multiple = p.multiple === true;
    zone.appendChild(
      el(
        ctx,
        'span',
        'kb-file-drop__prompt',
        ctx.t(multiple ? K.fileDropPrompt : K.fileDropPromptSingle)
      )
    );
    zone.appendChild(
      el(
        ctx,
        'span',
        'kb-file-drop__browse',
        ctx.t(multiple ? K.fileDropBrowse : K.fileDropBrowseSingle)
      )
    );
    if (hintText) {
      const hint = el(ctx, 'span', 'kb-file-drop__hint', hintText);
      hint.setAttribute('id', ids.hint);
      zone.appendChild(hint);
    }
    root.appendChild(zone);
    const notice = liveNotice(ctx, 'kb-file-drop__notice');
    root.appendChild(notice);
    const list = fileList(ctx, p, c);
    if (list) root.appendChild(list);
    appendHelpAndError(ctx, root, p, ids);

    const addAction = formAction(p.action, KB_FORM_ACTIONS.filesAdd);
    const existing = (Array.isArray(p.files) ? p.files : []).filter(
      (entry) => isRecord(entry) && entry.status !== 'error'
    ).length;
    const take = (files) => {
      if (p.disabled === true || !files || files.length === 0) return;
      const result = screenFiles(files, p, existing);
      setText(notice, screeningNotice(result, p, ctx.t));
      if (result.accepted.length > 0) {
        dispatch(ctx, c, addAction, {
          name: p.name,
          files: result.accepted,
          rejected: result.rejected,
        });
      }
    };
    const setDragging = (on) => {
      if (on && p.disabled !== true) root.setAttribute('data-dragging', 'true');
      else if (typeof root.removeAttribute === 'function') root.removeAttribute('data-dragging');
    };
    listen(input, 'change', () => {
      take(input.files);
      try {
        input.value = '';
      } catch {
        // some engines refuse; harmless
      }
    });
    const over = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      setDragging(true);
    };
    listen(zone, 'dragenter', over);
    listen(zone, 'dragover', over);
    listen(zone, 'dragleave', () => setDragging(false));
    listen(zone, 'drop', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      setDragging(false);
      take(event && event.dataTransfer ? event.dataTransfer.files : null);
    });
    listen(root, 'paste', (event) => {
      const files = event && event.clipboardData ? event.clipboardData.files : null;
      if (files && files.length > 0) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        take(files);
      }
    });
    return root;
  };

  // -- camera --------------------------------------------------------------

  /**
   * Camera sub-UI shared by `ui:camera-capture` and `ui:avatar-picker`.
   * Returns `{ stage, actions, notice, start, dispose }`.
   */
  const cameraUi = (ctx, opts) => {
    const stage = el(ctx, 'div', 'kb-camera__stage');
    setData(stage, 'aspect', opts.aspect === 'landscape' ? 'landscape' : 'square');
    setData(stage, 'facing', opts.facing === 'environment' ? 'environment' : 'user');
    const actions = el(ctx, 'div', 'kb-camera__actions');
    const notice = liveNotice(ctx, 'kb-camera__notice');
    let focusNext = false;
    let video = null;

    const controller = createCameraController({
      win: ctx.win,
      doc: ctx.doc,
      facing: opts.facing,
      aspect: opts.aspect,
      onState: (state) => sync(state),
    });

    const clear = (node) => {
      while (node.firstChild) node.removeChild(node.firstChild);
    };

    const sync = (state) => {
      if (typeof opts.onPhase === 'function') opts.onPhase(state.phase);
      clear(stage);
      clear(actions);
      video = null;
      if (state.phase === 'live' || state.phase === 'starting') {
        video = el(ctx, 'video', 'kb-camera__video');
        video.setAttribute('aria-label', ctx.t(K.cameraLiveLabel));
        video.setAttribute('playsinline', '');
        video.muted = true;
        video.autoplay = true;
        stage.appendChild(video);
        controller.attach(video);
      } else if (state.phase === 'captured' && state.previewUrl) {
        const img = el(ctx, 'img', 'kb-camera__preview');
        img.setAttribute('src', state.previewUrl);
        img.setAttribute('alt', ctx.t(K.cameraPreviewAlt));
        stage.appendChild(img);
      } else {
        const placeholder = iconWrap(ctx, 'kb-camera__placeholder', 'camera');
        if (placeholder) stage.appendChild(placeholder);
      }

      const primary = [];
      if (state.phase === 'idle') {
        primary.push(
          button(ctx, 'kb-btn kb-btn--primary', ctx.t(K.cameraStart), () => start(), {
            disabled: opts.disabled,
          })
        );
      } else if (state.phase === 'starting') {
        primary.push(
          button(ctx, 'kb-btn kb-btn--primary', ctx.t(K.cameraStarting), null, { disabled: true })
        );
        actions.appendChild(primary[0]);
        actions.appendChild(
          button(ctx, 'kb-btn kb-btn--ghost', ctx.t(K.cameraCancel), () => cancel())
        );
      } else if (state.phase === 'live') {
        primary.push(
          button(
            ctx,
            'kb-btn kb-btn--primary',
            ctx.t(K.cameraTake),
            () => void controller.capture()
          )
        );
        actions.appendChild(primary[0]);
        actions.appendChild(
          button(ctx, 'kb-btn kb-btn--ghost', ctx.t(K.cameraCancel), () => cancel())
        );
      } else if (state.phase === 'captured') {
        primary.push(button(ctx, 'kb-btn kb-btn--primary', ctx.t(K.cameraUse), () => confirm()));
        actions.appendChild(primary[0]);
        actions.appendChild(
          button(
            ctx,
            'kb-btn kb-btn--secondary',
            ctx.t(K.cameraRetake),
            () => void controller.retake()
          )
        );
        actions.appendChild(
          button(ctx, 'kb-btn kb-btn--ghost', ctx.t(K.cameraCancel), () => cancel())
        );
      } else if (state.phase === 'fallback') {
        const pick = el(ctx, 'label', 'kb-btn kb-btn--primary kb-camera__file');
        pick.appendChild(ctx.doc.createTextNode(ctx.t(K.cameraChooseFile)));
        const file = el(ctx, 'input', 'kb-visually-hidden');
        file.setAttribute('type', 'file');
        file.setAttribute('accept', 'image/*');
        file.setAttribute('capture', opts.facing === 'environment' ? 'environment' : 'user');
        if (opts.disabled) file.disabled = true;
        listen(file, 'change', () => {
          const picked = file.files && file.files[0];
          if (picked && fileMatchesAccept(picked, 'image/*')) {
            focusNext = true;
            controller.useFile(picked);
          }
        });
        pick.appendChild(file);
        primary.push(file);
        actions.appendChild(pick);
        if (opts.showCancelInFallback)
          actions.appendChild(
            button(ctx, 'kb-btn kb-btn--ghost', ctx.t(K.cameraCancel), () => cancel())
          );
      }
      if (state.phase === 'idle') actions.appendChild(primary[0]);

      setText(
        notice,
        state.notice === 'unavailable'
          ? ctx.t(K.cameraUnavailable)
          : state.notice === 'denied'
            ? ctx.t(K.cameraDenied)
            : ''
      );
      // Move focus to the new primary control after a user-driven transition;
      // while the camera is starting (primary disabled) keep the request pending.
      if (
        focusNext &&
        primary[0] &&
        !primary[0].disabled &&
        typeof primary[0].focus === 'function'
      ) {
        primary[0].focus();
        focusNext = false;
      } else if (state.phase !== 'starting') {
        focusNext = false;
      }
    };

    const start = () => {
      focusNext = true;
      void controller.start();
    };
    const confirm = () => {
      focusNext = true;
      const photo = controller.confirm();
      if (photo) opts.onConfirm(toFile(photo, 'photo.jpg', ctx.win));
    };
    const cancel = () => {
      focusNext = true;
      controller.cancel();
      if (typeof opts.onCancel === 'function') opts.onCancel();
    };

    sync(controller.state);
    return { stage, actions, notice, start, controller, dispose: () => controller.dispose() };
  };

  const cameraCapture = (ctx, p, c) => {
    const ids = formFieldIds(c.id, p.name);
    const root = fieldRoot(ctx, p, 'camera-capture', 'div', 'kb-camera');
    setData(root, 'state', 'idle');
    root.appendChild(fieldLabel(ctx, p, ids, 'span'));
    if (p.description) root.appendChild(el(ctx, 'p', 'kb-field__description', p.description));
    const action = formAction(p.action, KB_FORM_ACTIONS.cameraCapture);
    const cancelAction = formAction(p.cancel_action, KB_FORM_ACTIONS.cameraCancel);
    const ui = cameraUi(ctx, {
      facing: p.facing,
      aspect: p.aspect,
      disabled: p.disabled === true,
      onPhase: (phase) => root.setAttribute('data-state', phase),
      onConfirm: (file) => dispatch(ctx, c, action, { name: p.name, file }),
      onCancel: () => dispatch(ctx, c, cancelAction, { name: p.name }),
    });
    ui.stage.setAttribute('role', 'group');
    ui.stage.setAttribute('aria-labelledby', ids.label);
    root.appendChild(ui.stage);
    root.appendChild(ui.actions);
    root.appendChild(ui.notice);
    appendHelpAndError(ctx, root, p, ids);
    registerCleanup(ctx, ui.dispose);
    return root;
  };

  // -- avatar --------------------------------------------------------------

  const avatarPicker = (ctx, p, c) => {
    const ids = formFieldIds(c.id, p.name);
    const root = fieldRoot(ctx, p, 'avatar-picker', 'div', 'kb-avatar-picker');
    setData(root, 'state', 'idle');
    root.appendChild(fieldLabel(ctx, p, ids, 'span'));
    const body = el(ctx, 'div', 'kb-avatar-picker__body');
    const frame = el(ctx, 'div', 'kb-avatar-picker__frame');
    setData(frame, 'shape', p.shape === 'square' ? 'square' : 'circle');
    const actions = el(ctx, 'div', 'kb-avatar-picker__actions');
    body.appendChild(frame);
    body.appendChild(actions);
    root.appendChild(body);
    const cameraSlot = el(ctx, 'div', 'kb-avatar-picker__camera');
    root.appendChild(cameraSlot);
    const notice = liveNotice(ctx, 'kb-avatar-picker__notice');
    root.appendChild(notice);
    appendHelpAndError(ctx, root, p, ids);

    const changeAction = formAction(p.action, KB_FORM_ACTIONS.avatarChange);
    const removeAction = formAction(p.remove_action, KB_FORM_ACTIONS.avatarRemove);
    const imageUrl = h.safeHref(p.image_url);
    let pending = null; // { file, url }
    let camera = null;
    let focusNext = false;

    const revokePending = () => {
      if (pending && pending.url && ctx.win && ctx.win.URL)
        ctx.win.URL.revokeObjectURL(pending.url);
      pending = null;
    };
    const closeCamera = () => {
      if (camera) camera.dispose();
      camera = null;
      while (cameraSlot.firstChild) cameraSlot.removeChild(cameraSlot.firstChild);
    };

    const draw = () => {
      while (frame.firstChild) frame.removeChild(frame.firstChild);
      while (actions.firstChild) actions.removeChild(actions.firstChild);
      const state = pending ? 'preview' : camera ? 'camera' : 'idle';
      root.setAttribute('data-state', state);
      const shownUrl = pending ? pending.url : imageUrl;
      if (shownUrl) {
        const img = el(ctx, 'img', 'kb-avatar-picker__image');
        img.setAttribute('src', shownUrl);
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        img.setAttribute('alt', ctx.t(pending ? K.avatarPreviewAlt : K.avatarCurrentAlt));
        frame.appendChild(img);
      } else {
        const empty = el(ctx, 'span', 'kb-avatar-picker__initials');
        empty.setAttribute('role', 'img');
        empty.setAttribute('aria-label', ctx.t(K.avatarEmpty));
        if (typeof p.initials === 'string' && p.initials) {
          const text = el(ctx, 'span', '', p.initials);
          text.setAttribute('aria-hidden', 'true');
          empty.appendChild(text);
        } else {
          const glyph = svgIcon(ctx, 'user', 28);
          if (glyph) empty.appendChild(glyph);
        }
        frame.appendChild(empty);
      }
      let first = null;
      if (state === 'preview') {
        first = button(ctx, 'kb-btn kb-btn--primary', ctx.t(K.avatarUse), () => {
          const file = pending && pending.file;
          revokePending();
          focusNext = true;
          draw();
          if (file) dispatch(ctx, c, changeAction, { name: p.name, file, source: 'upload' });
        });
        actions.appendChild(first);
        actions.appendChild(
          button(ctx, 'kb-btn kb-btn--ghost', ctx.t(K.avatarCancel), () => {
            revokePending();
            focusNext = true;
            draw();
          })
        );
      } else if (state === 'idle') {
        const upload = el(ctx, 'label', 'kb-btn kb-btn--secondary kb-avatar-picker__upload');
        upload.appendChild(ctx.doc.createTextNode(ctx.t(K.avatarUpload)));
        const input = el(ctx, 'input', 'kb-visually-hidden');
        input.setAttribute('type', 'file');
        input.setAttribute('accept', 'image/*');
        input.setAttribute('id', ids.input);
        attr(input, 'aria-describedby', describedBy(ids, p));
        if (p.disabled === true) input.disabled = true;
        listen(input, 'change', () => {
          const file = input.files && input.files[0];
          try {
            input.value = '';
          } catch {
            // harmless
          }
          if (!file) return;
          if (!fileMatchesAccept(file, 'image/*')) {
            setText(notice, ctx.t(K.fileDropRejectType, { file: file.name }));
            return;
          }
          setText(notice, '');
          void cropImageToSquare(file, ctx.doc, ctx.win).then((cropped) => {
            revokePending();
            const url =
              ctx.win && ctx.win.URL && typeof ctx.win.URL.createObjectURL === 'function'
                ? ctx.win.URL.createObjectURL(cropped)
                : null;
            pending = { file: cropped, url };
            focusNext = true;
            draw();
          });
        });
        upload.appendChild(input);
        actions.appendChild(upload);
        first = input;
        if (p.allow_camera !== false) {
          actions.appendChild(
            button(ctx, 'kb-btn kb-btn--secondary', ctx.t(K.avatarTake), () => openCamera(), {
              disabled: p.disabled === true,
            })
          );
        }
        if (p.removable === true && imageUrl) {
          actions.appendChild(
            button(
              ctx,
              'kb-btn kb-btn--ghost',
              ctx.t(K.avatarRemove),
              () => dispatch(ctx, c, removeAction, { name: p.name }),
              { disabled: p.disabled === true }
            )
          );
        }
      }
      if (focusNext && first && typeof first.focus === 'function') first.focus();
      focusNext = false;
    };

    const openCamera = () => {
      closeCamera();
      camera = cameraUi(ctx, {
        facing: 'user',
        aspect: 'square',
        showCancelInFallback: true,
        onConfirm: (file) => {
          closeCamera();
          focusNext = true;
          draw();
          dispatch(ctx, c, changeAction, { name: p.name, file, source: 'camera' });
        },
        onCancel: () => {
          closeCamera();
          focusNext = true;
          draw();
        },
      });
      cameraSlot.appendChild(camera.stage);
      cameraSlot.appendChild(camera.actions);
      cameraSlot.appendChild(camera.notice);
      draw();
      camera.start();
    };

    draw();
    registerCleanup(ctx, () => {
      closeCamera();
      revokePending();
    });
    return root;
  };

  // -- secret --------------------------------------------------------------

  const secretField = (ctx, p, c) => {
    const ids = formFieldIds(c.id, p.name);
    const root = fieldRoot(ctx, p, 'secret-field', 'div', 'kb-secret-field');
    const submitAction = formAction(p.action, 'secret.submit');
    const removeAction = p.remove_action ? formAction(p.remove_action, 'secret.remove') : null;
    const identity = () => {
      const out = { name: p.name };
      if (typeof p.service_id === 'string') out.service_id = p.service_id;
      if (typeof p.secret_key === 'string') out.secret_key = p.secret_key;
      return out;
    };
    let editing = p.configured !== true;
    const notice = liveNotice(ctx, 'kb-secret-field__notice');

    const draw = (focusTarget) => {
      while (root.firstChild) root.removeChild(root.firstChild);
      root.setAttribute(
        'data-state',
        editing ? (p.configured === true ? 'editing' : 'empty') : 'configured'
      );
      let focus = null;
      if (!editing) {
        root.appendChild(fieldLabel(ctx, p, ids, 'span'));
        const summary = el(ctx, 'div', 'kb-secret-field__summary');
        summary.setAttribute('role', 'group');
        summary.setAttribute('aria-labelledby', ids.label);
        const status = el(ctx, 'span', 'kb-secret-field__status');
        status.setAttribute('id', ids.status);
        const glyph = iconWrap(ctx, 'kb-secret-field__icon', 'lock');
        if (glyph) status.appendChild(glyph);
        status.appendChild(ctx.doc.createTextNode(secretStatusText(p, ctx.t)));
        summary.appendChild(status);
        const buttons = el(ctx, 'div', 'kb-secret-field__actions');
        const replace = button(
          ctx,
          'kb-btn kb-btn--secondary',
          ctx.t(K.secretReplace),
          () => {
            editing = true;
            draw('input');
          },
          { disabled: p.disabled === true }
        );
        replace.setAttribute('aria-describedby', ids.status);
        buttons.appendChild(replace);
        if (removeAction) {
          const remove = button(
            ctx,
            'kb-btn kb-btn--ghost',
            ctx.t(K.secretRemove),
            () => dispatch(ctx, c, removeAction, identity()),
            { disabled: p.disabled === true }
          );
          remove.setAttribute('aria-describedby', ids.status);
          buttons.appendChild(remove);
        }
        summary.appendChild(buttons);
        root.appendChild(summary);
        if (focusTarget === 'replace') focus = replace;
      } else {
        root.appendChild(fieldLabel(ctx, p, ids, 'label'));
        const row = el(ctx, 'div', 'kb-secret-field__row');
        const control = el(ctx, 'div', 'kb-secret-field__control');
        const input = el(ctx, 'input', 'kb-input kb-secret-field__input');
        input.setAttribute('type', 'password');
        controlAttrs(input, p, ids);
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('autocorrect', 'off');
        attr(input, 'placeholder', p.placeholder);
        control.appendChild(input);
        const reveal = button(ctx, 'kb-secret-field__toggle', ctx.t(K.secretShow), null, {
          disabled: p.disabled === true,
        });
        reveal.setAttribute('aria-pressed', 'false');
        reveal.setAttribute('aria-controls', ids.input);
        listen(reveal, 'click', () => {
          const show = input.getAttribute('type') === 'password';
          input.setAttribute('type', show ? 'text' : 'password');
          reveal.setAttribute('aria-pressed', show ? 'true' : 'false');
          setText(reveal, ctx.t(show ? K.secretHide : K.secretShow));
        });
        control.appendChild(reveal);
        row.appendChild(control);
        const save = button(
          ctx,
          'kb-btn kb-btn--primary kb-secret-field__save',
          ctx.t(K.secretSave),
          null,
          {
            disabled: true,
          }
        );
        const paste = button(
          ctx,
          'kb-btn kb-btn--secondary kb-secret-field__paste',
          ctx.t(K.secretPaste),
          null,
          {
            disabled: p.disabled === true,
          }
        );
        const refresh = () => {
          save.disabled = p.disabled === true || !input.value;
        };
        const submit = () => {
          const value = input.value;
          if (!value || p.disabled === true) return;
          input.value = '';
          input.setAttribute('type', 'password');
          dispatch(ctx, c, submitAction, { ...identity(), value });
          editing = p.configured !== true;
          draw(editing ? 'input' : 'replace');
          setText(notice, ctx.t(K.secretSubmitted));
        };
        listen(input, 'input', () => {
          setText(notice, '');
          refresh();
        });
        listen(input, 'keydown', (event) => {
          if (event && event.key === 'Enter') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            submit();
          }
        });
        listen(paste, 'click', () => {
          const clipboard = ctx.win && ctx.win.navigator && ctx.win.navigator.clipboard;
          if (!clipboard || typeof clipboard.readText !== 'function') {
            setText(notice, ctx.t(K.secretPasteUnavailable));
            if (typeof input.focus === 'function') input.focus();
            return;
          }
          clipboard.readText().then(
            (text) => {
              input.value = String(text || '').trim();
              refresh();
              if (typeof input.focus === 'function') input.focus();
            },
            () => {
              setText(notice, ctx.t(K.secretPasteUnavailable));
              if (typeof input.focus === 'function') input.focus();
            }
          );
        });
        listen(save, 'click', submit);
        row.appendChild(paste);
        row.appendChild(save);
        if (p.configured === true) {
          row.appendChild(
            button(ctx, 'kb-btn kb-btn--ghost', ctx.t(K.secretCancel), () => {
              input.value = '';
              editing = false;
              draw('replace');
            })
          );
        }
        root.appendChild(row);
        if (focusTarget === 'input') focus = input;
      }
      root.appendChild(notice);
      appendHelpAndError(ctx, root, p, ids);
      if (focus && typeof focus.focus === 'function') focus.focus();
    };
    draw();
    return root;
  };

  // -- settings layout, slider, integration, save bar ----------------------

  return {
    'ui:settings-group'(ctx, p, c, depth) {
      const ids = formFieldIds(c.id, 'group');
      const root = el(ctx, 'section', 'kb-settings-group');
      root.setAttribute('aria-labelledby', ids.title);
      const header = el(ctx, 'header', 'kb-settings-group__header');
      const title = el(ctx, 'h2', 'kb-settings-group__title', p.title);
      title.setAttribute('id', ids.title);
      header.appendChild(title);
      if (p.description)
        header.appendChild(el(ctx, 'p', 'kb-settings-group__description', p.description));
      root.appendChild(header);
      const rows = el(ctx, 'div', 'kb-settings-group__rows');
      h.appendChildren(ctx, rows, c, depth);
      root.appendChild(rows);
      return root;
    },

    'ui:setting-row'(ctx, p, c, depth) {
      const root = el(ctx, 'div', 'kb-setting-row');
      if (p.tone === 'danger') setData(root, 'tone', 'danger');
      const text = el(ctx, 'div', 'kb-setting-row__text');
      text.appendChild(el(ctx, 'p', 'kb-setting-row__label', p.label));
      if (p.description)
        text.appendChild(el(ctx, 'p', 'kb-setting-row__description', p.description));
      root.appendChild(text);
      const control = el(ctx, 'div', 'kb-setting-row__control');
      h.appendChildren(ctx, control, c, depth);
      root.appendChild(control);
      return root;
    },

    'ui:switch'(ctx, p, c) {
      return toggle(ctx, p, c, 'switch');
    },

    'ui:checkbox'(ctx, p, c) {
      return toggle(ctx, p, c, 'checkbox');
    },

    'ui:select'(ctx, p, c) {
      const ids = formFieldIds(c.id, p.name);
      const root = fieldRoot(ctx, p, 'select');
      root.appendChild(fieldLabel(ctx, p, ids, 'label'));
      // Wrapper carries the token-colored chevron (`::after`, see the source
      // CSS); native `<select>` doesn't reliably support pseudo-elements.
      const wrap = el(ctx, 'div', 'kb-select-wrap');
      const select = el(ctx, 'select', 'kb-input kb-select');
      controlAttrs(select, p, ids);
      select.setAttribute('name', String(p.name ?? ''));
      const options = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
      const hasValue = options.some((option) => option.value === p.value);
      if (!hasValue || p.placeholder) {
        const placeholder = el(ctx, 'option', '', p.placeholder || ctx.t(K.selectPlaceholder));
        placeholder.setAttribute('value', '');
        placeholder.disabled = true;
        if (!hasValue) placeholder.selected = true;
        select.appendChild(placeholder);
      }
      for (const option of options) {
        const node = el(ctx, 'option', '', option.label);
        node.setAttribute('value', String(option.value ?? ''));
        if (option.disabled === true) node.disabled = true;
        if (hasValue && option.value === p.value) node.selected = true;
        select.appendChild(node);
      }
      if (hasValue) select.value = String(p.value);
      listen(select, 'change', () => fieldChange(ctx, c, p.name, select.value));
      wrap.appendChild(select);
      root.appendChild(wrap);
      appendHelpAndError(ctx, root, p, ids);
      return root;
    },

    'ui:radio-group'(ctx, p, c) {
      return choiceGroup(ctx, p, c, 'radio-group');
    },

    'ui:segmented'(ctx, p, c) {
      return choiceGroup(ctx, p, c, 'segmented');
    },

    'ui:text-field'(ctx, p, c) {
      return textInput(ctx, p, c, false);
    },

    'ui:textarea'(ctx, p, c) {
      return textInput(ctx, p, c, true);
    },

    'ui:slider'(ctx, p, c) {
      const ids = formFieldIds(c.id, p.name);
      const range = sliderRange(p);
      const root = fieldRoot(ctx, p, 'slider');
      const header = el(ctx, 'div', 'kb-slider__header');
      header.appendChild(fieldLabel(ctx, p, ids, 'label'));
      const output = el(ctx, 'output', 'kb-slider__value', sliderValueText(range.value, p.unit));
      output.setAttribute('for', ids.input);
      output.setAttribute('aria-hidden', 'true');
      header.appendChild(output);
      root.appendChild(header);
      const input = el(ctx, 'input', 'kb-slider');
      input.setAttribute('type', 'range');
      controlAttrs(input, p, ids);
      input.setAttribute('name', String(p.name ?? ''));
      input.setAttribute('min', String(range.min));
      input.setAttribute('max', String(range.max));
      input.setAttribute('step', String(range.step));
      input.setAttribute('aria-valuetext', sliderValueText(range.value, p.unit));
      input.value = String(range.value);
      listen(input, 'input', () => {
        const value = Number(input.value);
        const text = sliderValueText(value, p.unit);
        setText(output, text);
        input.setAttribute('aria-valuetext', text);
        fieldChange(ctx, c, p.name, value);
      });
      root.appendChild(input);
      appendHelpAndError(ctx, root, p, ids);
      return root;
    },

    'ui:integration-item'(ctx, p, c) {
      const state = Object.prototype.hasOwnProperty.call(KB_INTEGRATION_STATES, p.state)
        ? p.state
        : 'disconnected';
      const root = el(ctx, 'div', 'kb-integration');
      setData(root, 'state', state);
      const glyph = iconWrap(
        ctx,
        'kb-integration__icon',
        typeof p.icon === 'string' ? p.icon : 'plug'
      );
      if (glyph) root.appendChild(glyph);
      const body = el(ctx, 'div', 'kb-integration__body');
      const heading = el(ctx, 'div', 'kb-integration__heading');
      heading.appendChild(el(ctx, 'p', 'kb-integration__title', p.title));
      const mapped = KB_INTEGRATION_STATES[state];
      heading.appendChild(h.statusPill(ctx, mapped.status, undefined, ctx.t(mapped.key)));
      body.appendChild(heading);
      if (p.detail) body.appendChild(el(ctx, 'p', 'kb-integration__detail', p.detail));
      if (p.description)
        body.appendChild(el(ctx, 'p', 'kb-integration__description', p.description));
      root.appendChild(body);
      const actions = el(ctx, 'div', 'kb-integration__actions');
      let count = 0;
      for (const ref of Array.isArray(p.actions) ? p.actions : []) {
        const node = h.actionButton(ctx, ref, 'secondary', c);
        if (node) {
          actions.appendChild(node);
          count += 1;
        }
      }
      if (count > 0) root.appendChild(actions);
      return root;
    },

    'ui:save-bar'(ctx, p, c) {
      const state = ['clean', 'dirty', 'saving', 'saved', 'error'].includes(p.state)
        ? p.state
        : 'clean';
      const root = el(ctx, 'div', 'kb-save-bar');
      setData(root, 'state', state);
      root.setAttribute('role', 'region');
      root.setAttribute('aria-label', ctx.t(K.saveBarLabel));
      const message = el(
        ctx,
        'p',
        'kb-save-bar__message',
        p.message || ctx.t(KB_SAVE_BAR_MESSAGE_KEYS[state])
      );
      message.setAttribute('role', 'status');
      root.appendChild(message);
      const actions = el(ctx, 'div', 'kb-save-bar__actions');
      const actionable = state === 'dirty' || state === 'error';
      if (p.discard_action) {
        const discard = h.actionButton(
          ctx,
          {
            label: p.discard_label || ctx.t(K.saveBarDiscard),
            action: p.discard_action,
            variant: 'ghost',
            disabled: !actionable,
          },
          'ghost',
          c
        );
        if (discard) actions.appendChild(discard);
      }
      const save = h.actionButton(
        ctx,
        {
          label: p.save_label || ctx.t(K.saveBarSave),
          action: p.save_action,
          variant: 'primary',
          disabled: !actionable,
        },
        'primary',
        c
      );
      if (save) {
        if (state === 'saving') save.setAttribute('aria-busy', 'true');
        actions.appendChild(save);
      }
      root.appendChild(actions);
      return root;
    },

    'ui:file-drop'(ctx, p, c) {
      return fileDrop(ctx, p, c);
    },

    'ui:camera-capture'(ctx, p, c) {
      return cameraCapture(ctx, p, c);
    },

    'ui:avatar-picker'(ctx, p, c) {
      return avatarPicker(ctx, p, c);
    },

    'ui:secret-field'(ctx, p, c) {
      return secretField(ctx, p, c);
    },
  };
}
