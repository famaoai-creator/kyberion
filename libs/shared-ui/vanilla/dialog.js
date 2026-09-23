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

/** `true` when a node is still part of a document (unknown engines: assume yes). */
export function isConnected(node) {
  return Boolean(node) && node.isConnected !== false;
}

/**
 * Build a dialog element for `model` (vanilla DOM). `handlers.onResult(button,
 * value)` runs for a button press / Enter; `handlers.onCancel()` for Escape.
 * Returns `{ root, focusInitial() }`. A closed model yields the empty hidden root.
 * @param {any} ctx `{ doc, t }`
 * @param {{ el: Function, setData: Function }} h
 */
export function buildDialogDom(ctx, h, model, ids, handlers) {
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
        [input, ...buttonNodes],
        ctx.doc ? ctx.doc.activeElement : null,
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
// when the dialog opened" must survive re-renders: it is kept per document and
// dialog id from the first open render until a render with `open: false`,
// which restores focus to it (the controlled close).
const RETURN_TARGETS = new WeakMap();

function returnTargets(doc) {
  let map = RETURN_TARGETS.get(doc);
  if (!map) {
    map = new Map();
    RETURN_TARGETS.set(doc, map);
  }
  return map;
}

/**
 * Build the `ui:dialog` renderer on top of `kyberion-ui.js`'s helpers.
 * @param {{ el: Function, setData: Function }} h
 */
export function createDialogRenderer(h) {
  const dialog = (ctx, p, c) => {
    const model = dialogModel(p, ctx.t);
    const ids = dialogIds(c && c.id);
    const doc = ctx.doc;
    const targets = doc && typeof doc === 'object' ? returnTargets(doc) : null;
    const firstOpen = model.open && !(targets && targets.has(ids.root));
    if (targets) {
      if (firstOpen) {
        targets.set(ids.root, doc.activeElement || null);
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
    const built = buildDialogDom(ctx, h, model, ids, {
      onResult: (button, value) => dispatch(dialogResult(p, model, button, value)),
      onCancel: () => dispatch(dialogCancelResult(p)),
    });
    if (model.open) {
      // Focus the initial control when the dialog opens, and again when a
      // re-render replaced the focused node (focus fell back to the body).
      afterAttach(() => {
        const active = doc ? doc.activeElement : null;
        if (firstOpen || !active || active === doc.body || !isConnected(active)) {
          built.focusInitial();
        }
      });
    }
    return built.root;
  };
  return {
    'ui:dialog'(ctx, p, c) {
      return dialog(ctx, p, c);
    },
  };
}
