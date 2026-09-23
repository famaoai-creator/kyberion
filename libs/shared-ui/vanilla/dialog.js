/*
 * Kyberion UI — `ui:dialog` (PA-01, PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §3):
 * the in-page replacement for `window.confirm()` / `window.prompt()`.
 *
 * Controlled by `open`. Closed, it renders an empty `div.kb-dialog[hidden]`
 * (the same in both renderers). Open: backdrop + `role=dialog` (or
 * `alertdialog` for `tone: danger`) with `aria-modal`, labelled by the title
 * and described by the message; initial focus on the input (else the primary
 * button); Tab / Shift+Tab stay inside; Escape = cancel; Enter in a
 * single-line input confirms. After the user closes it, focus returns to the
 * element that was focused when it opened (if it is still in the document).
 *
 * `children` (A2UI child ids) render inside the panel body, between the
 * message / input and the buttons (`.kb-dialog__content`); the focus trap
 * cycles through every focusable control in the panel, children included.
 *
 * Shadow DOM: the focused element is read from the panel's (or the render
 * container's) root node — `ShadowRoot.activeElement` inside a shadow tree,
 * where `document.activeElement` would only be the shadow host.
 *
 * `buildDialogDom` is reused by `ui:sketch-board` (clear confirmation); the
 * pure model helpers are shared with the React `Dialog`.
 */

/** Mirrors `KB_DIALOG_ACTIONS` in libs/core/a2ui-catalog.ts (pinned by tests). */
export const KB_DIALOG_ACTIONS = Object.freeze({
  confirm: 'dialog.confirm',
  cancel: 'dialog.cancel',
});

/** Vocabulary keys (`ui:*`) of the dialog default strings. */
export const KB_DIALOG_MESSAGE_KEYS = Object.freeze({
  confirm: 'ui:dialog_confirm',
  cancel: 'ui:dialog_cancel',
});

const VARIANTS = ['primary', 'secondary', 'danger', 'ghost'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Deterministic DOM ids (from the A2UI component id). */
export function dialogIds(componentId) {
  const raw = typeof componentId === 'string' && componentId ? componentId : 'dialog';
  const base = `kbdlg-${raw.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return { root: base, title: `${base}-title`, message: `${base}-message`, input: `${base}-input` };
}

/**
 * Renderer-independent view model. `buttons` is the action row in order:
 * the props' `choices`, else Cancel + Confirm. Exactly one button (or the
 * input) is the initial focus target.
 */
export function dialogModel(p, t) {
  const record = isRecord(p) ? p : {};
  const danger = record.tone === 'danger';
  const inputProps = isRecord(record.input) ? record.input : null;
  const input =
    inputProps && text(inputProps.name) && text(inputProps.label)
      ? {
          name: text(inputProps.name),
          label: text(inputProps.label),
          placeholder: text(inputProps.placeholder),
          value: text(inputProps.value),
          multiline: inputProps.multiline === true,
        }
      : null;
  const choices = Array.isArray(record.choices)
    ? record.choices.filter((choice) => isRecord(choice) && text(choice.id) && text(choice.label))
    : [];
  let buttons;
  if (choices.length > 0) {
    const primaryIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.variant === 'primary' || choice.variant === 'danger')
    );
    buttons = choices.map((choice, index) => ({
      kind: 'choice',
      choice: text(choice.id),
      label: text(choice.label),
      variant: VARIANTS.includes(choice.variant) ? choice.variant : 'secondary',
      primary: index === primaryIndex,
    }));
  } else {
    buttons = [
      {
        kind: 'cancel',
        choice: '',
        label: text(record.cancel_label) || t(KB_DIALOG_MESSAGE_KEYS.cancel),
        variant: 'secondary',
        primary: false,
      },
      {
        kind: 'confirm',
        choice: '',
        label: text(record.confirm_label) || t(KB_DIALOG_MESSAGE_KEYS.confirm),
        variant: danger ? 'danger' : 'primary',
        primary: true,
      },
    ];
  }
  return {
    open: record.open === true,
    title: text(record.title),
    message: text(record.message),
    danger,
    role: danger ? 'alertdialog' : 'dialog',
    input,
    buttons,
  };
}

/** Resolve an action ref (`{ id, payload? }` or id string) with a default id. */
export function dialogAction(action, fallback) {
  if (typeof action === 'string' && action) return { id: action, payload: undefined };
  if (isRecord(action) && typeof action.id === 'string' && action.id) {
    return { id: action.id, payload: isRecord(action.payload) ? action.payload : undefined };
  }
  return { id: fallback, payload: undefined };
}

/**
 * The action a button press dispatches: Cancel → `cancel_action`
 * (`{}`); Confirm / a choice → `action` with `{ choice?, value? }`.
 */
export function dialogResult(p, model, button, value) {
  const record = isRecord(p) ? p : {};
  if (button.kind === 'cancel') {
    const action = dialogAction(record.cancel_action, KB_DIALOG_ACTIONS.cancel);
    return { id: action.id, payload: { ...(action.payload || {}) } };
  }
  const action = dialogAction(record.action, KB_DIALOG_ACTIONS.confirm);
  const runtime = {};
  if (button.kind === 'choice') runtime.choice = button.choice;
  if (model.input) runtime.value = typeof value === 'string' ? value : '';
  return { id: action.id, payload: { ...(action.payload || {}), ...runtime } };
}

/** Escape's action: `cancel_action` (`{}`). */
export function dialogCancelResult(p) {
  const record = isRecord(p) ? p : {};
  const action = dialogAction(record.cancel_action, KB_DIALOG_ACTIONS.cancel);
  return { id: action.id, payload: { ...(action.payload || {}) } };
}

/**
 * Focus-trap step: the element Tab / Shift+Tab should move to (wrapping at
 * the ends of `focusables`), or null to let the browser move focus.
 */
export function dialogTrapTarget(focusables, active, shiftKey) {
  const list = focusables.filter(Boolean);
  if (list.length === 0) return null;
  const index = list.indexOf(active);
  if (shiftKey) return index <= 0 ? list[list.length - 1] : null;
  return index === -1 || index === list.length - 1 ? list[0] : null;
}

const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A']);

function isFocusableNode(node) {
  const tag = String(node.tagName || '').toUpperCase();
  const tabindex = typeof node.getAttribute === 'function' ? node.getAttribute('tabindex') : null;
  if (tabindex !== null && tabindex !== undefined && Number(tabindex) < 0) return false;
  if (node.disabled === true) return false;
  if (tag === 'INPUT' && String(node.getAttribute('type') || '').toLowerCase() === 'hidden') {
    return false;
  }
  if (tag === 'A') return Boolean(node.getAttribute('href'));
  if (FOCUSABLE_TAGS.has(tag)) return true;
  return tabindex !== null && tabindex !== undefined && tabindex !== '';
}

function isHiddenNode(node) {
  return (
    node.hidden === true ||
    (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) ||
    (typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true')
  );
}

/**
 * Tab-reachable controls inside `panel`, in document order: buttons, inputs,
 * textareas, selects, links with `href` and `[tabindex>=0]`; disabled,
 * `tabindex=-1`, `type=hidden` and anything under a hidden / aria-hidden
 * subtree is skipped. Shared by both renderers' focus traps.
 */
export function dialogFocusables(panel) {
  const out = [];
  const walk = (node) => {
    const kids = node && node.children ? Array.from(node.children) : [];
    for (const child of kids) {
      if (isHiddenNode(child)) continue;
      if (isFocusableNode(child)) out.push(child);
      walk(child);
    }
  };
  walk(panel);
  return out;
}

/** The node's root (`Document` or `ShadowRoot`), or null for a detached / unknown node. */
export function focusRootOf(node, doc) {
  if (!node || typeof node.getRootNode !== 'function') return doc || null;
  const root = node.getRootNode();
  return root && root.activeElement !== undefined ? root : doc || null;
}

/**
 * The focused element as seen from `node`'s tree: `ShadowRoot.activeElement`
 * inside a shadow root (falling back to the document when focus is outside
 * it), else `document.activeElement`.
 */
export function activeElementFor(node, doc) {
  const root = focusRootOf(node, doc);
  const inRoot = root && root.activeElement !== undefined ? root.activeElement : null;
  if (inRoot) return inRoot;
  return doc && doc.activeElement !== undefined ? doc.activeElement : null;
}

/** `true` when a node is still part of a document (unknown engines: assume yes). */
export function isConnected(node) {
  return Boolean(node) && node.isConnected !== false;
}

/**
 * Build a dialog element for `model` (vanilla DOM). `handlers.onResult(button,
 * value)` runs for a button press / Enter; `handlers.onCancel()` for Escape.
 * `content` (optional element) is placed in the body between the message /
 * input and the buttons. Returns `{ root, focusInitial() }`. A closed model
 * yields the empty hidden root.
 * @param {any} ctx `{ doc, t }`
 * @param {{ el: Function, setData: Function }} h
 */
export function buildDialogDom(ctx, h, model, ids, handlers, content) {
  const { el, setData } = h;
  const root = el(ctx, 'div', 'kb-dialog');
  setData(root, 'state', model.open ? 'open' : 'closed');
  if (!model.open) {
    root.hidden = true;
    root.setAttribute('hidden', '');
    return { root, focusInitial() {} };
  }
  if (model.danger) setData(root, 'tone', 'danger');
  const backdrop = el(ctx, 'div', 'kb-dialog__backdrop');
  backdrop.setAttribute('aria-hidden', 'true');
  root.appendChild(backdrop);
  const panel = el(ctx, 'div', 'kb-dialog__panel');
  panel.setAttribute('id', ids.root);
  panel.setAttribute('role', model.role);
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', ids.title);
  if (model.message) panel.setAttribute('aria-describedby', ids.message);
  const title = el(ctx, 'h2', 'kb-dialog__title', model.title);
  title.setAttribute('id', ids.title);
  panel.appendChild(title);
  if (model.message) {
    const message = el(ctx, 'p', 'kb-dialog__message', model.message);
    message.setAttribute('id', ids.message);
    panel.appendChild(message);
  }
  let input = null;
  if (model.input) {
    const field = el(ctx, 'div', 'kb-field kb-dialog__field');
    setData(field, 'control', model.input.multiline ? 'textarea' : 'text-field');
    const label = el(ctx, 'label', 'kb-field__label', model.input.label);
    label.setAttribute('for', ids.input);
    field.appendChild(label);
    input = el(
      ctx,
      model.input.multiline ? 'textarea' : 'input',
      model.input.multiline ? 'kb-input kb-textarea' : 'kb-input'
    );
    if (!model.input.multiline) input.setAttribute('type', 'text');
    input.setAttribute('id', ids.input);
    input.setAttribute('name', model.input.name);
    if (model.input.placeholder) input.setAttribute('placeholder', model.input.placeholder);
    if (model.input.multiline && model.input.value) input.textContent = model.input.value;
    input.value = model.input.value;
    field.appendChild(input);
    panel.appendChild(field);
  }
  if (content) panel.appendChild(content);
  const actions = el(ctx, 'div', 'kb-dialog__actions');
  const buttonNodes = [];
  let primary = null;
  for (const button of model.buttons) {
    const node = el(ctx, 'button', `kb-btn kb-btn--${button.variant}`, button.label);
    node.setAttribute('type', 'button');
    if (button.kind === 'choice') setData(node, 'choice-id', button.choice);
    else setData(node, 'dialog-button', button.kind);
    node.addEventListener('click', () => handlers.onResult(button, input ? input.value : ''));
    if (button.primary) primary = { node, button };
    buttonNodes.push(node);
    actions.appendChild(node);
  }
  panel.appendChild(actions);
  root.appendChild(panel);

  if (input && !model.input.multiline) {
    input.addEventListener('keydown', (event) => {
      if (!event || event.key !== 'Enter' || event.isComposing) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (primary) handlers.onResult(primary.button, input.value);
    });
  }
  panel.addEventListener('keydown', (event) => {
    if (!event) return;
    if (event.key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      handlers.onCancel();
      return;
    }
    if (event.key === 'Tab') {
      const target = dialogTrapTarget(
        dialogFocusables(panel),
        activeElementFor(panel, ctx.doc),
        event.shiftKey === true
      );
      if (target) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        target.focus();
      }
    }
  });
  const initial = input || (primary && primary.node) || buttonNodes[0] || null;
  return {
    root,
    focusInitial() {
      if (initial && typeof initial.focus === 'function') initial.focus({ preventScroll: true });
    },
  };
}

/** Run `fn` after the current render is attached (microtask). */
function afterAttach(fn) {
  Promise.resolve().then(fn, () => {});
}

// The vanilla renderer re-renders whole containers, so "the element focused
// when the dialog opened" must survive re-renders: it is kept per focus root
// (document or shadow root) and dialog id from the first open render until a
// render with `open: false`, which restores focus to it (the controlled close).
const RETURN_TARGETS = new WeakMap();

function returnTargets(key) {
  let map = RETURN_TARGETS.get(key);
  if (!map) {
    map = new Map();
    RETURN_TARGETS.set(key, map);
  }
  return map;
}

/**
 * Build the `ui:dialog` renderer on top of `kyberion-ui.js`'s helpers.
 * @param {{ el: Function, setData: Function }} h
 */
export function createDialogRenderer(h) {
  const dialog = (ctx, p, c, depth) => {
    const model = dialogModel(p, ctx.t);
    const ids = dialogIds(c && c.id);
    const doc = ctx.doc;
    // Where focus lives: the render container's root (a shadow root for a
    // layer rendered into one), else the document.
    const focusRoot = focusRootOf(ctx.container, doc);
    const targets = focusRoot && typeof focusRoot === 'object' ? returnTargets(focusRoot) : null;
    const firstOpen = model.open && !(targets && targets.has(ids.root));
    if (targets) {
      if (firstOpen) {
        targets.set(ids.root, activeElementFor(ctx.container, doc) || null);
      } else if (!model.open && targets.has(ids.root)) {
        const returnTo = targets.get(ids.root);
        targets.delete(ids.root);
        afterAttach(() => {
          if (returnTo && isConnected(returnTo) && typeof returnTo.focus === 'function') {
            returnTo.focus();
          }
        });
      }
    }
    const dispatch = (result) => {
      if (typeof ctx.onAction === 'function') ctx.onAction(result, c);
    };
    let content = null;
    if (model.open && c && Array.isArray(c.children) && c.children.length > 0) {
      content = h.el(ctx, 'div', 'kb-dialog__content');
      if (typeof h.appendChildren === 'function') h.appendChildren(ctx, content, c, depth || 0);
      if (!content.firstChild) content = null;
    }
    const built = buildDialogDom(
      ctx,
      h,
      model,
      ids,
      {
        onResult: (button, value) => dispatch(dialogResult(p, model, button, value)),
        onCancel: () => dispatch(dialogCancelResult(p)),
      },
      content
    );
    if (model.open) {
      // Focus the initial control when the dialog opens, and again when a
      // re-render replaced the focused node (focus fell back to the body).
      afterAttach(() => {
        const active = activeElementFor(built.root, doc);
        if (firstOpen || !active || active === doc.body || !isConnected(active)) {
          built.focusInitial();
        }
      });
    }
    return built.root;
  };
  return {
    'ui:dialog'(ctx, p, c, depth) {
      return dialog(ctx, p, c, depth);
    },
  };
}
