/*
 * Kyberion UI — form constants and pure helpers (UI-01c,
 * SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §3.3).
 *
 * Renderer-independent: message keys, action ids, field ids, file screening,
 * byte / slider formatting and the secret-field outcome notice. Re-exported by
 * `forms.js` (the public module both renderers import); nothing here touches
 * the DOM.
 */

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
  secretPending: 'ui:secret_pending',
  secretSaved: 'ui:secret_saved',
  secretError: 'ui:secret_error',
});

/** Host-reported outcome of a `ui:secret-field` submit (`status` prop). */
export const KB_SECRET_FIELD_STATUSES = Object.freeze(['idle', 'pending', 'error', 'saved']);

/** `ui:save-bar` default message per state. */
export const KB_SAVE_BAR_MESSAGE_KEYS = Object.freeze({
  clean: 'ui:save_bar_clean',
  dirty: 'ui:save_bar_dirty',
  saving: 'ui:save_bar_saving',
  saved: 'ui:save_bar_saved',
  error: 'ui:save_bar_error',
});

/**
 * `ui:file-drop` entry status label keys. `ready`: read locally, attached to
 * the page, not uploaded yet (sent later with the pad's own action).
 */
export const KB_FILE_STATUS_MESSAGE_KEYS = Object.freeze({
  queued: 'ui:file_status_queued',
  ready: 'ui:file_status_ready',
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

/** The host's `status` prop of a secret field, normalised (`idle` when absent/unknown). */
export function secretFieldHostStatus(p) {
  return typeof p.status === 'string' && KB_SECRET_FIELD_STATUSES.includes(p.status)
    ? p.status
    : 'idle';
}

/**
 * The outcome notice of a secret field. The HOST owns the outcome: a submit
 * only hands the value to `onAction`, so the field says "sending" until the
 * host sets `status` to `saved` or `error` — it never claims success itself.
 *
 * `local` is the field's own last event and the host status it happened
 * under: after `submitted` the notice stays pending, and after `dismissed`
 * (the user typed again) it stays empty, until the host status changes.
 * `status_error` replaces the generic error text.
 * @returns {{ status: 'idle' | 'pending' | 'error' | 'saved', text: string }}
 */
export function secretFieldNotice(p, local, t) {
  const host = secretFieldHostStatus(p);
  let status = host;
  if (local && local.under === host) status = local.kind === 'submitted' ? 'pending' : 'idle';
  if (status === 'idle') return { status, text: '' };
  if (status === 'error') {
    const reason = typeof p.status_error === 'string' ? p.status_error.trim() : '';
    return { status, text: reason || t(KB_FORM_MESSAGE_KEYS.secretError) };
  }
  return {
    status,
    text: t(
      status === 'saved' ? KB_FORM_MESSAGE_KEYS.secretSaved : KB_FORM_MESSAGE_KEYS.secretPending
    ),
  };
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
