/*
 * Kyberion UI — `ui:toolbar` (PA-01, PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §3).
 *
 * WAI-ARIA toolbar: `role=toolbar` + roving tabindex (ArrowLeft/Right,
 * Home/End move focus between the enabled buttons; Tab leaves the toolbar).
 * Controlled: toggles show `pressed` from props (echoed locally until the
 * host re-renders). Picked files reach the host only as the `onAction`
 * payload (`{ id, files: File[] }`) — never props, attributes or storage.
 *
 * The pure helpers are shared with the React `Toolbar` (src/pads/toolbar.tsx).
 */
import { rovingIndex } from './drawing-core.js';

/** Mirrors `KB_TOOLBAR_ACTIONS` in libs/core/a2ui-catalog.ts (pinned by tests). */
export const KB_TOOLBAR_ACTIONS = Object.freeze({
  click: 'toolbar.click',
  toggle: 'toolbar.toggle',
  files: 'toolbar.files',
});

export const KB_TOOLBAR_ITEM_TYPES = Object.freeze([
  'button',
  'toggle',
  'file',
  'separator',
  'spacer',
  'status',
]);

const VARIANTS = ['primary', 'secondary', 'danger', 'ghost'];
const TONES = ['neutral', 'accent', 'info', 'success', 'warning', 'danger'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/**
 * Normalize `items`: drops malformed entries (a button / toggle / file needs
 * `id` and `label`; a status needs `text`). Returned items carry
 * `focusable` (an enabled control that takes part in the roving tabindex).
 */
export function toolbarItems(p) {
  const list = isRecord(p) && Array.isArray(p.items) ? p.items : [];
  const out = [];
  list.forEach((raw, index) => {
    if (!isRecord(raw) || !KB_TOOLBAR_ITEM_TYPES.includes(raw.type)) return;
    const type = raw.type;
    const id = text(raw.id);
    const label = text(raw.label);
    if ((type === 'button' || type === 'toggle' || type === 'file') && (!id || !label)) return;
    if (type === 'status' && !text(raw.text)) return;
    const control = type === 'button' || type === 'toggle' || type === 'file';
    const disabled = raw.disabled === true;
    out.push({
      key: id ? `${type}:${id}` : `${type}:${index}`,
      type,
      id,
      label,
      icon: text(raw.icon),
      hideLabel: raw.hide_label === true,
      variant: VARIANTS.includes(raw.variant) ? raw.variant : 'ghost',
      pressed: raw.pressed === true,
      disabled,
      action: raw.action,
      accept: typeof raw.accept === 'string' ? raw.accept : '',
      multiple: raw.multiple === true,
      text: text(raw.text),
      tone: TONES.includes(raw.tone) ? raw.tone : '',
      control,
      focusable: control && !disabled,
    });
  });
  return out;
}

/** Index (into `items`) of the control that starts with tabindex 0; -1 when none. */
export function toolbarInitialFocus(items) {
  return items.findIndex((item) => item.focusable);
}

/**
 * Roving move for `key` from the item at `current` (indexes into `items`):
 * the index of the next focusable item, or -1 when the key does not move.
 */
export function toolbarRovingTarget(items, current, key) {
  const focusable = [];
  items.forEach((item, index) => {
    if (item.focusable) focusable.push(index);
  });
  const at = focusable.indexOf(current);
  const next = rovingIndex(key, at, focusable.length);
  return next < 0 ? -1 : focusable[next];
}

/** Action id + declared payload for an item (`action` wins over the type default). */
export function toolbarItemAction(item) {
  const fallback =
    item.type === 'toggle'
      ? KB_TOOLBAR_ACTIONS.toggle
      : item.type === 'file'
        ? KB_TOOLBAR_ACTIONS.files
        : KB_TOOLBAR_ACTIONS.click;
  const action = item.action;
  if (typeof action === 'string' && action) return { id: action, payload: undefined };
  if (isRecord(action) && typeof action.id === 'string' && action.id) {
    return { id: action.id, payload: isRecord(action.payload) ? action.payload : undefined };
  }
  return { id: fallback, payload: undefined };
}

/** Runtime payload for an activation (merged over the declared payload; runtime wins). */
export function toolbarPayload(item, runtime) {
  const declared = toolbarItemAction(item).payload || {};
  return { ...declared, id: item.id, ...runtime };
}

/**
 * Build the `ui:toolbar` renderer on top of `kyberion-ui.js`'s helpers.
 * @param {{ el: Function, setData: Function }} h
 */
export function createToolbarRenderer(h) {
  const { el, setData } = h;

  const dispatch = (ctx, source, item, runtime) => {
    if (typeof ctx.onAction !== 'function') return;
    const action = toolbarItemAction(item);
    ctx.onAction({ id: action.id, payload: toolbarPayload(item, runtime) }, source);
  };

  const toolbar = (ctx, p, c) => {
    const root = el(ctx, 'div', 'kb-toolbar');
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', text(p.label));
    if (p.density === 'compact' || p.density === 'comfortable') setData(root, 'density', p.density);
    if (p.sticky === true) setData(root, 'sticky', 'true');
    const items = toolbarItems(p);
    const buttons = new Map();
    let active = toolbarInitialFocus(items);

    const setActive = (index, focus) => {
      const previous = buttons.get(active);
      if (previous) previous.tabIndex = -1;
      if (previous) previous.setAttribute('tabindex', '-1');
      active = index;
      const next = buttons.get(index);
      if (!next) return;
      next.tabIndex = 0;
      next.setAttribute('tabindex', '0');
      if (focus && typeof next.focus === 'function') next.focus();
    };

    items.forEach((item, index) => {
      if (item.type === 'separator') {
        const sep = el(ctx, 'span', 'kb-toolbar__separator');
        sep.setAttribute('role', 'separator');
        sep.setAttribute('aria-orientation', 'vertical');
        root.appendChild(sep);
        return;
      }
      if (item.type === 'spacer') {
        const spacer = el(ctx, 'span', 'kb-toolbar__spacer');
        spacer.setAttribute('aria-hidden', 'true');
        root.appendChild(spacer);
        return;
      }
      if (item.type === 'status') {
        const status = el(ctx, 'span', 'kb-toolbar__status', item.text);
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        setData(status, 'item-id', item.id);
        setData(status, 'tone', item.tone);
        root.appendChild(status);
        return;
      }
      const button = el(ctx, 'button', `kb-btn kb-btn--${item.variant} kb-toolbar__item`);
      button.setAttribute('type', 'button');
      setData(button, 'item-type', item.type);
      setData(button, 'item-id', item.id);
      const tabindex = index === active ? '0' : '-1';
      button.setAttribute('tabindex', tabindex);
      button.tabIndex = Number(tabindex);
      if (item.disabled) button.disabled = true;
      if (item.hideLabel) {
        button.setAttribute('aria-label', item.label);
        button.setAttribute('title', item.label);
      }
      if (item.type === 'toggle') button.setAttribute('aria-pressed', String(item.pressed));
      if (item.icon) {
        const glyph = el(ctx, 'span', 'kb-toolbar__icon', item.icon);
        glyph.setAttribute('aria-hidden', 'true');
        button.appendChild(glyph);
      }
      if (!item.hideLabel) button.appendChild(el(ctx, 'span', 'kb-toolbar__label', item.label));
      buttons.set(index, button);
      root.appendChild(button);

      button.addEventListener('focus', () => {
        if (active !== index) setActive(index, false);
      });
      button.addEventListener('keydown', (event) => {
        const target = toolbarRovingTarget(items, index, event && event.key);
        if (target < 0) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setActive(target, true);
      });

      if (item.type === 'file') {
        const input = el(ctx, 'input', 'kb-toolbar__file');
        input.setAttribute('type', 'file');
        input.setAttribute('tabindex', '-1');
        input.setAttribute('aria-hidden', 'true');
        input.hidden = true;
        input.setAttribute('hidden', '');
        if (item.accept) input.setAttribute('accept', item.accept);
        if (item.multiple) input.multiple = true;
        if (item.disabled) input.disabled = true;
        input.addEventListener('change', () => {
          const files = input.files ? Array.from(input.files) : [];
          try {
            input.value = '';
          } catch {
            // some engines refuse; harmless
          }
          if (files.length > 0) dispatch(ctx, c, item, { files });
        });
        root.appendChild(input);
        button.addEventListener('click', () => {
          if (item.disabled) return;
          setActive(index, false);
          if (typeof input.click === 'function') input.click();
        });
        return;
      }
      button.addEventListener('click', () => {
        if (item.disabled) return;
        setActive(index, false);
        if (item.type === 'toggle') {
          const pressed = button.getAttribute('aria-pressed') !== 'true';
          button.setAttribute('aria-pressed', String(pressed));
          dispatch(ctx, c, item, { pressed });
          return;
        }
        dispatch(ctx, c, item, {});
      });
    });
    return root;
  };

  return {
    'ui:toolbar'(ctx, p, c) {
      return toolbar(ctx, p, c);
    },
  };
}
