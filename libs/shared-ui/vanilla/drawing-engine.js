/*
 * Kyberion UI — sketch drawing engine (PA-01, PADS_A2UI_AND_AVATAR_PLAN
 * §3) used by `ui:sketch-board` in BOTH renderers: the vanilla renderer
 * creates it while rendering, the React `SketchBoard` in an effect.
 *
 * It owns one `<canvas>`: pointer input (mouse / pen / touch), the stroke
 * list with a bounded undo stack, live shape preview and the PNG export.
 * Layers: background fill → background image → strokes (drawn on an
 * offscreen layer so the eraser never erases the background). Strokes older
 * than `maxUndo` are flattened into a base layer.
 *
 * DOM access is limited to the given canvas / document / window; a missing
 * 2D context (tests, very old engines) keeps the stroke bookkeeping working
 * and simply paints nothing.
 */
import {
  KB_DRAWING_BACKGROUNDS,
  KB_DRAWING_DEFAULT_COLORS,
  KB_DRAWING_DEFAULT_WIDTH,
  KB_SKETCH_DEFAULT_MAX_UNDO,
  KB_SKETCH_DEFAULT_SIZE,
  KB_DRAWING_TOOLS,
  normalizeHexColor,
} from './drawing-core.js';

const FREEHAND = new Set(['pen', 'highlighter', 'eraser']);

function context2d(canvas) {
  try {
    return canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  } catch {
    return null;
  }
}

function makeCanvas(doc, width, height) {
  if (!doc || typeof doc.createElement !== 'function') return null;
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Font size (canvas px) of the text tool for a stroke width. */
export function sketchTextSize(width) {
  return Math.max(14, 12 + width * 4);
}

/** Paint one stroke onto a 2D context. */
export function paintStroke(g, stroke) {
  if (!g || !stroke) return;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = stroke.color;
  g.fillStyle = stroke.color;
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  if (stroke.tool === 'text') {
    g.font = `600 ${stroke.size}px system-ui, sans-serif`;
    g.textBaseline = 'top';
    const lines = String(stroke.text).split('\n');
    lines.forEach((line, index) =>
      g.fillText(line, stroke.x, stroke.y + index * stroke.size * 1.25)
    );
    g.restore();
    return;
  }
  if (FREEHAND.has(stroke.tool)) {
    if (stroke.tool === 'highlighter') {
      g.globalAlpha = 0.35;
      g.lineWidth = stroke.width * 3;
      g.lineCap = 'square';
    } else if (stroke.tool === 'eraser') {
      g.globalCompositeOperation = 'destination-out';
      g.lineWidth = stroke.width * 4;
    } else {
      g.lineWidth = stroke.width;
    }
    const points = stroke.points;
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    if (points.length === 1) g.lineTo(points[0].x + 0.01, points[0].y + 0.01);
    for (let i = 1; i < points.length; i += 1) g.lineTo(points[i].x, points[i].y);
    g.stroke();
    g.restore();
    return;
  }
  g.lineWidth = stroke.width;
  const { from, to } = stroke;
  g.beginPath();
  if (stroke.tool === 'rect') {
    g.rect(
      Math.min(from.x, to.x),
      Math.min(from.y, to.y),
      Math.abs(to.x - from.x),
      Math.abs(to.y - from.y)
    );
  } else if (stroke.tool === 'ellipse') {
    const rx = Math.abs(to.x - from.x) / 2;
    const ry = Math.abs(to.y - from.y) / 2;
    g.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, rx, ry, 0, 0, Math.PI * 2);
  } else {
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    if (stroke.tool === 'arrow') {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const head = Math.max(10, stroke.width * 3);
      g.moveTo(to.x, to.y);
      g.lineTo(
        to.x - head * Math.cos(angle - Math.PI / 6),
        to.y - head * Math.sin(angle - Math.PI / 6)
      );
      g.moveTo(to.x, to.y);
      g.lineTo(
        to.x - head * Math.cos(angle + Math.PI / 6),
        to.y - head * Math.sin(angle + Math.PI / 6)
      );
    }
  }
  g.stroke();
  g.restore();
}

/** A shape stroke too small to see (a click without a drag) is dropped. */
export function isVisibleStroke(stroke) {
  if (!stroke) return false;
  if (stroke.tool === 'text') return String(stroke.text).trim() !== '';
  if (FREEHAND.has(stroke.tool)) return stroke.points.length > 0;
  return Math.abs(stroke.to.x - stroke.from.x) + Math.abs(stroke.to.y - stroke.from.y) >= 2;
}

/** Scale "contain" fit of an image into the canvas: `{ x, y, w, h }`. */
export function containFit(imageWidth, imageHeight, width, height) {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return { x: 0, y: 0, w: width, h: height };
  const scale = Math.min(width / imageWidth, height / imageHeight);
  const w = imageWidth * scale;
  const h = imageHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/**
 * Create the engine for `canvas`.
 * @param {{
 *   canvas: any, doc?: any, win?: any,
 *   width?: number, height?: number, background?: string, maxUndo?: number,
 *   tool?: string, color?: string, size?: number,
 *   onCommit?: (count: number) => void,
 *   onTextRequest?: (request: { x: number, y: number, left: number, top: number }) => void,
 * }} options
 */
export function createDrawingEngine(options) {
  const canvas = options.canvas;
  const doc = options.doc;
  const win = options.win;
  const width =
    Number.isInteger(options.width) && options.width > 0
      ? options.width
      : KB_SKETCH_DEFAULT_SIZE.width;
  const height =
    Number.isInteger(options.height) && options.height > 0
      ? options.height
      : KB_SKETCH_DEFAULT_SIZE.height;
  const maxUndo =
    Number.isInteger(options.maxUndo) && options.maxUndo > 0
      ? options.maxUndo
      : KB_SKETCH_DEFAULT_MAX_UNDO;
  const fill = Object.prototype.hasOwnProperty.call(KB_DRAWING_BACKGROUNDS, options.background)
    ? KB_DRAWING_BACKGROUNDS[options.background]
    : KB_DRAWING_BACKGROUNDS.dark;
  if (canvas) {
    canvas.width = width;
    canvas.height = height;
  }
  const layer = makeCanvas(doc, width, height);
  const base = makeCanvas(doc, width, height);
  const state = {
    tool: KB_DRAWING_TOOLS.includes(options.tool) ? options.tool : 'pen',
    color: normalizeHexColor(options.color) || KB_DRAWING_DEFAULT_COLORS[0],
    size:
      Number.isFinite(options.size) && options.size > 0 ? options.size : KB_DRAWING_DEFAULT_WIDTH,
  };
  let strokes = [];
  let flattened = 0;
  let current = null;
  let pointerId = null;
  let image = null;
  let frame = 0;
  let disposed = false;
  const listeners = [];

  const render = () => {
    frame = 0;
    const g = context2d(canvas);
    if (!g) return;
    const lg = context2d(layer);
    if (lg) {
      lg.clearRect(0, 0, width, height);
      if (base) lg.drawImage(base, 0, 0);
      for (const stroke of strokes) paintStroke(lg, stroke);
      if (current) paintStroke(lg, current);
    }
    g.clearRect(0, 0, width, height);
    if (fill) {
      g.fillStyle = fill;
      g.fillRect(0, 0, width, height);
    }
    if (image) {
      const box = containFit(
        image.naturalWidth || image.width,
        image.naturalHeight || image.height,
        width,
        height
      );
      g.drawImage(image, box.x, box.y, box.w, box.h);
    }
    if (layer && lg) {
      g.drawImage(layer, 0, 0);
    } else {
      // No offscreen layer: paint straight onto the canvas (the eraser then
      // also erases the background, which is the best this engine can do).
      if (base) g.drawImage(base, 0, 0);
      for (const stroke of strokes) paintStroke(g, stroke);
      if (current) paintStroke(g, current);
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (win && typeof win.requestAnimationFrame === 'function') {
      if (!frame) frame = win.requestAnimationFrame(render);
    } else {
      render();
    }
  };

  const count = () => flattened + strokes.length;

  const commit = (stroke) => {
    if (!isVisibleStroke(stroke)) {
      render();
      return;
    }
    strokes.push(stroke);
    while (strokes.length > maxUndo) {
      const oldest = strokes.shift();
      paintStroke(context2d(base), oldest);
      flattened += 1;
    }
    render();
    if (typeof options.onCommit === 'function') options.onCommit(count());
  };

  const point = (event) => {
    const rect =
      canvas && typeof canvas.getBoundingClientRect === 'function'
        ? canvas.getBoundingClientRect()
        : null;
    const cx = Number(event.clientX) || 0;
    const cy = Number(event.clientY) || 0;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { x: cx, y: cy };
    return {
      x: Math.round(((cx - rect.left) * width) / rect.width),
      y: Math.round(((cy - rect.top) * height) / rect.height),
    };
  };

  const on = (type, handler) => {
    if (!canvas || typeof canvas.addEventListener !== 'function') return;
    canvas.addEventListener(type, handler);
    listeners.push([type, handler]);
  };

  on('pointerdown', (event) => {
    if (disposed || !event) return;
    if (event.pointerType === 'mouse' && typeof event.button === 'number' && event.button !== 0)
      return;
    const at = point(event);
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (state.tool === 'text') {
      if (typeof options.onTextRequest === 'function') {
        options.onTextRequest({
          x: at.x,
          y: at.y,
          left: (at.x / width) * 100,
          top: (at.y / height) * 100,
        });
      }
      return;
    }
    pointerId = event.pointerId ?? null;
    if (pointerId !== null && typeof canvas.setPointerCapture === 'function') {
      try {
        canvas.setPointerCapture(pointerId);
      } catch {
        // capture is best effort
      }
    }
    current = FREEHAND.has(state.tool)
      ? { tool: state.tool, color: state.color, width: state.size, points: [at] }
      : { tool: state.tool, color: state.color, width: state.size, from: at, to: at };
    schedule();
  });
  on('pointermove', (event) => {
    if (!current || !event) return;
    if (pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId)
      return;
    const at = point(event);
    if (FREEHAND.has(current.tool)) current.points.push(at);
    else current.to = at;
    schedule();
  });
  const finish = (event) => {
    if (!current) return;
    if (event && event.type !== 'pointercancel' && event.clientX !== undefined) {
      const at = point(event);
      if (FREEHAND.has(current.tool)) {
        const last = current.points[current.points.length - 1];
        if (!last || last.x !== at.x || last.y !== at.y) current.points.push(at);
      } else {
        current.to = at;
      }
    }
    const stroke = current;
    current = null;
    pointerId = null;
    if (event && event.type === 'pointercancel') {
      render();
      return;
    }
    commit(stroke);
  };
  on('pointerup', finish);
  on('pointercancel', finish);

  const loadImage = (src, crossOrigin) =>
    new Promise((resolve) => {
      const Img = win && win.Image;
      if (typeof Img !== 'function') {
        resolve(null);
        return;
      }
      const img = new Img();
      if (crossOrigin) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });

  const api = {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    setTool(tool) {
      if (KB_DRAWING_TOOLS.includes(tool)) state.tool = tool;
    },
    setColor(color) {
      const hex = normalizeHexColor(color);
      if (hex) state.color = hex;
    },
    setWidth(size) {
      if (Number.isFinite(size) && size > 0) state.size = size;
    },
    getState() {
      return { ...state };
    },
    /** Committed strokes (flattened ones included). */
    strokeCount: count,
    canUndo() {
      return strokes.length > 0;
    },
    isEmpty() {
      return count() === 0 && !image;
    },
    hasBackground() {
      return Boolean(image);
    },
    undo() {
      if (strokes.length === 0) return false;
      strokes.pop();
      render();
      return true;
    },
    /** Remove every stroke (the background image stays). */
    clear() {
      strokes = [];
      flattened = 0;
      current = null;
      const bg = context2d(base);
      if (bg) bg.clearRect(0, 0, width, height);
      render();
    },
    /** Commit a text stroke at canvas coordinates. Returns false for blank text. */
    addText(at, value) {
      const stroke = {
        tool: 'text',
        color: state.color,
        size: sketchTextSize(state.size),
        x: at.x,
        y: at.y,
        text: String(value ?? ''),
      };
      if (!isVisibleStroke(stroke)) return false;
      commit(stroke);
      return true;
    },
    /**
     * Use a `File`/`Blob` or an http(s) / same-origin URL as the background
     * (null removes it). Resolves true when the image loaded.
     */
    async setBackgroundImage(source) {
      if (source === null || source === undefined) {
        image = null;
        render();
        return true;
      }
      let url = null;
      let revoke = null;
      let crossOrigin = false;
      if (typeof source === 'string') {
        url = source;
        crossOrigin = /^https?:/i.test(source);
      } else if (win && win.URL && typeof win.URL.createObjectURL === 'function') {
        url = win.URL.createObjectURL(source);
        revoke = url;
      }
      if (!url) return false;
      const loaded = await loadImage(url, crossOrigin);
      if (revoke) win.URL.revokeObjectURL(revoke);
      if (!loaded || disposed) return false;
      image = loaded;
      render();
      return true;
    },
    /** PNG of the whole board (background included). */
    toBlob() {
      render();
      return new Promise((resolve, reject) => {
        if (!canvas || typeof canvas.toBlob !== 'function') {
          reject(new Error('kyberion-ui: canvas export is unavailable'));
          return;
        }
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('kyberion-ui: canvas export failed'));
        }, 'image/png');
      });
    },
    render,
    dispose() {
      disposed = true;
      if (frame && win && typeof win.cancelAnimationFrame === 'function')
        win.cancelAnimationFrame(frame);
      frame = 0;
      if (canvas && typeof canvas.removeEventListener === 'function') {
        for (const [type, handler] of listeners) canvas.removeEventListener(type, handler);
      }
      listeners.length = 0;
      current = null;
    },
  };
  render();
  return api;
}
