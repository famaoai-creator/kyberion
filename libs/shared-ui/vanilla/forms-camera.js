/*
 * Kyberion UI — camera & image helpers for the form components (UI-01c,
 * SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §3.3).
 *
 * The renderer-independent camera state machine plus frame capture / square
 * crop. Re-exported by `forms.js`. The camera starts only from a user action
 * and every track is stopped on capture / confirm / cancel / dispose /
 * `pagehide`; a stream that resolves for a superseded start() is stopped.
 */
/* global Blob, File */
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
  // Bumped by every start() and every stop: a getUserMedia promise that
  // resolves under an older generation (start → cancel → start, or a stop
  // while the permission prompt is open) is stale and its stream is stopped.
  let generation = 0;
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
    generation += 1;
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
      generation += 1;
      const token = generation;
      emit({ phase: 'starting', notice: null, previewUrl: null });
      try {
        const next = await win.navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing },
          audio: false,
        });
        if (disposed || token !== generation || state.phase !== 'starting') {
          stopStream(next);
          return;
        }
        if (stream && stream !== next) stopStream(stream);
        stream = next;
        emit({ phase: 'live' });
        if (video) controller.attach(video);
      } catch {
        // A stale request failing must not disturb the current one.
        if (disposed || token !== generation) return;
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
