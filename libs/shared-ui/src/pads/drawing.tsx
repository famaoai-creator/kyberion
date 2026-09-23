'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import type { KbDrawingPaletteProps, KbSketchBoardProps } from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import { safeHref } from '../safety.js';
import {
  KB_DRAWING_ACTIONS,
  KB_DRAWING_MESSAGE_KEYS,
  KB_DRAWING_TOOL_MESSAGE_KEYS,
  clampDrawingWidth,
  createDrawingEngine,
  dialogModel,
  drawingIds,
  drawingPaletteState,
  isImageFile,
  normalizeHexColor,
  rovingIndex,
  sketchBackground,
  sketchCanvasSize,
  sketchClearDialogProps,
  sketchFileName,
  type KbDrawingEngine,
  type KbDrawingPaletteState,
  type KbDrawingTextRequest,
  type KbDrawingToolName,
  type KbSketchControllerRuntime,
} from '../../vanilla/pads.js';
import { useA2UIActions } from '../actions.js';
import { useEcho } from '../forms/shared.js';
import { DialogView } from './dialog.js';
import { PadIcon } from './shared.js';

const K = KB_DRAWING_MESSAGE_KEYS;

interface RadioEntry {
  value: string;
  label: string;
  className: string;
  data: Record<string, string>;
  style?: CSSProperties;
  icon?: string;
}

/** Radiogroup of buttons (roving tabindex; arrows move AND select) — mirrors vanilla `radioGroup`. */
function RadioButtons({
  className,
  label,
  entries,
  selected,
  onSelect,
  children,
}: {
  className: string;
  label: string;
  entries: RadioEntry[];
  selected: string;
  onSelect: (value: string) => void;
  children?: ReactNode;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checked = entries.findIndex((entry) => entry.value === selected);
  const tabStop = checked >= 0 ? checked : 0;
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = rovingIndex(event.key, index, entries.length);
    if (next < 0) return;
    event.preventDefault();
    onSelect(entries[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className={`kb-drawing-palette__group ${className}`} role="radiogroup" aria-label={label}>
      {entries.map((entry, index) => (
        <button
          key={entry.value}
          type="button"
          className={entry.className}
          role="radio"
          aria-label={entry.label}
          title={entry.label}
          aria-checked={index === checked}
          tabIndex={index === tabStop ? 0 : -1}
          style={entry.style}
          {...entry.data}
          ref={(node) => {
            refs.current[index] = node;
          }}
          onClick={() => onSelect(entry.value)}
          onKeyDown={onKeyDown(index)}
        >
          {entry.icon ? <PadIcon name={entry.icon} /> : null}
        </button>
      ))}
      {children}
    </div>
  );
}

export interface PaletteViewProps {
  ids: ReturnType<typeof drawingIds>;
  label: string;
  /** `data-name` on the root (the standalone palette only). */
  name?: string;
  state: KbDrawingPaletteState & { canUndo: boolean };
  allowCustom: boolean;
  orientation?: string;
  showClear: boolean;
  showDownload?: boolean;
  clearRef?: Ref<HTMLButtonElement>;
  onTool: (tool: KbDrawingToolName) => void;
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  onUndo: () => void;
  onClear: () => void;
  onDownload?: () => void;
}

/** Palette markup shared by `ui:drawing-palette` and `ui:sketch-board` (mirrors vanilla `buildPalette`). */
export function PaletteView(props: PaletteViewProps) {
  const { t } = useKbI18n();
  const { state } = props;
  const action = (
    key: string,
    icon: string,
    label: string,
    onClick: () => void,
    disabled: boolean,
    ref?: Ref<HTMLButtonElement>
  ) => (
    <button
      type="button"
      className="kb-btn kb-btn--ghost kb-drawing-palette__action"
      data-palette-action={key}
      aria-label={label}
      title={label}
      disabled={disabled || undefined}
      ref={ref}
      onClick={onClick}
    >
      <PadIcon name={icon} />
    </button>
  );
  return (
    <div
      className="kb-drawing-palette"
      role="group"
      aria-label={props.label}
      data-orientation={props.orientation === 'vertical' ? 'vertical' : 'horizontal'}
      data-name={props.name || undefined}
    >
      <RadioButtons
        className="kb-drawing-palette__tools"
        label={t(K.tools)}
        selected={state.tool}
        onSelect={(tool) => props.onTool(tool as KbDrawingToolName)}
        entries={state.tools.map((tool) => ({
          value: tool,
          label: t(KB_DRAWING_TOOL_MESSAGE_KEYS[tool]),
          className: 'kb-drawing-palette__tool',
          data: { 'data-tool': tool },
          icon: tool,
        }))}
      />
      <RadioButtons
        className="kb-drawing-palette__colors"
        label={t(K.colors)}
        selected={state.color}
        onSelect={(color) => props.onColor(color)}
        entries={state.colors.map((color) => ({
          value: color,
          label: t(K.color, { color }),
          className: 'kb-drawing-palette__swatch',
          data: { 'data-color': color },
          style: { '--kb-swatch': color } as CSSProperties,
        }))}
      >
        {props.allowCustom ? (
          <label className="kb-drawing-palette__custom" title={t(K.customColor)}>
            <span className="kb-visually-hidden">{t(K.customColor)}</span>
            <input
              className="kb-drawing-palette__custom-input"
              type="color"
              value={state.color}
              onChange={(event) => {
                const hex = normalizeHexColor(event.currentTarget.value);
                if (hex) props.onColor(hex);
              }}
            />
          </label>
        ) : null}
      </RadioButtons>
      <div className="kb-drawing-palette__group kb-drawing-palette__width">
        <label className="kb-drawing-palette__width-label" htmlFor={props.ids.width}>
          {t(K.width)}
        </label>
        <input
          className="kb-drawing-palette__range"
          type="range"
          id={props.ids.width}
          min={state.min}
          max={state.max}
          step={1}
          value={state.width}
          onChange={(event) =>
            props.onWidth(clampDrawingWidth(Number(event.currentTarget.value), state, state.width))
          }
        />
        <span className="kb-drawing-palette__width-value" aria-hidden="true">
          {t(K.widthValue, { width: state.width })}
        </span>
      </div>
      <div className="kb-drawing-palette__group kb-drawing-palette__actions">
        {action('undo', 'undo', t(K.undo), props.onUndo, !state.canUndo)}
        {props.showClear
          ? action('clear', 'clear', t(K.clear), props.onClear, false, props.clearRef)
          : null}
        {props.showDownload && props.onDownload
          ? action('download', 'download', t(K.sketchDownload), props.onDownload, false)
          : null}
      </div>
    </div>
  );
}

export interface DrawingPaletteProps extends KbDrawingPaletteProps {
  /** A2UI component id; DOM ids derive from it (else from `name`). */
  id?: string;
}

/**
 * `ui:drawing-palette` (PA-01): controlled tool / color / width picker with
 * a local echo. Dispatches `drawing.change { name, tool | color | width }`,
 * `drawing.undo { name }`, `drawing.clear { name }`.
 */
export function DrawingPalette(p: DrawingPaletteProps) {
  const { onAction } = useA2UIActions();
  const initial = drawingPaletteState(p);
  const [tool, setTool] = useEcho<KbDrawingToolName>(initial.tool);
  const [color, setColor] = useEcho<string>(initial.color);
  const [width, setWidth] = useEcho<number>(initial.width);
  const send = (id: string, runtime: Record<string, unknown>) => {
    if (onAction) onAction(id, { name: p.name, ...runtime });
  };
  return (
    <PaletteView
      ids={drawingIds(p.id, p.name)}
      label={p.label}
      name={p.name}
      state={{ ...initial, tool, color, width, canUndo: p.can_undo === true }}
      allowCustom={p.allow_custom_color === true}
      orientation={p.orientation}
      showClear={p.show_clear === true}
      onTool={(next) => {
        setTool(next);
        send(KB_DRAWING_ACTIONS.change, { tool: next });
      }}
      onColor={(next) => {
        setColor(next);
        send(KB_DRAWING_ACTIONS.change, { color: next });
      }}
      onWidth={(next) => {
        setWidth(next);
        send(KB_DRAWING_ACTIONS.change, { width: next });
      }}
      onUndo={() => send(KB_DRAWING_ACTIONS.undo, {})}
      onClear={() => send(KB_DRAWING_ACTIONS.clear, {})}
    />
  );
}

export interface SketchBoardProps extends KbSketchBoardProps {
  /** A2UI component id; DOM ids derive from it (else from `name`). */
  id?: string;
}

/**
 * `ui:sketch-board` (PA-01): palette + canvas on the shared
 * `vanilla/drawing-engine.js` (created in an effect, disposed on unmount).
 * Dispatches `drawing.ready { name, controller }` on mount,
 * `drawing.change { name, dirty, strokes }` after each stroke / undo /
 * clear and `drawing.background { name, file }` for a dropped / pasted image.
 */
export function SketchBoard(p: SketchBoardProps) {
  const { t } = useKbI18n();
  const { onAction } = useA2UIActions();
  const name = p.name;
  const ids = drawingIds(p.id, name);
  const size = sketchCanvasSize(p);
  const background = sketchBackground(p.background);
  const initial = drawingPaletteState(p, {
    tool: 'default_tool',
    color: 'default_color',
    width: 'default_width',
  });
  const [tool, setTool] = useState<KbDrawingToolName>(initial.tool);
  const [color, setColor] = useState(initial.color);
  const [width, setWidth] = useState(initial.width);
  const [canUndo, setCanUndo] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [notice, setNotice] = useState('');
  const [text, setText] = useState<KbDrawingTextRequest | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<KbDrawingEngine | null>(null);
  const textRef = useRef<HTMLInputElement | null>(null);
  const clearRef = useRef<HTMLButtonElement | null>(null);

  // Latest callbacks for the engine (created once per canvas config).
  const send = useRef<(id: string, runtime: Record<string, unknown>) => void>(() => {});
  send.current = (id, runtime) => {
    if (onAction) onAction(id, { name, ...runtime });
  };
  const sync = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setCanUndo(engine.canUndo());
    setEmpty(engine.isEmpty());
  }, []);
  const changed = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    sync();
    const strokes = engine.strokeCount();
    send.current(KB_DRAWING_ACTIONS.change, { dirty: strokes > 0, strokes });
  }, [sync]);

  const initialRef = useRef(initial);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const start = initialRef.current;
    const engine = createDrawingEngine({
      canvas,
      doc: typeof document !== 'undefined' ? document : undefined,
      win: typeof window !== 'undefined' ? window : undefined,
      width: size.width,
      height: size.height,
      background,
      maxUndo: p.max_undo,
      tool: start.tool,
      color: start.color,
      size: start.width,
      onCommit: () => changed(),
      onTextRequest: (request) => setText(request),
    });
    engineRef.current = engine;
    let disposed = false;
    const controller: KbSketchControllerRuntime = {
      toBlob: () => engine.toBlob(),
      isEmpty: () => engine.isEmpty(),
      clear: () => {
        engine.clear();
        sync();
      },
      undo: () => {
        engine.undo();
        sync();
      },
      setBackgroundImage: (source) => {
        const safe = typeof source === 'string' ? (safeHref(source) ?? null) : source;
        return engine.setBackgroundImage(safe).then((ok) => {
          if (!disposed) sync();
          return ok;
        });
      },
    };
    send.current(KB_DRAWING_ACTIONS.ready, { controller });
    return () => {
      disposed = true;
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [size.width, size.height, background, p.max_undo, changed, sync]);

  const imageUrl = safeHref(p.background_image_url);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !imageUrl) return;
    void engine.setBackgroundImage(imageUrl).then(() => sync());
  }, [imageUrl, sync]);

  useEffect(() => {
    if (text && textRef.current) textRef.current.focus();
  }, [text]);

  // The pending text position lives in a ref too, so Enter + the blur that
  // follows the input's removal commit once.
  const textAt = useRef<KbDrawingTextRequest | null>(null);
  textAt.current = text;
  const closeText = (commit: boolean) => {
    const at = textAt.current;
    if (!at) return;
    textAt.current = null;
    const value = textRef.current ? textRef.current.value : '';
    setText(null);
    if (commit && at && engineRef.current) engineRef.current.addText(at, value);
    canvasRef.current?.focus();
  };

  const takeImage = (file: File | null | undefined) => {
    if (!file) return;
    if (!isImageFile(file)) {
      setNotice(t(K.sketchBackgroundRejected, { file: file.name || '' }));
      return;
    }
    send.current(KB_DRAWING_ACTIONS.background, { file });
    const engine = engineRef.current;
    if (!engine) return;
    void engine.setBackgroundImage(file).then((ok) => {
      if (!ok) return;
      setNotice(t(K.sketchBackgroundAdded));
      sync();
    });
  };

  const download = () => {
    const engine = engineRef.current;
    if (!engine || typeof window === 'undefined') return;
    void engine.toBlob().then(
      (blob) => {
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.className = 'kb-visually-hidden';
        link.href = url;
        link.download = sketchFileName(name);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
      },
      () => {}
    );
  };

  const acceptDrop = p.accept_image_drop === true;
  const clearModel = dialogModel(sketchClearDialogProps(t, dialogOpen), t);
  const closeDialog = (confirmed: boolean) => {
    setDialogOpen(false);
    if (confirmed && engineRef.current) {
      engineRef.current.clear();
      changed();
    }
  };

  return (
    <div
      className="kb-sketch-board"
      role="group"
      aria-label={p.label}
      data-name={name || undefined}
      data-background={background}
      data-state={empty ? 'empty' : 'dirty'}
      onKeyDown={(event) => {
        if (text) return;
        const key = event.key.toLowerCase();
        if (key === 'z' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
          event.preventDefault();
          if (engineRef.current?.undo()) changed();
        }
      }}
      onPaste={
        acceptDrop
          ? (event) => {
              const files = event.clipboardData ? event.clipboardData.files : null;
              if (!files || files.length === 0) return;
              event.preventDefault();
              takeImage(files[0]);
            }
          : undefined
      }
    >
      <div className="kb-sketch-board__bar">
        <PaletteView
          ids={ids}
          label={p.label}
          state={{ ...initial, tool, color, width, canUndo }}
          allowCustom={p.allow_custom_color !== false}
          orientation="horizontal"
          showClear
          showDownload={p.show_download === true}
          clearRef={clearRef}
          onTool={(next) => {
            if (text) closeText(true);
            engineRef.current?.setTool(next);
            setTool(next);
          }}
          onColor={(next) => {
            engineRef.current?.setColor(next);
            setColor(next);
          }}
          onWidth={(next) => {
            engineRef.current?.setWidth(next);
            setWidth(next);
          }}
          onUndo={() => {
            if (engineRef.current?.undo()) changed();
          }}
          onClear={() => setDialogOpen(true)}
          onDownload={download}
        />
      </div>
      <div
        className="kb-sketch-board__stage"
        data-dragging={dragging ? 'true' : undefined}
        onDragEnter={
          acceptDrop
            ? (event) => {
                event.preventDefault();
                setDragging(true);
              }
            : undefined
        }
        onDragOver={
          acceptDrop
            ? (event) => {
                event.preventDefault();
                setDragging(true);
              }
            : undefined
        }
        onDragLeave={acceptDrop ? () => setDragging(false) : undefined}
        onDrop={
          acceptDrop
            ? (event) => {
                event.preventDefault();
                setDragging(false);
                takeImage(event.dataTransfer ? event.dataTransfer.files[0] : null);
              }
            : undefined
        }
      >
        <canvas
          className="kb-sketch-board__canvas"
          width={size.width}
          height={size.height}
          role="img"
          aria-label={t(K.sketchCanvas, { label: p.label })}
          aria-describedby={acceptDrop ? ids.hint : undefined}
          tabIndex={0}
          ref={canvasRef}
        />
        {text ? (
          <input
            className="kb-sketch-board__text"
            type="text"
            aria-label={t(K.sketchTextInput)}
            style={
              {
                left: `${text.left}%`,
                top: `${text.top}%`,
                '--kb-sketch-ink': color,
              } as CSSProperties
            }
            ref={textRef}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                closeText(true);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeText(false);
              }
            }}
            onBlur={() => closeText(true)}
          />
        ) : null}
      </div>
      {acceptDrop ? (
        <p className="kb-sketch-board__hint" id={ids.hint}>
          {t(K.sketchDropHint)}
        </p>
      ) : null}
      <p className="kb-sketch-board__notice" role="status">
        {notice}
      </p>
      <div className="kb-sketch-board__dialog">
        <DialogView
          model={clearModel}
          ids={{
            root: ids.dialog,
            title: `${ids.dialog}-title`,
            message: `${ids.dialog}-message`,
            input: `${ids.dialog}-input`,
          }}
          onResult={(button) => closeDialog(button.kind !== 'cancel')}
          onCancel={() => closeDialog(false)}
        />
      </div>
    </div>
  );
}
