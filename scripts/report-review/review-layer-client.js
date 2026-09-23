/*
 * review-layer-client.js — browser side of the report-review layer (PA-05).
 * `review-layer.ts` inlines this file as the layer's `<script type="module">`,
 * next to `#rv-layer-data` (locale, vocabulary, scoped kit CSS and — for
 * offline documents — the kit modules).
 *
 * The layer lives in the shadow root of the `kb-review-layer` host (#rv-bar), so the
 * host report's CSS never reaches it and the kit CSS never leaks into the
 * report. Components (each in its own container):
 *   toolbar  ui:toolbar      edit / comment / list toggles, restore, exports,
 *                            save (only with window.__RV_SAVE__), discard, status
 *   comments ui:section + ui:list  (or ui:text when empty)
 *   dialog   ui:dialog       restore / discard confirmations, comment editor
 *                            (input.multiline) with a ui:voice-input child
 *                            (the dialog's content slot; its focus trap and
 *                            shadow-root focus handling come from the kit)
 *
 * Kit loading: `assets: "served"` imports the renderer from this page's
 * origin (never relative to the report's `<base href>`); `assets: "inline"`
 * turns the bundled module sources into blob: modules (dependencies first,
 * relative imports rewritten), so a stamped file works from file:// with no
 * server. Document serialization (export / save / local snapshot) removes the
 * layer and the save config by their comment markers, never by string search.
 * Local snapshots are keyed by the layer's `reportId` (`rvedit:<id>`); the
 * pre-id key `rvedit:<pathname>` is only read where the pathname names this
 * report (file:// stamps), never for a server root shared by every report.
 * No user-visible text lives here.
 */
/* global document, window, localStorage, location, Blob, URL, Node, NodeFilter */
const LAYER_MARKERS = ['RV-LAYER', '/RV-LAYER'];
const SAVE_CONFIG_MARKERS = ['RV-SAVE-CONFIG', '/RV-SAVE-CONFIG'];
const THEME_KEY = 'kyberion.ui.theme';

/** The pads' theme choice: the shared `kb-ui-theme` cookie, else local storage. */
function storedTheme() {
  try {
    const match = /(?:^|;\s*)kb-ui-theme=(light|dark|system)(?:;|$)/.exec(document.cookie || '');
    if (match) return match[1];
  } catch {
    // cookies unavailable (file://)
  }
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    // storage unavailable (file://, privacy mode): follow the OS scheme
    return null;
  }
}

function readLayerData() {
  const node = document.getElementById('rv-layer-data');
  try {
    const value = node ? JSON.parse(node.textContent || '{}') : {};
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * The absolute URL of a same-origin module path (`/shared-ui/…`), resolved
 * against `loc.origin` — not the document base, which a report's
 * `<base href>` may point at another origin. null for anything else.
 */
export function sameOriginModuleUrl(value, loc) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  if (!loc || typeof loc.origin !== 'string' || !/^https?:\/\//.test(loc.origin)) return null;
  let url;
  try {
    url = new URL(value, loc.origin);
  } catch {
    return null;
  }
  return url.origin === loc.origin ? url.href : null;
}

/** Snapshot storage keys: `rvedit:<reportId>`, plus the legacy key where it is per-report. */
export function snapshotKeys(data, loc) {
  const pathname = loc && typeof loc.pathname === 'string' ? loc.pathname : '';
  const id = typeof data.reportId === 'string' && /^[a-f0-9]{8,64}$/.test(data.reportId);
  const legacy = pathname && pathname !== '/' ? `rvedit:${pathname}` : null;
  if (!id) return { key: legacy || 'rvedit:/', legacy: null };
  return { key: `rvedit:${data.reportId}`, legacy };
}

/** Import the kit: the served renderer, or the bundled sources as blob: modules. */
async function loadKit(data) {
  if (data.assets === 'served') {
    const url = sameOriginModuleUrl(data.renderer, window.location);
    if (!url) throw new Error('review layer: renderer must be a same-origin path');
    return import(url);
  }
  const modules = Array.isArray(data.modules) ? data.modules : [];
  const urls = new Map();
  for (const module of modules) {
    let source = String(module.source || '');
    for (const dep of module.deps || []) {
      const url = urls.get(dep);
      if (!url) throw new Error(`review layer: module ${dep} is missing`);
      source = source.split(`${data.placeholder}${dep}`).join(url);
    }
    urls.set(module.name, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  }
  const entry = urls.get(data.entry);
  if (!entry) throw new Error('review layer: renderer module is missing');
  return import(entry);
}

/** Comment-marker regions (`<!--NAME-->…<!--/NAME-->`) under `root`, as node lists. */
function markerRegions(root, markers) {
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const regions = [];
  let node = walker.nextNode();
  while (node) {
    if (node.data === markers[0]) {
      const region = [node];
      let next = node.nextSibling;
      while (next && !(next.nodeType === Node.COMMENT_NODE && next.data === markers[1])) {
        region.push(next);
        next = next.nextSibling;
      }
      if (next) region.push(next);
      regions.push(region);
    }
    node = walker.nextNode();
  }
  return regions;
}

function removeRegions(root, markers) {
  for (const region of markerRegions(root, markers)) {
    for (const node of region) if (node.parentNode) node.parentNode.removeChild(node);
  }
}

async function start() {
  const data = readLayerData();
  const hostEl = document.getElementById('rv-bar');
  if (!hostEl || hostEl.shadowRoot) return;
  const kit = await loadKit(data);
  const texts = Object.assign({}, data.messages || {}, data.texts || {});
  const t = kit.createTranslator({ messages: texts });
  const locale = typeof data.locale === 'string' ? data.locale : 'en';
  const selector = typeof data.contentSelector === 'string' ? data.contentSelector : '.wrap';
  const content = document.querySelector(selector) || document.body;
  const keys = snapshotKeys(data, location);
  const storageKey = keys.key;
  const readSnapshot = () => {
    try {
      return localStorage.getItem(storageKey) || (keys.legacy && localStorage.getItem(keys.legacy));
    } catch {
      return null;
    }
  };
  const saveConfig = window.__RV_SAVE__;

  // -- shadow root --------------------------------------------------------
  const theme = storedTheme();
  if (theme === 'light' || theme === 'dark') hostEl.setAttribute('data-theme', theme);
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = String(data.css || '');
  shadow.appendChild(style);
  const root = document.createElement('div');
  root.className = 'rv-root';
  root.setAttribute('data-density', 'compact');
  root.setAttribute('lang', locale);
  const boxes = {};
  for (const name of ['toolbar', 'comments', 'dialog']) {
    boxes[name] = document.createElement('div');
    boxes[name].className = `rv-${name}`;
    root.appendChild(boxes[name]);
  }
  boxes.comments.hidden = true;
  shadow.appendChild(root);

  // -- state --------------------------------------------------------------
  let editing = false;
  let commenting = false;
  let listOpen = false;
  let dialog = null; // { kind: 'restore' | 'discard' | 'comment', range?, anchor? }
  let status = { text: '', tone: 'neutral' };

  const render = (box, components) =>
    kit.renderA2UI(box, components, {
      locale,
      messages: data.messages || {},
      onAction: handleAction,
    });

  function now() {
    try {
      return new Date().toLocaleString(locale);
    } catch {
      return new Date().toLocaleString();
    }
  }

  function renderToolbar() {
    const active = shadow.activeElement;
    const focusedId =
      active && boxes.toolbar.contains(active) ? active.getAttribute('data-item-id') : null;
    const items = [
      { type: 'toggle', id: 'edit', icon: '✏️', label: t('report_review:edit'), pressed: editing },
      {
        type: 'toggle',
        id: 'comment',
        icon: '💬',
        label: t('report_review:comment'),
        pressed: commenting,
      },
      { type: 'toggle', id: 'list', icon: '🗂', label: t('report_review:list'), pressed: listOpen },
      { type: 'separator' },
      { type: 'button', id: 'restore', icon: '↺', label: t('report_review:restore') },
      { type: 'button', id: 'export-html', icon: '⤓', label: t('report_review:export_html') },
      { type: 'button', id: 'export-md', icon: '⤓', label: t('report_review:export_md') },
    ];
    if (saveConfig) {
      items.push({
        type: 'button',
        id: 'save',
        icon: '💾',
        label: t('report_review:save'),
        variant: 'primary',
      });
    }
    items.push({ type: 'button', id: 'discard', icon: '🗑', label: t('report_review:discard') });
    if (status.text) {
      items.push({ type: 'status', id: 'status', text: status.text, tone: status.tone });
    }
    render(boxes.toolbar, [
      {
        id: 'rv-toolbar',
        type: 'ui:toolbar',
        props: { label: t('report_review:toolbar_label'), density: 'compact', items },
      },
    ]);
    if (focusedId) focusToolbarItem(focusedId);
  }

  function focusToolbarItem(id) {
    const button = boxes.toolbar.querySelector(`[data-item-id="${id}"]`);
    if (button && !button.disabled) button.focus();
  }

  function setStatus(text, tone) {
    status = { text, tone: tone || 'neutral' };
    renderToolbar();
  }

  function commentMarks() {
    return Array.from(content.querySelectorAll('mark.rv-cmt'));
  }

  function markAnchor(mark) {
    return (mark.getAttribute('data-anchor') || mark.textContent || '').trim();
  }

  function renderComments() {
    boxes.comments.hidden = !listOpen;
    if (!listOpen) {
      render(boxes.comments, []);
      return;
    }
    const marks = commentMarks();
    const body = marks.length
      ? {
          id: 'rv-comment-list',
          type: 'ui:list',
          props: {
            items: marks.slice(0, 200).map((mark, index) => ({
              title: (mark.getAttribute('data-note') || '—').slice(0, 200),
              meta: t('report_review:comment_item_meta', {
                index: index + 1,
                anchor: markAnchor(mark).slice(0, 80),
              }),
            })),
          },
        }
      : {
          id: 'rv-comment-list',
          type: 'ui:text',
          props: { text: t('report_review:no_comments'), variant: 'muted' },
        };
    render(boxes.comments, [
      {
        id: 'rv-comments',
        type: 'ui:section',
        props: { title: t('report_review:comments_title') },
        children: ['rv-comment-list'],
      },
      body,
    ]);
  }

  function dialogProps() {
    if (!dialog) return { open: false, title: t('report_review:comment_dialog_title') };
    if (dialog.kind === 'comment') {
      return {
        open: true,
        title: t('report_review:comment_dialog_title'),
        message: t('report_review:comment_dialog_message', { anchor: dialog.anchor }),
        input: {
          name: 'note',
          label: t('report_review:comment_label'),
          placeholder: t('report_review:note_placeholder'),
          multiline: true,
        },
        confirm_label: t('report_review:register'),
        cancel_label: t('report_review:cancel'),
      };
    }
    if (dialog.kind === 'restore') {
      return {
        open: true,
        title: t('report_review:restore_title'),
        message: t('report_review:restore_confirm'),
        confirm_label: t('report_review:restore'),
        cancel_label: t('report_review:cancel'),
      };
    }
    return {
      open: true,
      tone: 'danger',
      title: t('report_review:discard_title'),
      message: t('report_review:discard_confirm'),
      confirm_label: t('report_review:discard'),
      cancel_label: t('report_review:cancel'),
    };
  }

  function renderDialog() {
    const components = [{ id: 'rv-dialog', type: 'ui:dialog', props: dialogProps() }];
    if (dialog && dialog.kind === 'comment') {
      components[0].children = ['rv-voice'];
      components.push({
        id: 'rv-voice',
        type: 'ui:voice-input',
        props: {
          name: 'note-voice',
          label: t('report_review:comment_voice_label'),
          mode: 'dictation',
          continuous: true,
          show_transcript: true,
          help: t('report_review:dictation_note'),
        },
      });
    }
    render(boxes.dialog, components);
  }

  function openDialog(next, returnToolbarId) {
    dialog = Object.assign({ returnToolbarId: returnToolbarId || null }, next);
    renderDialog();
  }

  function closeDialog() {
    const returnId = dialog && dialog.returnToolbarId;
    dialog = null;
    renderDialog();
    if (returnId) Promise.resolve().then(() => focusToolbarItem(returnId));
  }

  // -- document helpers ---------------------------------------------------
  function contentSnapshot() {
    const clone = content.cloneNode(true);
    removeRegions(clone, LAYER_MARKERS);
    return clone.innerHTML;
  }

  function replaceContent(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    removeRegions(template.content, LAYER_MARKERS);
    const layer = markerRegions(content, LAYER_MARKERS).flat();
    const kept = new Set(layer.filter((node) => node.parentNode === content));
    for (const node of Array.from(content.childNodes)) {
      if (!kept.has(node)) content.removeChild(node);
    }
    const anchor = layer.find((node) => kept.has(node)) || null;
    content.insertBefore(template.content, anchor);
  }

  /** The document as HTML: never the save config; the layer only when it is self-contained. */
  function documentHtml(keepLayer) {
    const clone = document.documentElement.cloneNode(true);
    removeRegions(clone, SAVE_CONFIG_MARKERS);
    if (!keepLayer) removeRegions(clone, LAYER_MARKERS);
    const layerHost = clone.querySelector('#rv-bar');
    if (layerHost) layerHost.removeAttribute('data-theme');
    const cloneBody = clone.querySelector('body');
    if (cloneBody) cloneBody.classList.remove('rv-editing');
    const editable = clone.querySelector(selector) || cloneBody;
    if (editable) editable.removeAttribute('contenteditable');
    if (cloneBody && cloneBody.getAttribute('class') === '') cloneBody.removeAttribute('class');
    return `<!doctype html>\n${clone.outerHTML}`;
  }

  function saveLocal() {
    try {
      localStorage.setItem(storageKey, contentSnapshot());
      setStatus(t('report_review:saved', { time: now() }), 'success');
    } catch (error) {
      setStatus(t('report_review:save_failed', { error: error.message }), 'danger');
    }
  }

  function slug() {
    return (
      (document.title || 'report')
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'report'
    );
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function download(text, mime, name) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    shadow.appendChild(link);
    link.click();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      link.remove();
    }, 1500);
  }

  function setEditing(value) {
    editing = value;
    content.contentEditable = editing ? 'true' : 'false';
    if (!editing) content.removeAttribute('contenteditable');
    document.body.classList.toggle('rv-editing', editing);
    setStatus(t(editing ? 'report_review:edit_on' : 'report_review:edit_off'), 'info');
    if (!editing) saveLocal();
  }

  function exportMarkdown() {
    const marks = commentMarks();
    let md = `# ${t('report_review:markdown_title', { title: document.title })}\n\n${t('report_review:generated')}: ${now()}\n\n`;
    if (!marks.length) md += `${t('report_review:md_empty')}\n`;
    marks.forEach((mark, index) => {
      md += `## #${index + 1}\n- ${t('report_review:target')}: ${markAnchor(mark)}\n- ${t('report_review:comment_label')}: ${mark.getAttribute('data-note') || ''}\n\n`;
    });
    download(md, 'text/markdown;charset=utf-8', `${slug()}-comments-${stamp()}.md`);
    setStatus(t('report_review:md_exported'), 'success');
  }

  function saveToFile() {
    setStatus(t('report_review:saving'), 'info');
    fetch(saveConfig.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', 'x-rv-token': saveConfig.token },
      body: documentHtml(false),
    })
      .then((response) => response.text().then((text) => ({ ok: response.ok, text })))
      .then((result) =>
        result.ok
          ? setStatus(t('report_review:saved_to_file', { time: now() }), 'success')
          : setStatus(t('report_review:save_failed', { error: result.text }), 'danger')
      )
      .catch((error) =>
        setStatus(t('report_review:save_failed', { error: error.message }), 'danger')
      );
  }

  function addComment(note) {
    const range = dialog && dialog.range;
    const anchor = (dialog && dialog.anchor) || '';
    if (!range) return;
    const mark = document.createElement('mark');
    mark.className = 'rv-cmt';
    mark.setAttribute('data-note', note);
    mark.title = note;
    try {
      range.surroundContents(mark);
    } catch {
      mark.setAttribute('data-anchor', anchor);
      mark.textContent = '⚑';
      try {
        range.insertNode(mark);
      } catch {
        // the selection vanished; nothing to anchor to
      }
    }
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }

  // -- actions ------------------------------------------------------------
  function handleAction(action) {
    const payload = (action && action.payload) || {};
    switch (action && action.id) {
      case 'toolbar.toggle':
        if (payload.id === 'edit') setEditing(payload.pressed === true);
        else if (payload.id === 'comment') {
          commenting = payload.pressed === true;
          setStatus(t(commenting ? 'report_review:comment_on' : 'report_review:comment_off'));
        } else if (payload.id === 'list') {
          listOpen = payload.pressed === true;
          renderComments();
        }
        break;
      case 'toolbar.click':
        handleClick(payload.id);
        break;
      case 'dialog.confirm':
        handleConfirm(payload);
        break;
      case 'dialog.cancel':
        closeDialog();
        break;
      case 'voice.transcript':
        if (payload.final && dialog && dialog.kind === 'comment') {
          const field = boxes.dialog.querySelector('textarea');
          const text = String(payload.text || '').trim();
          if (field && text) field.value = field.value ? `${field.value} ${text}` : text;
        }
        break;
      default:
        break;
    }
  }

  function handleClick(id) {
    if (id === 'restore') {
      const saved = readSnapshot();
      if (!saved) setStatus(t('report_review:no_restore'), 'warning');
      else openDialog({ kind: 'restore' }, id);
    } else if (id === 'discard') {
      openDialog({ kind: 'discard' }, id);
    } else if (id === 'export-html') {
      download(
        documentHtml(data.assets !== 'served'),
        'text/html;charset=utf-8',
        `${slug()}-edited-${stamp()}.html`
      );
      setStatus(t('report_review:html_exported'), 'success');
    } else if (id === 'export-md') {
      exportMarkdown();
    } else if (id === 'save' && saveConfig) {
      saveToFile();
    }
  }

  function handleConfirm(payload) {
    if (!dialog) return;
    if (dialog.kind === 'comment') {
      const note = String(payload.value || '').trim();
      if (!note) {
        const field = boxes.dialog.querySelector('textarea');
        if (field) field.focus();
        return;
      }
      addComment(note);
      closeDialog();
      if (listOpen) renderComments();
      saveLocal();
      return;
    }
    if (dialog.kind === 'restore') {
      const saved = readSnapshot();
      closeDialog();
      if (saved) {
        replaceContent(saved);
        if (listOpen) renderComments();
        setStatus(t('report_review:restored', { time: now() }), 'success');
      }
      return;
    }
    closeDialog();
    try {
      localStorage.removeItem(storageKey);
      if (keys.legacy) localStorage.removeItem(keys.legacy);
    } catch {
      // nothing stored
    }
    setStatus(t('report_review:discarded'), 'success');
  }

  // Events from inside the layer are retargeted to its host; they are not edits.
  const fromLayer = (event) =>
    typeof event.composedPath === 'function' && event.composedPath().includes(hostEl);
  content.addEventListener('input', (event) => {
    if (editing && !fromLayer(event)) saveLocal();
  });
  content.addEventListener('mouseup', (event) => {
    if (!commenting || dialog || fromLayer(event)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const text = selection.toString().trim();
    if (!text) return;
    openDialog({
      kind: 'comment',
      range: selection.getRangeAt(0).cloneRange(),
      anchor: text.slice(0, 80),
    });
  });

  const hasSaved = Boolean(readSnapshot());
  status = {
    text: t(hasSaved ? 'report_review:previous_edit' : 'report_review:review_available'),
    tone: 'neutral',
  };
  renderToolbar();
  renderComments();
  renderDialog();
}

// Only in a browser document (tests import the pure helpers above).
if (typeof document !== 'undefined')
  start().catch(() => {
    // The report stays readable without the layer (e.g. a browser that refuses
    // blob: modules for file://); mark the host so the failure is inspectable.
    const hostEl = document.getElementById('rv-bar');
    if (hostEl) hostEl.setAttribute('data-state', 'unavailable');
  });
