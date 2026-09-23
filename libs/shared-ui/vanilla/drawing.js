/*
 * Kyberion UI — `ui:drawing-palette` and `ui:sketch-board` for the vanilla
 * renderer (PA-01, PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §3).
 *
 * `ui:drawing-palette` is controlled (tool / color / width come from props,
 * echoed locally until the host re-renders) and reports every edit as
 * `drawing.change { name, tool? | color? | width? }`, plus `drawing.undo` /
 * `drawing.clear { name }`.
 *
 * `ui:sketch-board` is stateful (palette + canvas on the shared
 * `drawing-engine.js`): the vanilla renderer re-renders whole containers, so
 * hosts give it its own container. On mount it dispatches
 * `drawing.ready { name, controller }`; after each committed stroke (and
 * undo / clear) `drawing.change { name, dirty, strokes }`; a dropped / pasted
 * image goes out as `drawing.background { name, file }` (File only in the
 * payload). The clear button asks with the `ui:dialog` markup.
 */
import {
  KB_DRAWING_ACTIONS,
  KB_DRAWING_ICON_PATHS,
  KB_DRAWING_MESSAGE_KEYS,
  KB_DRAWING_TOOL_MESSAGE_KEYS,
  KB_SKETCH_DEFAULT_SIZE,
  clampDrawingWidth,
  drawingIds,
  drawingPaletteState,
  normalizeHexColor,
  rovingIndex,
  sketchFileName,
} from './drawing-core.js';
import { createDrawingEngine } from './drawing-engine.js';
import { buildDialogDom, dialogModel } from './dialog.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const K = KB_DRAWING_MESSAGE_KEYS;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/** Sketch-board canvas size from props (defaults 1280 × 720). */
export function sketchCanvasSize(p) {
  const record = isRecord(p) ? p : {};
  const pick = (value, fallback) =>
    Number.isInteger(value) && value >= 64 && value <= 4096 ? value : fallback;
  return {
    width: pick(record.canvas_width, KB_SKETCH_DEFAULT_SIZE.width),
    height: pick(record.canvas_height, KB_SKETCH_DEFAULT_SIZE.height),
  };
}

/** `background` prop → `dark` | `light` | `transparent` (default dark). */
export function sketchBackground(value) {
  return value === 'light' || value === 'transparent' ? value : 'dark';
}

/** An image file (by MIME type) — the only thing a drop / paste may set as background. */
export function isImageFile(file) {
  return Boolean(file) && typeof file.type === 'string' && /^image\//i.test(file.type);
}

/** Clear-confirmation dialog props (shared by both renderers). */
export function sketchClearDialogProps(t, open) {
  return {
    open,
    title: t(K.sketchClearTitle),
    message: t(K.sketchClearMessage),
    tone: 'danger',
    confirm_label: t(K.sketchClearConfirm),
  };
}

/**
 * Build the drawing renderers on top of `kyberion-ui.js`'s helpers.
 * @param {{ el: Function, setData: Function, safeHref: (value: unknown) => string | null }} h
 */
export function createDrawingRenderers(h) {
  const { el, setData } = h;

  const svgIcon = (ctx, name) => {
    const paths = KB_DRAWING_ICON_PATHS[name];
    const svg = ctx.doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of paths || []) {
      const path = ctx.doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  };

  const setTabIndex = (node, value) => {
    node.tabIndex = value;
    node.setAttribute('tabindex', String(value));
  };

  const setSwatchColor = (node, color) => {
    // CSSOM, not a style attribute (CSP-safe); the value is a validated hex.
    if (node.style && typeof node.style.setProperty === 'function') {
      node.style.setProperty('--kb-swatch', color);
    }
  };

  /**
   * A radiogroup of buttons (roving tabindex; arrows move AND select).
   * `entries`: `[{ value, label, render(button) }]`.
   */
  const radioGroup = (ctx, className, label, entries, selected, onSelect) => {
    const group = el(ctx, 'div', `kb-drawing-palette__group ${className}`);
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const nodes = [];
    const sync = (value) => {
      const index = entries.findIndex((entry) => entry.value === value);
      nodes.forEach((node, i) => {
        node.setAttribute('aria-checked', String(i === index));
        setTabIndex(node, i === (index >= 0 ? index : 0) ? 0 : -1);
      });
    };
    entries.forEach((entry, index) => {
      const node = el(ctx, 'button', entry.className);
      node.setAttribute('type', 'button');
      node.setAttribute('role', 'radio');
      node.setAttribute('aria-label', entry.label);
      node.setAttribute('title', entry.label);
      entry.render(node);
      node.addEventListener('click', () => onSelect(entry.value));
      node.addEventListener('keydown', (event) => {
        const next = rovingIndex(event && event.key, index, entries.length);
        if (next < 0) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        onSelect(entries[next].value);
        if (typeof nodes[next].focus === 'function') nodes[next].focus();
      });
      nodes.push(node);
      group.appendChild(node);
    });
    sync(selected);
    return { group, sync };
  };

  /**
   * Palette markup + behaviour shared by `ui:drawing-palette` and the
   * sketch board. Returns `{ root, update(state) }`.
   */
  const buildPalette = (ctx, opts) => {
    let state = { ...opts.state };
    const root = el(ctx, 'div', 'kb-drawing-palette');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', opts.label);
    setData(root, 'orientation', opts.orientation === 'vertical' ? 'vertical' : 'horizontal');
    if (opts.disabled) setData(root, 'disabled', 'true');

    const tools = radioGroup(
      ctx,
      'kb-drawing-palette__tools',
      ctx.t(K.tools),
      state.tools.map((tool) => ({
        value: tool,
        label: ctx.t(KB_DRAWING_TOOL_MESSAGE_KEYS[tool]),
        className: 'kb-drawing-palette__tool',
        render: (node) => {
          setData(node, 'tool', tool);
          node.appendChild(svgIcon(ctx, tool));
        },
      })),
      state.tool,
      (tool) => opts.onTool(tool)
    );
    root.appendChild(tools.group);

    const colors = radioGroup(
      ctx,
      'kb-drawing-palette__colors',
      ctx.t(K.colors),
      state.colors.map((color) => ({
        value: color,
        label: ctx.t(K.color, { color }),
        className: 'kb-drawing-palette__swatch',
        render: (node) => {
          setData(node, 'color', color);
          setSwatchColor(node, color);
        },
      })),
      state.color,
      (color) => opts.onColor(color)
    );
    let custom = null;
    if (opts.allowCustom) {
      const wrap = el(ctx, 'label', 'kb-drawing-palette__custom');
      wrap.setAttribute('title', ctx.t(K.customColor));
      wrap.appendChild(el(ctx, 'span', 'kb-visually-hidden', ctx.t(K.customColor)));
      custom = el(ctx, 'input', 'kb-drawing-palette__custom-input');
      custom.setAttribute('type', 'color');
      custom.value = state.color;
      custom.setAttribute('value', state.color);
      custom.addEventListener('input', () => {
        const hex = normalizeHexColor(custom.value);
        if (hex) opts.onColor(hex);
      });
      wrap.appendChild(custom);
      colors.group.appendChild(wrap);
    }
    root.appendChild(colors.group);

    const widthGroup = el(ctx, 'div', 'kb-drawing-palette__group kb-drawing-palette__width');
    const widthLabel = el(ctx, 'label', 'kb-drawing-palette__width-label', ctx.t(K.width));
    widthLabel.setAttribute('for', opts.ids.width);
    widthGroup.appendChild(widthLabel);
    const range = el(ctx, 'input', 'kb-drawing-palette__range');
    range.setAttribute('type', 'range');
    range.setAttribute('id', opts.ids.width);
    range.setAttribute('min', String(state.min));
    range.setAttribute('max', String(state.max));
    range.setAttribute('step', '1');
    range.setAttribute('value', String(state.width));
    range.value = String(state.width);
    widthGroup.appendChild(range);
    const widthValue = el(
      ctx,
      'span',
      'kb-drawing-palette__width-value',
      ctx.t(K.widthValue, { width: state.width })
    );
    widthValue.setAttribute('aria-hidden', 'true');
    widthGroup.appendChild(widthValue);
    range.addEventListener('input', () => {
      opts.onWidth(clampDrawingWidth(Number(range.value), state, state.width));
    });
    root.appendChild(widthGroup);

    const actions = el(ctx, 'div', 'kb-drawing-palette__group kb-drawing-palette__actions');
    const actionButton = (key, icon, label, onClick, disabled) => {
      const node = el(ctx, 'button', 'kb-btn kb-btn--ghost kb-drawing-palette__action');
      node.setAttribute('type', 'button');
      setData(node, 'palette-action', key);
      node.setAttribute('aria-label', label);
      node.setAttribute('title', label);
      if (disabled) node.disabled = true;
      node.appendChild(svgIcon(ctx, icon));
      node.addEventListener('click', onClick);
      actions.appendChild(node);
      return node;
    };
    const undo = actionButton('undo', 'undo', ctx.t(K.undo), () => opts.onUndo(), !state.canUndo);
    const clear = opts.showClear
      ? actionButton('clear', 'clear', ctx.t(K.clear), () => opts.onClear(), false)
      : null;
    if (opts.showDownload) {
      actionButton('download', 'download', ctx.t(K.sketchDownload), () => opts.onDownload(), false);
    }
    root.appendChild(actions);

    return {
      root,
      clearButton: clear,
      update(next) {
        state = { ...state, ...next };
        tools.sync(state.tool);
        colors.sync(state.color);
        if (custom) custom.value = state.color;
        range.value = String(state.width);
        widthValue.textContent = ctx.t(K.widthValue, { width: state.width });
        undo.disabled = !state.canUndo;
      },
    };
  };

  // -- ui:drawing-palette ----------------------------------------------------

  const drawingPalette = (ctx, p, c) => {
    const name = text(p.name);
    const dispatch = (id, runtime) => {
      if (typeof ctx.onAction === 'function')
        ctx.onAction({ id, payload: { name, ...runtime } }, c);
    };
    const initial = drawingPaletteState(p);
    let palette = null;
    palette = buildPalette(ctx, {
      ids: drawingIds(c && c.id, name),
      label: text(p.label),
      state: { ...initial, canUndo: p.can_undo === true },
      allowCustom: p.allow_custom_color === true,
      orientation: p.orientation,
      showClear: p.show_clear === true,
      onTool: (tool) => {
        palette.update({ tool });
        dispatch(KB_DRAWING_ACTIONS.change, { tool });
      },
      onColor: (color) => {
        palette.update({ color });
        dispatch(KB_DRAWING_ACTIONS.change, { color });
      },
      onWidth: (width) => {
        palette.update({ width });
        dispatch(KB_DRAWING_ACTIONS.change, { width });
      },
      onUndo: () => dispatch(KB_DRAWING_ACTIONS.undo, {}),
      onClear: () => dispatch(KB_DRAWING_ACTIONS.clear, {}),
    });
    setData(palette.root, 'name', name);
    return palette.root;
  };

  // -- ui:sketch-board -------------------------------------------------------

  const sketchBoard = (ctx, p, c) => {
    const name = text(p.name);
    const ids = drawingIds(c && c.id, name);
    const size = sketchCanvasSize(p);
    const background = sketchBackground(p.background);
    const initial = drawingPaletteState(p, {
      tool: 'default_tool',
      color: 'default_color',
      width: 'default_width',
    });
    const dispatch = (id, runtime) => {
      if (typeof ctx.onAction === 'function')
        ctx.onAction({ id, payload: { name, ...runtime } }, c);
    };

    const root = el(ctx, 'div', 'kb-sketch-board');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', text(p.label));
    setData(root, 'name', name);
    setData(root, 'background', background);
    setData(root, 'state', 'empty');
    const bar = el(ctx, 'div', 'kb-sketch-board__bar');
    root.appendChild(bar);
    const stage = el(ctx, 'div', 'kb-sketch-board__stage');
    root.appendChild(stage);
    const canvas = el(ctx, 'canvas', 'kb-sketch-board__canvas');
    canvas.setAttribute('width', String(size.width));
    canvas.setAttribute('height', String(size.height));
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', ctx.t(K.sketchCanvas, { label: text(p.label) }));
    canvas.setAttribute('tabindex', '0');
    stage.appendChild(canvas);
    const acceptDrop = p.accept_image_drop === true;
    if (acceptDrop) {
      const hint = el(ctx, 'p', 'kb-sketch-board__hint', ctx.t(K.sketchDropHint));
      hint.setAttribute('id', ids.hint);
      canvas.setAttribute('aria-describedby', ids.hint);
      root.appendChild(hint);
    }
    const notice = el(ctx, 'p', 'kb-sketch-board__notice');
    notice.setAttribute('role', 'status');
    root.appendChild(notice);
    const dialogSlot = el(ctx, 'div', 'kb-sketch-board__dialog');
    root.appendChild(dialogSlot);

    let palette = null;
    const engine = createDrawingEngine({
      canvas,
      doc: ctx.doc,
      win: ctx.win,
      width: size.width,
      height: size.height,
      background,
      maxUndo: p.max_undo,
      tool: initial.tool,
      color: initial.color,
      size: initial.width,
      onCommit: () => changed(),
      onTextRequest: (request) => openText(request),
    });

    const syncState = () => {
      root.setAttribute('data-state', engine.isEmpty() ? 'empty' : 'dirty');
      if (palette) palette.update({ canUndo: engine.canUndo() });
    };
    const changed = () => {
      syncState();
      const strokes = engine.strokeCount();
      dispatch(KB_DRAWING_ACTIONS.change, { dirty: strokes > 0, strokes });
    };

    // Inline text input (the text tool never uses prompt()).
    let textInput = null;
    let textAt = null;
    const closeText = (commit) => {
      const input = textInput;
      const at = textAt;
      if (!input) return;
      textInput = null;
      textAt = null;
      const value = input.value;
      if (input.parentNode) input.parentNode.removeChild(input);
      if (commit && at) engine.addText(at, value);
      if (typeof canvas.focus === 'function') canvas.focus();
    };
    const openText = (request) => {
      closeText(true);
      const input = el(ctx, 'input', 'kb-sketch-board__text');
      input.setAttribute('type', 'text');
      input.setAttribute('aria-label', ctx.t(K.sketchTextInput));
      if (input.style) {
        input.style.left = `${request.left}%`;
        input.style.top = `${request.top}%`;
        if (typeof input.style.setProperty === 'function') {
          input.style.setProperty('--kb-sketch-ink', engine.getState().color);
        }
      }
      input.addEventListener('keydown', (event) => {
        if (!event || event.isComposing) return;
        if (event.key === 'Enter') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          closeText(true);
        } else if (event.key === 'Escape') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          closeText(false);
        }
      });
      input.addEventListener('blur', () => closeText(true));
      textInput = input;
      textAt = { x: request.x, y: request.y };
      stage.appendChild(input);
      if (typeof input.focus === 'function') input.focus();
    };

    // Clear confirmation (ui:dialog markup).
    const dialogIdsFor = {
      root: `${ids.dialog}`,
      title: `${ids.dialog}-title`,
      message: `${ids.dialog}-message`,
      input: `${ids.dialog}-input`,
    };
    const showDialog = (open) => {
      while (dialogSlot.firstChild) dialogSlot.removeChild(dialogSlot.firstChild);
      const model = dialogModel(sketchClearDialogProps(ctx.t, open), ctx.t);
      const close = (confirmed) => {
        showDialog(false);
        if (confirmed) {
          engine.clear();
          changed();
        }
        const back = palette && palette.clearButton;
        if (back && typeof back.focus === 'function') back.focus();
      };
      const built = buildDialogDom(ctx, h, model, dialogIdsFor, {
        onResult: (button) => close(button.kind !== 'cancel'),
        onCancel: () => close(false),
      });
      dialogSlot.appendChild(built.root);
      if (open) built.focusInitial();
    };
    showDialog(false);

    const download = () => {
      void engine.toBlob().then(
        (blob) => {
          const url = ctx.win && ctx.win.URL ? ctx.win.URL.createObjectURL(blob) : null;
          if (!url) return;
          const link = el(ctx, 'a', 'kb-visually-hidden');
          link.setAttribute('href', url);
          link.setAttribute('download', sketchFileName(name));
          root.appendChild(link);
          if (typeof link.click === 'function') link.click();
          root.removeChild(link);
          const revoke = () => ctx.win.URL.revokeObjectURL(url);
          if (typeof ctx.win.setTimeout === 'function') ctx.win.setTimeout(revoke, 0);
          else revoke();
        },
        () => {}
      );
    };

    palette = buildPalette(ctx, {
      ids,
      label: text(p.label),
      state: { ...initial, canUndo: false },
      allowCustom: p.allow_custom_color !== false,
      orientation: 'horizontal',
      showClear: true,
      showDownload: p.show_download === true,
      onTool: (tool) => {
        closeText(true);
        engine.setTool(tool);
        palette.update({ tool });
      },
      onColor: (color) => {
        engine.setColor(color);
        palette.update({ color });
      },
      onWidth: (width) => {
        engine.setWidth(width);
        palette.update({ width });
      },
      onUndo: () => {
        if (engine.undo()) changed();
      },
      onClear: () => showDialog(true),
      onDownload: download,
    });
    bar.appendChild(palette.root);

    root.addEventListener('keydown', (event) => {
      if (!event || textInput) return;
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
      if (key === 'z' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (engine.undo()) changed();
      }
    });

    const takeImage = (file) => {
      if (!file) return;
      if (!isImageFile(file)) {
        notice.textContent = ctx.t(K.sketchBackgroundRejected, { file: file.name || '' });
        return;
      }
      dispatch(KB_DRAWING_ACTIONS.background, { file });
      void engine.setBackgroundImage(file).then((ok) => {
        if (!ok) return;
        notice.textContent = ctx.t(K.sketchBackgroundAdded);
        syncState();
      });
    };
    if (acceptDrop) {
      const over = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        stage.setAttribute('data-dragging', 'true');
      };
      stage.addEventListener('dragenter', over);
      stage.addEventListener('dragover', over);
      stage.addEventListener('dragleave', () => stage.removeAttribute('data-dragging'));
      stage.addEventListener('drop', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        stage.removeAttribute('data-dragging');
        const files = event && event.dataTransfer ? event.dataTransfer.files : null;
        takeImage(files && files[0]);
      });
      root.addEventListener('paste', (event) => {
        const files = event && event.clipboardData ? event.clipboardData.files : null;
        if (!files || files.length === 0) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        takeImage(files[0]);
      });
    }

    const imageUrl = h.safeHref(p.background_image_url);
    if (imageUrl) void engine.setBackgroundImage(imageUrl).then(() => syncState());

    const controller = {
      toBlob: () => engine.toBlob(),
      isEmpty: () => engine.isEmpty(),
      clear: () => {
        engine.clear();
        syncState();
      },
      undo: () => {
        engine.undo();
        syncState();
      },
      setBackgroundImage: (source) => {
        const safe = typeof source === 'string' ? h.safeHref(source) : source;
        return engine.setBackgroundImage(safe ?? null).then((ok) => {
          syncState();
          return ok;
        });
      },
    };
    let disposed = false;
    Promise.resolve().then(() => {
      if (!disposed) dispatch(KB_DRAWING_ACTIONS.ready, { controller });
    });
    if (Array.isArray(ctx.cleanups)) {
      ctx.cleanups.push(() => {
        disposed = true;
        textInput = null;
        engine.dispose();
      });
    }
    return root;
  };

  return {
    'ui:drawing-palette'(ctx, p, c) {
      return drawingPalette(ctx, p, c);
    },
    'ui:sketch-board'(ctx, p, c) {
      return sketchBoard(ctx, p, c);
    },
  };
}
