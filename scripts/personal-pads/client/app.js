/*
 * personal-pads browser runtime (PA-04 / PA-07) — served at `/personal-pads/app.js`
 * by `scripts/personal-pads/server.ts` and started by the page's inline module.
 *
 * Built on the shared A2UI kit (`/pad-ui/pad-client.js` → `/shared-ui/kyberion-ui.js`).
 * Adapter field kinds map to `kyberion-base` components:
 *
 *   text / textarea     → ui:text-field / ui:textarea (+ ui:voice-input dictation when
 *                          the field declares `voice_input`; final transcripts are appended)
 *   select              → ui:select
 *   file / image        → ui:file-drop (files listed with size, removable)
 *   recording           → ui:file-drop + ui:voice-input (mode `record`)
 *   drawing             → ui:sketch-board (tools from `drawing_tools`; an `overlay_field`
 *                          image becomes the board background)
 *   actions             → ui:toolbar (button + readiness status) per action
 *   save / clear        → ui:save-bar;   status → ui:callout;   result → ui:code
 *   history             → ui:list / ui:empty-state / ui:skeleton
 *   unsaved changes     → ui:dialog (save / discard / cancel)
 *   plugin views        → nav entry; the server-composed read-only A2UI of the
 *                          approved plugin views of the request scope (PH-03)
 *
 * Render model: `renderA2UI` replaces a whole container, so every field has
 * its own container and only containers whose data changed are re-rendered.
 * Text fields keep their value in `fieldValues` and are never re-rendered
 * while typing; stateful components (sketch board, voice input) are only
 * re-rendered when the pad or record changes.
 *
 * No user-visible text lives here: everything comes from the page bootstrap
 * (`personal_pads:*` vocabulary, the localized adapter contract, `ui` bundle).
 */
/* global window, document, fetch, Element */
import { bootPad, renderPadA2UI, t } from '/pad-ui/pad-client.js';
import { disposeA2UI } from '/shared-ui/kyberion-ui.js';
import {
  FILE_KINDS,
  PAD_ICONS,
  READINESS_TONES,
  TIER_TONES,
  blobToDataUrl,
  dataUrlBytes,
  el,
  fieldComponents,
  fileKeyPattern,
  formatTime,
  interpolate,
  slug,
} from '/personal-pads/support.js';

const T = (key, params) => t(`personal_pads:${key}`, params);

export function startPersonalPads() {
  const { bootstrap } = bootPad({});
  const locale = bootstrap.locale;
  const token = String(bootstrap.token || '');
  const pads = Array.isArray(bootstrap.pads) ? bootstrap.pads : [];
  const adapters = Array.isArray(bootstrap.adapters) ? bootstrap.adapters : [];
  const tiers = Array.isArray(bootstrap.tiers) ? bootstrap.tiers : [];
  const allowedTiers = Array.isArray(bootstrap.allowed_tiers) ? bootstrap.allowed_tiers : [];
  const viewer = String(bootstrap.viewer_principal || '');
  let scope = bootstrap.scope || {};

  const q = (name) => document.querySelector(`[data-pp-${name}]`);
  const H = {
    nav: q('nav'),
    scope: q('scope'),
    padTitle: q('pad-title'),
    padDescription: q('pad-description'),
    workspace: q('workspace'),
    tier: q('tier'),
    fields: q('fields'),
    actions: q('actions'),
    title: q('title'),
    body: q('body'),
    save: q('save'),
    status: q('status'),
    result: q('result'),
    storage: q('storage'),
    historyActions: q('history-actions'),
    history: q('history'),
    historyMore: q('history-more'),
    dialog: q('dialog'),
  };

  // -- state -------------------------------------------------------------------
  const hashPad = /^#pad=([^&]+)/.exec(window.location.hash);
  const requestedPad = hashPad ? decodeURIComponent(hashPad[1]) : '';
  let currentPad = pads.some((pad) => pad.id === requestedPad)
    ? requestedPad
    : (pads[0] && pads[0].id) || '';
  let currentTier = scope.tier;
  let lastTier = currentTier;
  let currentRecordId = '';
  let dirty = false;
  let saveState = 'clean';
  let saving = false;
  let tierSwitching = false;
  let pendingActions = 0;
  let historyRequest = 0;
  let historyCursor = '';
  let historyRows = [];
  let historyLoading = false;
  let tierRequest = 0;
  let actionRequest = 0;
  let fieldGeneration = 0;
  let artifactLoadRequest = 0;
  let pendingFileReads = 0;
  let pendingArtifactReads = 0;
  let draftRevision = 0;
  let fieldValues = {};
  let files = {};
  let boards = {};
  let readiness = {};
  let running = {};
  let title = '';
  let rawBody = '';
  let body = '';
  let artifactFieldRequest = {};
  let artifactPendingByField = {};
  let artifactFailedFields = {};
  let dialogState = null;
  let showingPluginViews = false;
  let pluginViewsRequest = 0;
  const fieldHosts = new Map();
  const actionHosts = new Map();
  const renderedHosts = new Set();

  // PH-03: plugin views replace the workspace (the draft is kept while hidden).
  const pluginPanel = document.createElement('section');
  pluginPanel.hidden = true;
  pluginPanel.setAttribute('data-pp-plugin-views', '');
  if (H.workspace && H.workspace.parentNode)
    H.workspace.parentNode.insertBefore(pluginPanel, H.workspace.nextSibling);

  const selected = () => pads.find((pad) => pad.id === currentPad) || pads[0];
  const adapter = () => adapters.find((item) => item.pad_id === currentPad) || adapters[0];
  const allFields = () => {
    const a = adapter();
    return [...a.fields, ...a.actions.flatMap((action) => action.input_fields || [])];
  };
  const fieldById = (id) => allFields().find((field) => field.id === id);

  function render(host, components, onAction) {
    if (!host) return;
    renderedHosts.add(host);
    renderPadA2UI(host, components, { onAction });
  }

  function disposeHost(host) {
    if (!host) return;
    disposeA2UI(host);
    renderedHosts.delete(host);
  }

  function api(path, options = {}) {
    const url = `${path}${path.includes('?') ? '&' : '?'}lang=${encodeURIComponent(locale)}`;
    const init = Object.assign({}, options, {
      headers: Object.assign(
        { 'X-Pads-Token': token, 'Content-Type': 'application/json' },
        options.headers || {}
      ),
    });
    return fetch(url, init).then((response) =>
      response.json().then((payload) => {
        if (!response.ok) throw new Error((payload && payload.error) || T('request_failed'));
        return payload;
      })
    );
  }

  // -- artifact bookkeeping (a pending restore must never overwrite user edits) --
  function invalidateArtifactField(fieldId) {
    const pending = artifactPendingByField[fieldId] || 0;
    const failed = artifactFailedFields[fieldId] ? 1 : 0;
    pendingArtifactReads = Math.max(0, pendingArtifactReads - pending - failed);
    artifactPendingByField[fieldId] = 0;
    artifactFieldRequest[fieldId] = (artifactFieldRequest[fieldId] || 0) + 1;
    delete artifactFailedFields[fieldId];
    return artifactFieldRequest[fieldId];
  }
  function beginArtifactField(fieldId, count) {
    const request = invalidateArtifactField(fieldId);
    artifactPendingByField[fieldId] = count;
    pendingArtifactReads += count;
    return request;
  }
  function finishArtifactField(fieldId, request) {
    if (artifactFieldRequest[fieldId] !== request) return;
    const pending = artifactPendingByField[fieldId] || 0;
    if (pending > 0) {
      artifactPendingByField[fieldId] = pending - 1;
      pendingArtifactReads = Math.max(0, pendingArtifactReads - 1);
    }
  }

  // -- status / result / save bar ------------------------------------------------
  function say(message, tone = 'info') {
    render(
      H.status,
      message ? [{ id: 'pp-status', type: 'ui:callout', props: { tone, title: message } }] : []
    );
  }

  function showActionResult(result) {
    const details = result && result.result;
    const text =
      details && typeof details.markdown === 'string'
        ? details.markdown
        : details
          ? JSON.stringify(details, null, 2)
          : '';
    render(
      H.result,
      text
        ? [{ id: 'pp-result', type: 'ui:code', props: { title: T('result_title'), code: text } }]
        : []
    );
  }

  function renderSaveBar() {
    render(
      H.save,
      [
        {
          id: 'pp-save',
          type: 'ui:save-bar',
          props: {
            state: saving ? 'saving' : saveState,
            save_action: 'pp.save',
            discard_action: 'pp.clear',
            save_label: T('save'),
            discard_label: T('clear_draft'),
          },
        },
      ],
      (action) => {
        if (action.id === 'pp.save') void save();
        else if (action.id === 'pp.clear') clearDraft();
      }
    );
  }

  function markDirty() {
    draftRevision += 1;
    if (!dirty || saveState !== 'dirty') {
      dirty = true;
      saveState = 'dirty';
      renderSaveBar();
    }
  }

  function storageLabel() {
    if (currentTier === 'personal') return T('storage_personal');
    if (currentTier === 'confidential') return T('storage_confidential');
    return T('storage_public', { pad: selected().label });
  }

  function renderStorage() {
    render(H.storage, [
      {
        id: 'pp-storage',
        type: 'ui:text',
        props: { variant: 'caption', text: T('storage_note', { label: storageLabel() }) },
      },
    ]);
  }

  // -- chrome: nav, scope chips, tier, pad heading ------------------------------
  function renderNav() {
    render(
      H.nav,
      [
        {
          id: 'pp-nav',
          type: 'ui:nav-rail',
          props: {
            label: T('nav_label'),
            items: pads
              .map((pad) => ({
                id: pad.id,
                label: pad.label,
                hint: pad.description,
                icon: PAD_ICONS[pad.id],
                // A real link (open in a new tab works); a plain click selects in place.
                href: `#pad=${encodeURIComponent(pad.id)}`,
                action: { id: 'pp.pad.select', payload: { pad: pad.id } },
                active: !showingPluginViews && pad.id === currentPad,
              }))
              .concat([
                {
                  id: 'pp-plugin-views',
                  label: T('plugin_views_title'),
                  href: '#plugin-views',
                  action: { id: 'pp.plugin-views.open' },
                  active: showingPluginViews,
                },
              ]),
          },
        },
      ],
      (action) => {
        if (action.id === 'pp.pad.select' && action.payload) selectPad(action.payload.pad);
        else if (action.id === 'pp.plugin-views.open') openPluginViews();
      }
    );
  }

  // -- plugin views (read-only; actions are approved in Chronos) -------------------
  function renderPluginViews(payload) {
    const composed =
      payload && payload.a2ui && payload.a2ui.updateComponents
        ? payload.a2ui.updateComponents.components || []
        : [];
    const referenced = new Set(composed.flatMap((component) => component.children || []));
    const roots = composed.filter((component) => !referenced.has(component.id));
    const body = composed.length
      ? [
          {
            id: 'pp-plugin-views-note',
            type: 'ui:text',
            props: { variant: 'caption', text: T('plugin_view_action_in_chronos') },
          },
        ].concat(composed)
      : [
          {
            id: 'pp-plugin-views-empty',
            type: 'ui:empty-state',
            props: { title: T('plugin_views_empty') },
          },
        ];
    render(
      pluginPanel,
      [
        {
          id: 'pp-plugin-views',
          type: 'ui:section',
          props: { title: T('plugin_views_title') },
          children: [body[0].id].concat(composed.length ? roots.map((c) => c.id) : []),
        },
      ].concat(body)
    );
  }

  function loadPluginViews() {
    const request = ++pluginViewsRequest;
    render(pluginPanel, [
      { id: 'pp-plugin-views-loading', type: 'ui:skeleton', props: { lines: 3 } },
    ]);
    api(`/api/plugin-views?tier=${encodeURIComponent(currentTier)}`)
      .then((payload) => {
        if (request !== pluginViewsRequest || !showingPluginViews) return;
        renderPluginViews(payload);
      })
      .catch((error) => {
        if (request !== pluginViewsRequest || !showingPluginViews) return;
        render(pluginPanel, [
          {
            id: 'pp-plugin-views-error',
            type: 'ui:callout',
            props: { tone: 'danger', title: error.message },
          },
        ]);
      });
  }

  function showPluginPanel(visible) {
    showingPluginViews = visible;
    pluginPanel.hidden = !visible;
    if (H.workspace) H.workspace.hidden = visible;
    if (!visible) {
      pluginViewsRequest += 1;
      disposeHost(pluginPanel);
    }
    renderNav();
  }

  function openPluginViews() {
    if (tierSwitching) return;
    if (!showingPluginViews) showPluginPanel(true);
    loadPluginViews();
  }

  function renderScope() {
    render(H.scope, [
      {
        id: 'pp-scope-tenant',
        type: 'ui:badge',
        props: { label: T('scope_tenant', { tenant: scope.tenant_slug || 'public' }) },
      },
      {
        id: 'pp-scope-tier',
        type: 'ui:badge',
        props: { label: T('scope_tier', { tier: scope.tier }), tone: TIER_TONES[scope.tier] },
      },
      { id: 'pp-scope-viewer', type: 'ui:badge', props: { label: T('scope_viewer', { viewer }) } },
    ]);
  }

  function renderTier() {
    render(
      H.tier,
      [
        {
          id: 'pp-tier',
          type: 'ui:select',
          props: {
            name: 'tier',
            label: T('tier_label'),
            value: currentTier,
            disabled: tierSwitching,
            options: tiers.map((tier) => ({
              value: tier,
              label: T(`tier_${tier}`),
              disabled: !allowedTiers.includes(tier),
            })),
          },
        },
      ],
      (action) => {
        if (action.id === 'field.change') requestTier(String(action.payload.value || ''));
      }
    );
  }

  function renderPadHead() {
    const pad = selected();
    if (H.padTitle) H.padTitle.textContent = pad ? pad.label : '';
    if (H.padDescription) H.padDescription.textContent = pad ? pad.description : '';
  }

  // -- title / body --------------------------------------------------------------
  function renderTitle() {
    render(
      H.title,
      [
        {
          id: 'pp-title',
          type: 'ui:text-field',
          props: {
            name: 'title',
            label: T('title_label'),
            placeholder: T('title_placeholder'),
            maxlength: 200,
            value: title,
          },
        },
      ],
      (action) => {
        if (action.id !== 'field.change' || tierSwitching) return;
        title = String(action.payload.value || '');
        markDirty();
      }
    );
  }

  function renderBody() {
    const composed = adapter().body_mode === 'composed';
    render(
      H.body,
      [
        {
          id: 'pp-body',
          type: 'ui:textarea',
          props: {
            name: 'body',
            label: T(composed ? 'body_label_composed' : 'body_label'),
            placeholder: T(composed ? 'body_placeholder_composed' : 'body_placeholder'),
            value: body,
            readonly: composed,
            rows: 8,
          },
        },
      ],
      (action) => {
        if (action.id !== 'field.change' || tierSwitching || composed) return;
        body = String(action.payload.value || '');
        rawBody = body;
        markDirty();
      }
    );
  }

  /** Recompose the saved body; composed pads show it read-only (re-rendered, never focused). */
  function updatePreview() {
    const a = adapter();
    const values = Object.assign({}, fieldValues);
    for (const field of allFields()) {
      if (field.kind === 'drawing' && String(values[field.id] || '').startsWith('data:')) {
        values[field.id] = a.drawing_marker;
      }
    }
    values.body = a.body_mode === 'composed' ? rawBody : body;
    if (a.body_mode === 'composed') {
      body = interpolate(a.preview_template, values);
      renderBody();
    }
  }

  // -- files ----------------------------------------------------------------------
  /** Mirror `files[fieldId]` into the adapter's `{id}`, `{id}_name_{i}`, `{id}_data[_{i}]` keys. */
  function syncFileKeys(fieldId) {
    const pattern = fileKeyPattern(fieldId);
    for (const key of Object.keys(fieldValues)) if (pattern.test(key)) delete fieldValues[key];
    const entries = (files[fieldId] || []).filter(Boolean);
    files[fieldId] = entries;
    if (!entries.length) return;
    fieldValues[fieldId] = entries.map((entry) => entry.name).join('\n');
    entries.forEach((entry, index) => {
      fieldValues[`${fieldId}_name_${index}`] = entry.name;
      if (entry.data)
        fieldValues[index === 0 ? `${fieldId}_data` : `${fieldId}_data_${index}`] = entry.data;
    });
  }

  function fileListProps(fieldId) {
    return (files[fieldId] || []).map((entry, index) => ({
      id: String(index),
      name: entry.name,
      size: entry.size,
      status: entry.data ? 'ready' : 'queued',
    }));
  }

  function overlayBoardsFor(imageFieldId) {
    return adapter().fields.filter(
      (field) => field.kind === 'drawing' && field.overlay_field === imageFieldId
    );
  }

  /** Re-sync one file field; `restored` = the change came from a history artifact. */
  function fileChanged(fieldId, restored = false) {
    syncFileKeys(fieldId);
    renderField(fieldId);
    for (const board of overlayBoardsFor(fieldId)) {
      const state = boards[board.id];
      // A new screenshot (not a restored one) starts a new annotation: the
      // restored drawing (it carries the old screenshot) is cleared.
      if (state && !restored && (state.restoredData || state.restoredLoaded)) {
        state.restoredData = '';
        if (state.restoredLoaded && state.controller) state.controller.clear();
        state.restoredLoaded = false;
        state.strokes = 0;
        exportBoard(board);
      }
      applyBackground(board);
    }
    updatePreview();
  }

  function readFileList(field, list, generation = fieldGeneration) {
    const fieldId = field.id;
    const incoming = Array.from(list || []).filter(Boolean);
    if (!incoming.length) return;
    const append =
      field.multiple === true && !(artifactPendingByField[fieldId] > 0) && !!files[fieldId];
    const fieldRequest = invalidateArtifactField(fieldId);
    const added = incoming.map((file) => ({ name: file.name, size: file.size, data: '' }));
    files[fieldId] = append ? [...files[fieldId], ...added] : added;
    markDirty();
    fileChanged(fieldId);
    added.forEach((entry, index) => {
      pendingFileReads += 1;
      blobToDataUrl(incoming[index])
        .then((data) => {
          if (generation !== fieldGeneration || artifactFieldRequest[fieldId] !== fieldRequest)
            return;
          entry.data = data;
          fileChanged(fieldId);
        })
        .catch(() => {
          if (generation === fieldGeneration && artifactFieldRequest[fieldId] === fieldRequest)
            say(T('status_attachment_read_failed'), 'danger');
        })
        .finally(() => {
          if (generation === fieldGeneration) pendingFileReads = Math.max(0, pendingFileReads - 1);
        });
    });
  }

  function removeFile(field, fileId) {
    const entries = files[field.id] || [];
    const index = Number(fileId);
    if (!Number.isInteger(index) || !entries[index]) return;
    invalidateArtifactField(field.id);
    entries.splice(index, 1);
    markDirty();
    fileChanged(field.id);
  }

  function takeRecording(field, file) {
    const generation = fieldGeneration;
    if (!file || !file.size) {
      say(T('status_recording_read_failed'), 'warning');
      return;
    }
    pendingFileReads += 1;
    blobToDataUrl(file)
      .then((data) => {
        if (generation !== fieldGeneration) return;
        const mime = file.type || 'audio/webm';
        const name = `recording-${Date.now()}${mime.includes('mp4') ? '.m4a' : '.webm'}`;
        invalidateArtifactField(field.id);
        files[field.id] = [{ name, size: file.size, data }];
        markDirty();
        fileChanged(field.id);
        say(T('status_recording_captured'), 'success');
      })
      .catch(() => {
        if (generation === fieldGeneration) say(T('status_recording_read_failed'), 'danger');
      })
      .finally(() => {
        if (generation === fieldGeneration) pendingFileReads = Math.max(0, pendingFileReads - 1);
      });
  }

  // -- sketch boards ------------------------------------------------------------------
  function exportBoard(field) {
    const board = boards[field.id];
    if (!board || !board.controller) return;
    const generation = fieldGeneration;
    const sequence = ++board.exportSeq;
    if (board.strokes <= 0) {
      delete fieldValues[field.id];
      updatePreview();
      return;
    }
    pendingFileReads += 1;
    board.controller
      .toBlob()
      .then(blobToDataUrl)
      .then((data) => {
        if (generation !== fieldGeneration || sequence !== board.exportSeq) return;
        fieldValues[field.id] = data;
        updatePreview();
      })
      .catch(() => {
        if (generation === fieldGeneration) say(T('status_drawing_export_failed'), 'danger');
      })
      .finally(() => {
        if (generation === fieldGeneration) pendingFileReads = Math.max(0, pendingFileReads - 1);
      });
  }

  /** Background = the overlay image (screenshot) of the board, if any. */
  function applyBackground(field) {
    const board = boards[field.id];
    if (!board || !board.controller) return;
    const image = field.overlay_field ? fieldValues[`${field.overlay_field}_data`] : '';
    const sequence = ++board.backgroundSeq;
    board.controller
      .setBackgroundImage(image || null)
      .then((ok) => {
        if (ok && sequence === board.backgroundSeq && board.strokes > 0) exportBoard(field);
      })
      .catch(() => say(T('status_attachment_read_failed'), 'danger'));
  }

  /** A saved drawing goes into the board's drawing layer (undoable, removed by Clear). */
  function restoreDrawing(field) {
    const board = boards[field.id];
    if (!board || !board.controller || !board.restoredData || board.restoredLoaded) return;
    board.restoredLoaded = true;
    board.restoring = true;
    board.controller
      .loadImage(board.restoredData, { layer: 'drawing' })
      .then((ok) => {
        if (!ok) say(T('status_attachment_read_failed'), 'danger');
      })
      .finally(() => {
        board.restoring = false;
      });
  }

  function onBoardAction(field, action) {
    const board = boards[field.id];
    const payload = action.payload || {};
    if (!board || payload.name !== board.name) return;
    if (action.id === 'drawing.ready') {
      board.controller = payload.controller;
      if (field.overlay_field) applyBackground(field);
      restoreDrawing(field);
    } else if (action.id === 'drawing.change' && typeof payload.strokes === 'number') {
      board.strokes = payload.strokes;
      // Loading a saved drawing is not an edit (the stored value stays as is).
      if (board.restoring) return;
      if (payload.strokes === 0) board.restoredData = '';
      markDirty();
      exportBoard(field);
    } else if (action.id === 'drawing.background' && field.overlay_field) {
      const imageField = fieldById(field.overlay_field);
      if (imageField && payload.file) readFileList(imageField, [payload.file]);
    }
  }

  // -- field rendering ----------------------------------------------------------------
  function onFieldAction(field, action) {
    if (tierSwitching) return;
    const payload = action.payload || {};
    if (field.kind === 'drawing') {
      onBoardAction(field, action);
    } else if (action.id === 'field.change') {
      fieldValues[field.id] = String(payload.value === undefined ? '' : payload.value);
      markDirty();
      updatePreview();
    } else if (action.id === 'file.add') {
      readFileList(field, payload.files);
    } else if (action.id === 'file.remove') {
      removeFile(field, payload.file_id);
    }
  }

  function renderField(fieldId) {
    const entry = fieldHosts.get(fieldId);
    if (!entry) return;
    if (entry.field.kind === 'drawing') {
      boards[fieldId] = {
        name: entry.field.id,
        controller: null,
        strokes: 0,
        restoring: false,
        restoredLoaded: false,
        restoredData: boards[fieldId] ? boards[fieldId].restoredData : '',
        exportSeq: 0,
        backgroundSeq: 0,
      };
    }
    const value = fieldValues[fieldId] === undefined ? '' : String(fieldValues[fieldId]);
    render(entry.host, fieldComponents(entry.field, value, fileListProps(fieldId)), (action) =>
      onFieldAction(entry.field, action)
    );
  }

  function appendVoiceTranscript(field, text) {
    const current = fieldValues[field.id] ? String(fieldValues[field.id]) : '';
    fieldValues[field.id] = current ? `${current} ${text}` : text;
    renderField(field.id);
    markDirty();
    updatePreview();
  }

  function buildFieldHost(field) {
    const wrap = el('div', 'pp-field');
    wrap.setAttribute('data-pp-field', field.id);
    const host = el('div');
    wrap.appendChild(host);
    const entry = { field, host, extra: [] };
    fieldHosts.set(field.id, entry);
    const generation = fieldGeneration;
    if (field.voice_input && (field.kind === 'text' || field.kind === 'textarea')) {
      const voiceHost = el('div');
      wrap.appendChild(voiceHost);
      entry.extra.push(voiceHost);
      render(
        voiceHost,
        [
          {
            id: `pp-v-${slug(field.id)}`,
            type: 'ui:voice-input',
            props: {
              name: field.id,
              mode: 'dictation',
              // Visually part of the field above; the hidden label names both.
              label: `${field.voice_input.label} · ${field.label}`,
              hide_label: true,
              continuous: true,
            },
          },
        ],
        (action) => {
          const payload = action.payload || {};
          if (generation !== fieldGeneration || tierSwitching) return;
          if (action.id === 'voice.transcript' && payload.final === true && payload.text)
            appendVoiceTranscript(field, String(payload.text));
        }
      );
    }
    if (field.kind === 'recording') {
      const recordHost = el('div');
      wrap.appendChild(recordHost);
      entry.extra.push(recordHost);
      render(
        recordHost,
        [
          {
            id: `pp-r-${slug(field.id)}`,
            type: 'ui:voice-input',
            props: { name: field.id, mode: 'record', label: T('record_in_browser') },
          },
        ],
        (action) => {
          const payload = action.payload || {};
          if (generation !== fieldGeneration || tierSwitching) return;
          if (action.id === 'voice.recording' && payload.final === true)
            takeRecording(field, payload.file);
        }
      );
    }
    renderField(field.id);
    return wrap;
  }

  // -- actions ----------------------------------------------------------------------------
  function renderActionBar(actionId) {
    const host = actionHosts.get(actionId);
    const action = adapter().actions.find((item) => item.id === actionId);
    if (!host || !action) return;
    const state = readiness[actionId];
    render(
      host,
      [
        {
          id: `pp-a-${slug(action.id)}-description`,
          type: 'ui:text',
          props: { variant: 'muted', text: action.description },
        },
        {
          id: `pp-a-${slug(action.id)}`,
          type: 'ui:toolbar',
          props: {
            label: action.label,
            density: 'compact',
            items: [
              {
                type: 'button',
                id: action.id,
                label: action.label,
                variant: 'secondary',
                disabled: running[action.id] === true,
              },
              {
                type: 'status',
                text: state ? state.message || state.status : T('action_checking'),
                tone: (state && READINESS_TONES[state.status]) || 'neutral',
              },
            ],
          },
        },
      ],
      (event) => {
        if (event.id === 'toolbar.click' && event.payload) runAction(String(event.payload.id));
      }
    );
  }

  function wireActionReadiness() {
    const padAt = currentPad;
    const tierAt = currentTier;
    api(`/api/action-readiness?pad=${encodeURIComponent(padAt)}&tier=${encodeURIComponent(tierAt)}`)
      .then((payload) => {
        if (padAt !== currentPad || tierAt !== currentTier || tierSwitching) return;
        for (const item of payload.actions || []) {
          readiness[item.action_id] = item;
          renderActionBar(item.action_id);
        }
      })
      .catch(() => {
        if (padAt !== currentPad || tierAt !== currentTier || tierSwitching) return;
        for (const action of adapter().actions) {
          readiness[action.id] = { status: 'unknown', message: T('action_check_on_click') };
          renderActionBar(action.id);
        }
      });
  }

  function applyDraftPatch(patch) {
    if (!patch) return;
    const values = patch.fields || {};
    const touchedFiles = new Set();
    for (const key of Object.keys(values)) {
      const value = String(values[key] === undefined || values[key] === null ? '' : values[key]);
      const dataKey = /^(.*)_data(?:_(\d+))?$/.exec(key);
      const dataField = dataKey ? fieldById(dataKey[1]) : undefined;
      if (dataField && FILE_KINDS.has(dataField.kind)) {
        const index = dataKey[2] ? Number(dataKey[2]) : 0;
        const entries = files[dataField.id] || (files[dataField.id] = []);
        entries[index] = Object.assign(entries[index] || { name: `${dataField.id}-${index + 1}` }, {
          data: value,
          size: dataUrlBytes(value),
        });
        touchedFiles.add(dataField.id);
        continue;
      }
      const field = fieldById(key);
      if (field && FILE_KINDS.has(field.kind)) {
        const entries = files[key] || (files[key] = []);
        value
          .split('\n')
          .filter(Boolean)
          .forEach((name, index) => {
            entries[index] = Object.assign(entries[index] || { size: 0, data: '' }, { name });
          });
        touchedFiles.add(key);
        continue;
      }
      fieldValues[key] = value;
      if (field && field.kind !== 'drawing') renderField(key);
    }
    for (const fieldId of touchedFiles) {
      invalidateArtifactField(fieldId);
      fileChanged(fieldId);
    }
    if (typeof patch.title === 'string') {
      title = patch.title;
      renderTitle();
    }
    if (typeof patch.body === 'string') {
      rawBody = patch.body;
      body = patch.body;
      renderBody();
    }
    markDirty();
    updatePreview();
  }

  function runAction(actionId) {
    if (tierSwitching || saving || pendingFileReads > 0 || pendingArtifactReads > 0) {
      say(T('status_wait_busy'), 'warning');
      return;
    }
    const action = adapter().actions.find((item) => item.id === actionId);
    if (!action) return;
    const padAt = currentPad;
    const tierAt = currentTier;
    const revisionAt = draftRevision;
    const recordAt = currentRecordId;
    const request = ++actionRequest;
    pendingActions += 1;
    running[actionId] = true;
    renderActionBar(actionId);
    say(T('status_action_running', { label: action.label }), 'info');
    api(`/api/action?tier=${encodeURIComponent(tierAt)}`, {
      method: 'POST',
      body: JSON.stringify({
        pad_id: padAt,
        action_id: actionId,
        tier: tierAt,
        title,
        body,
        fields: Object.assign({}, fieldValues),
        record_id: recordAt || undefined,
      }),
    })
      .then((result) => {
        if (
          request !== actionRequest ||
          padAt !== currentPad ||
          tierAt !== currentTier ||
          revisionAt !== draftRevision ||
          tierSwitching
        )
          return;
        if (result.status === 'unavailable') {
          say(result.message || T('status_action_unavailable'), 'warning');
          showActionResult(result);
          return;
        }
        applyDraftPatch(result.draft_patch);
        say(
          result.message || T('status_action_done'),
          result.status === 'approval_required' ? 'warning' : 'success'
        );
        showActionResult(result);
      })
      .catch((error) => {
        if (
          request === actionRequest &&
          padAt === currentPad &&
          tierAt === currentTier &&
          !tierSwitching
        )
          say(T('status_action_failed', { error: error.message }), 'danger');
      })
      .finally(() => {
        pendingActions = Math.max(0, pendingActions - 1);
        running[actionId] = false;
        if (padAt === currentPad) renderActionBar(actionId);
      });
  }

  // -- editor assembly -------------------------------------------------------------------
  function disposeEditor() {
    for (const entry of fieldHosts.values()) {
      disposeHost(entry.host);
      entry.extra.forEach(disposeHost);
    }
    for (const host of actionHosts.values()) disposeHost(host);
    fieldHosts.clear();
    actionHosts.clear();
    boards = {};
    if (H.fields) H.fields.replaceChildren();
    if (H.actions) H.actions.replaceChildren();
  }

  function renderEditor() {
    disposeEditor();
    const a = adapter();
    for (const field of a.fields) H.fields.appendChild(buildFieldHost(field));
    for (const action of a.actions) {
      const group = el('div', 'pp-action');
      group.setAttribute('data-pp-action', action.id);
      for (const field of action.input_fields || []) group.appendChild(buildFieldHost(field));
      const bar = el('div');
      group.appendChild(bar);
      actionHosts.set(action.id, bar);
      renderActionBar(action.id);
      H.actions.appendChild(group);
    }
  }

  /** Selects start on their first option, like a native `<select>` without a value. */
  function initSelectDefaults() {
    for (const field of allFields()) {
      if (field.kind === 'select' && field.options && field.options.length)
        fieldValues[field.id] = String(field.options[0].value);
    }
  }

  function renderPad() {
    fieldGeneration += 1;
    artifactLoadRequest += 1;
    pendingFileReads = 0;
    pendingArtifactReads = 0;
    artifactFieldRequest = {};
    artifactPendingByField = {};
    artifactFailedFields = {};
    actionRequest += 1;
    draftRevision += 1;
    currentRecordId = '';
    fieldValues = {};
    files = {};
    readiness = {};
    running = {};
    title = '';
    rawBody = '';
    body = '';
    dirty = false;
    saveState = 'clean';
    initSelectDefaults();
    say('');
    renderNav();
    renderPadHead();
    renderStorage();
    renderEditor();
    renderTitle();
    renderSaveBar();
    showActionResult(null);
    renderBody();
    wireActionReadiness();
    updatePreview();
    loadHistory(true);
  }

  // -- history ----------------------------------------------------------------------------
  function historyItem(record) {
    const preview = String(record.body || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
    const attachments =
      Array.isArray(record.artifact_refs) && record.artifact_refs.length
        ? T('history_attachments', { count: record.artifact_refs.length })
        : '';
    return {
      title: record.title || selected().label,
      meta: [
        preview || T('history_saved_record'),
        attachments,
        formatTime(record.created_at, locale),
      ]
        .filter(Boolean)
        .join(' · '),
      action: { id: 'pp.record.open', payload: { record: record.record_id } },
    };
  }

  function renderHistory() {
    let components;
    if (historyLoading && !historyRows.length)
      components = [{ id: 'pp-history-loading', type: 'ui:skeleton', props: { lines: 3 } }];
    else if (!historyRows.length)
      components = [
        {
          id: 'pp-history-empty',
          type: 'ui:empty-state',
          props: { title: T('history_empty'), body: T('history_empty_body') },
        },
      ];
    else
      components = [
        { id: 'pp-history-list', type: 'ui:list', props: { items: historyRows.map(historyItem) } },
      ];
    render(H.history, components, (action) => {
      if (action.id === 'pp.record.open' && action.payload) openRecord(action.payload.record);
    });
    render(
      H.historyMore,
      historyCursor
        ? [
            {
              id: 'pp-history-more',
              type: 'ui:button',
              props: { label: T('history_more'), action: 'pp.history.more', variant: 'secondary' },
            },
          ]
        : [],
      (action) => {
        if (action.id === 'pp.history.more' && !tierSwitching) loadHistory(false);
      }
    );
  }

  function loadHistory(reset) {
    if (tierSwitching) return;
    const request = ++historyRequest;
    const padAt = currentPad;
    const tierAt = currentTier;
    if (reset !== false) {
      historyCursor = '';
      historyRows = [];
      historyLoading = true;
      renderHistory();
    }
    const cursor =
      reset === false && historyCursor ? `&cursor=${encodeURIComponent(historyCursor)}` : '';
    api(`/api/history?pad=${encodeURIComponent(padAt)}&tier=${encodeURIComponent(tierAt)}${cursor}`)
      .then((payload) => {
        if (
          request !== historyRequest ||
          padAt !== currentPad ||
          tierAt !== currentTier ||
          tierSwitching
        )
          return;
        const rows = payload.records || [];
        historyRows = reset !== false ? rows : historyRows.concat(rows);
        historyCursor = payload.next_cursor || '';
        historyLoading = false;
        renderHistory();
      })
      .catch((error) => {
        if (request !== historyRequest || tierSwitching) return;
        historyLoading = false;
        renderHistory();
        say(error.message, 'danger');
      });
  }

  function restoreArtifacts(record) {
    const refs = record.artifact_refs || [];
    const padAt = currentPad;
    const tierAt = currentTier;
    const load = artifactLoadRequest;
    const counts = {};
    const indexes = {};
    const tokens = {};
    refs.forEach((ref) => {
      counts[ref.field_id] = (counts[ref.field_id] || 0) + 1;
    });
    Object.keys(counts).forEach((fieldId) => {
      tokens[fieldId] = beginArtifactField(fieldId, counts[fieldId]);
    });
    refs.forEach((ref) => {
      const index = indexes[ref.field_id] || 0;
      indexes[ref.field_id] = index + 1;
      const fieldToken = tokens[ref.field_id];
      api(
        `/api/history/${encodeURIComponent(record.record_id)}?pad=${encodeURIComponent(padAt)}&tier=${encodeURIComponent(tierAt)}&artifact=${encodeURIComponent(ref.artifact_id)}`
      )
        .then((payload) => {
          if (
            load !== artifactLoadRequest ||
            padAt !== currentPad ||
            tierAt !== currentTier ||
            artifactFieldRequest[ref.field_id] !== fieldToken
          )
            return;
          const data = `data:${payload.artifact.ref.mime || 'application/octet-stream'};base64,${payload.artifact.data_base64}`;
          const field = fieldById(ref.field_id);
          if (!field) return;
          if (field.kind === 'drawing') {
            fieldValues[field.id] = data;
            fieldValues[`${field.id}_name_${index}`] = ref.name;
            const board = boards[field.id];
            if (board) {
              if (board.restoredLoaded && board.controller) board.controller.clear();
              board.restoredData = data;
              board.restoredLoaded = false;
              restoreDrawing(field);
            }
          } else {
            const entries = files[field.id] || (files[field.id] = []);
            entries[index] = Object.assign(entries[index] || { name: ref.name }, {
              data,
              size: ref.bytes || dataUrlBytes(data),
            });
            fileChanged(field.id, true);
          }
          updatePreview();
        })
        .catch((error) => {
          if (
            load === artifactLoadRequest &&
            padAt === currentPad &&
            tierAt === currentTier &&
            artifactFieldRequest[ref.field_id] === fieldToken
          ) {
            if (!artifactFailedFields[ref.field_id]) {
              artifactFailedFields[ref.field_id] = true;
              pendingArtifactReads += 1;
            }
            say(T('status_attachment_load_failed', { error: error.message }), 'danger');
          }
        })
        .finally(() => finishArtifactField(ref.field_id, fieldToken));
    });
  }

  function restoreRecord(record) {
    currentRecordId = record.record_id || '';
    const refs = Array.isArray(record.artifact_refs) ? record.artifact_refs : [];
    fieldValues = {};
    files = {};
    for (const [key, value] of Object.entries(record.payload || {})) {
      if (typeof value !== 'string') continue;
      const dataKey = /^(.*)_data(?:_\d+)?$/.exec(key);
      const field = fieldById(key) || (dataKey ? fieldById(dataKey[1]) : undefined);
      // Binary values come back through the managed artifacts (the payload copy may be truncated).
      if (
        field &&
        (FILE_KINDS.has(field.kind) || field.kind === 'drawing') &&
        value.startsWith('data:')
      )
        continue;
      fieldValues[key] = value;
    }
    for (const field of allFields()) {
      if (!FILE_KINDS.has(field.kind)) continue;
      const own = refs.filter((ref) => ref.field_id === field.id);
      if (own.length)
        files[field.id] = own.map((ref) => ({ name: ref.name, size: ref.bytes, data: '' }));
      syncFileKeys(field.id);
    }
    title = record.title || '';
    rawBody = fieldValues.body || '';
    body = adapter().body_mode === 'freeform' ? rawBody : record.body || '';
    renderEditor();
    renderTitle();
    renderBody();
    updatePreview();
    markDirty();
    say(T('status_restored'), 'info');
    restoreArtifacts(record);
  }

  function openRecord(recordId) {
    if (tierSwitching || saving || pendingArtifactReads > 0) {
      say(T('status_wait_history'), 'warning');
      return;
    }
    guard(() => {
      const padAt = currentPad;
      const tierAt = currentTier;
      api(
        `/api/history/${encodeURIComponent(recordId)}?pad=${encodeURIComponent(padAt)}&tier=${encodeURIComponent(tierAt)}`
      )
        .then((payload) => {
          if (padAt === currentPad && tierAt === currentTier && !tierSwitching)
            restoreRecord(payload.record);
        })
        .catch((error) => say(error.message, 'danger'));
    });
  }

  // -- save / clear -----------------------------------------------------------------------
  function save() {
    if (saving || tierSwitching || pendingActions > 0) return Promise.resolve(false);
    if (pendingFileReads > 0 || pendingArtifactReads > 0) {
      say(T('status_loading_attachments'), 'info');
      return Promise.resolve(false);
    }
    const savePad = currentPad;
    const saveTier = currentTier;
    const saveRevision = draftRevision;
    updatePreview();
    const saveBody = body;
    if (!saveBody.trim()) {
      say(T('status_need_content'), 'warning');
      return Promise.resolve(false);
    }
    saving = true;
    renderSaveBar();
    say(T('status_saving'), 'info');
    return api(`/api/capture?tier=${encodeURIComponent(saveTier)}`, {
      method: 'POST',
      body: JSON.stringify({
        pad_id: savePad,
        tier: saveTier,
        title,
        body: saveBody,
        fields: Object.assign({}, fieldValues),
      }),
    })
      .then((payload) => {
        saving = false;
        const id = payload.record.record_id;
        if (savePad !== currentPad || saveTier !== currentTier || saveRevision !== draftRevision) {
          renderSaveBar();
          loadHistory(true);
          say(T('status_saved_kept', { id }), 'success');
          return false;
        }
        dirty = false;
        renderPad();
        saveState = 'saved';
        renderSaveBar();
        say(T('status_saved', { id }), 'success');
        return true;
      })
      .catch((error) => {
        saving = false;
        saveState = 'error';
        renderSaveBar();
        say(T('status_save_failed', { error: error.message }), 'danger');
        return false;
      });
  }

  function clearDraft() {
    if (saving || tierSwitching || pendingActions > 0) return;
    dirty = false;
    renderPad();
    say(T('status_cleared'), 'info');
  }

  // -- unsaved-changes dialog -----------------------------------------------------------------
  function renderDialog(open) {
    render(
      H.dialog,
      [
        {
          id: 'pp-unsaved',
          type: 'ui:dialog',
          props: {
            open,
            title: T('dialog_unsaved_title'),
            message: T('dialog_unsaved_message'),
            choices: [
              { id: 'cancel', label: T('dialog_cancel'), variant: 'secondary' },
              { id: 'save', label: T('dialog_save'), variant: 'primary' },
              { id: 'discard', label: T('dialog_discard'), variant: 'danger' },
            ],
          },
        },
      ],
      (action) => {
        const state = dialogState;
        dialogState = null;
        renderDialog(false);
        if (!state) return;
        const choice =
          action.id === 'dialog.confirm' && action.payload ? action.payload.choice : 'cancel';
        if (choice === 'discard') {
          dirty = false;
          state.proceed();
        } else if (choice === 'save') {
          void save().then((ok) => (ok ? state.proceed() : state.cancel()));
        } else {
          state.cancel();
        }
      }
    );
  }

  /** Run `proceed` now, or after the user resolves unsaved changes; `cancel` otherwise. */
  function guard(proceed, cancel = () => {}) {
    if (tierSwitching || saving || pendingActions > 0) {
      say(T('status_wait_switch'), 'warning');
      cancel();
      return;
    }
    if (!dirty) {
      proceed();
      return;
    }
    dialogState = { proceed, cancel };
    renderDialog(true);
  }

  // -- pad / tier switching -----------------------------------------------------------------
  function selectPad(padId) {
    if (!pads.some((pad) => pad.id === padId)) return;
    if (padId === currentPad) {
      if (showingPluginViews) showPluginPanel(false);
      return;
    }
    if (showingPluginViews) showPluginPanel(false);
    guard(() => {
      currentPad = padId;
      dirty = false;
      if (window.history && typeof window.history.replaceState === 'function')
        window.history.replaceState(null, '', `#pad=${encodeURIComponent(padId)}`);
      renderPad();
    });
  }

  function setScopeSwitching(active) {
    tierSwitching = active;
    for (const node of [H.workspace, H.nav, pluginPanel]) {
      if (!node) continue;
      node.inert = active;
      if (active) node.setAttribute('aria-busy', 'true');
      else node.removeAttribute('aria-busy');
    }
    renderTier();
  }

  function requestTier(requested) {
    if (!requested || requested === currentTier) return;
    if (tierSwitching) {
      renderTier();
      return;
    }
    guard(
      () => {
        const previous = lastTier;
        const request = ++tierRequest;
        setScopeSwitching(true);
        api(`/api/context?tier=${encodeURIComponent(requested)}`)
          .then((payload) => {
            if (request !== tierRequest) return;
            currentTier = requested;
            lastTier = requested;
            scope = payload.scope || scope;
            dirty = false;
            setScopeSwitching(false);
            renderScope();
            renderPad();
            if (showingPluginViews) loadPluginViews();
          })
          .catch((error) => {
            if (request !== tierRequest) return;
            currentTier = previous;
            setScopeSwitching(false);
            say(error.message, 'danger');
          });
      },
      () => renderTier()
    );
  }

  // -- wiring -------------------------------------------------------------------------------
  document.addEventListener('paste', (event) => {
    if (event.defaultPrevented || tierSwitching) return;
    const field = adapter().fields.find((item) => item.kind === 'image' && item.paste_drop);
    const pasted = Array.from((event.clipboardData && event.clipboardData.files) || []).filter(
      (file) => /^image\//i.test(file.type || '')
    );
    if (!field || !pasted.length) return;
    event.preventDefault();
    readFileList(field, [pasted[0]]);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  render(
    H.historyActions,
    [
      {
        id: 'pp-history-refresh',
        type: 'ui:button',
        props: { label: T('history_refresh'), action: 'pp.history.refresh', variant: 'ghost' },
      },
    ],
    (action) => {
      if (action.id === 'pp.history.refresh' && !tierSwitching) loadHistory(true);
    }
  );
  renderScope();
  renderTier();
  renderDialog(false);
  renderPad();

  return {
    /** Test / automation hook: read-only snapshot of the draft state. */
    snapshot: () => ({
      pad: currentPad,
      tier: currentTier,
      dirty,
      saving,
      pendingFileReads,
      pendingArtifactReads,
      fields: Object.assign({}, fieldValues),
      title,
      body,
      rendered: renderedHosts.size,
    }),
  };
}
