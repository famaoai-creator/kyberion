/*
 * personal-pads browser runtime — pure helpers (served at `/personal-pads/support.js`).
 * DOM-free except `el` / `composeLayers`; no user-visible text.
 */
/* global document, FileReader, Blob, Image, atob */

export const PAD_ICONS = Object.freeze({
  'memory-capture': 'book',
  'meeting-notepad': 'chat',
  'sketch-input': 'chart',
  'clipboard-inbox': 'inbox',
  'daily-desk': 'clock',
  'doc-drop': 'folder',
  'screenshot-annotate': 'search',
  'personal-workbench': 'user',
});
export const TIER_TONES = Object.freeze({
  personal: 'accent',
  confidential: 'warning',
  public: 'info',
});
export const READINESS_TONES = Object.freeze({
  ready: 'success',
  permission_required: 'info',
  unavailable: 'warning',
});
export const FILE_KINDS = new Set(['file', 'image', 'recording']);
export const BOARD_SIZE = Object.freeze({ width: 1280, height: 720 });

export function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '-');
}

export function interpolate(template, values) {
  return String(template || '')
    .replace(/\{([a-z0-9_]+)\}/gi, (_, key) => values[key] || '')
    .trim();
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** `data:<mime>;base64,...` → Blob (the kit only takes a Blob or an http(s) URL as a background). */
export function dataUrlToBlob(value) {
  const match = /^data:([^;,]*)?;base64,(.*)$/s.exec(String(value || ''));
  if (!match) return null;
  const binary = atob(match[2].replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] || 'application/octet-stream' });
}

export function dataUrlBytes(value) {
  const comma = String(value || '').indexOf(',');
  return comma < 0 ? 0 : Math.floor(((String(value).length - comma - 1) * 3) / 4);
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image failed to load'));
    image.src = src;
  });
}

/** Stack data-URL images (contain-fit) into one PNG the size of the board. */
export function composeLayers(layers, size) {
  if (layers.length === 1) return Promise.resolve(dataUrlToBlob(layers[0]));
  return Promise.all(layers.map(loadImage)).then(
    (images) =>
      new Promise((resolve, reject) => {
        const canvas = el('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const g = canvas.getContext('2d');
        for (const image of images) {
          const scale = Math.min(
            size.width / image.naturalWidth,
            size.height / image.naturalHeight
          );
          const w = image.naturalWidth * scale;
          const h = image.naturalHeight * scale;
          g.drawImage(image, (size.width - w) / 2, (size.height - h) / 2, w, h);
        }
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('export failed'))));
      })
  );
}

export function formatTime(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const options = { dateStyle: 'short', timeStyle: 'short' };
  try {
    return date.toLocaleString(locale, options);
  } catch {
    return date.toLocaleString(undefined, options);
  }
}

/** The adapter keys of one file field: `{id}`, `{id}_name_{i}`, `{id}_data[_{i}]`. */
export function fileKeyPattern(fieldId) {
  return new RegExp(`^${fieldId.replace(/[^A-Za-z0-9_]/g, '')}(?:_data(?:_\\d+)?|_name_\\d+)?$`);
}

/** Board name = the adapter download file name (the kit names the PNG after it). */
export function boardName(field) {
  return field.download && field.download.filename
    ? field.download.filename.replace(/\.png$/i, '')
    : field.id;
}

/**
 * The kit components of one adapter field (see the kind → component table in app.js).
 * `value` is the stored text value; `files` the `ui:file-drop` entries.
 */
export function fieldComponents(field, value, files) {
  const id = slug(field.id);
  const common = { name: field.id, label: field.label };
  if (field.help) common.help = field.help;
  switch (field.kind) {
    case 'textarea':
      return [
        {
          id: `pp-f-${id}`,
          type: 'ui:textarea',
          props: { ...common, placeholder: field.placeholder || '', value, rows: 4 },
        },
      ];
    case 'select':
      return [
        {
          id: `pp-f-${id}`,
          type: 'ui:select',
          props: { ...common, options: field.options || [], value },
        },
      ];
    case 'file':
    case 'image':
    case 'recording':
      return [
        {
          id: `pp-f-${id}`,
          type: 'ui:file-drop',
          props: {
            ...common,
            accept: field.accept || undefined,
            multiple: field.multiple === true,
            files,
          },
        },
      ];
    case 'drawing':
      return [
        {
          id: `pp-f-${id}`,
          type: 'ui:sketch-board',
          props: {
            name: boardName(field),
            label: field.label,
            tools: (field.drawing_tools || []).map((tool) => tool.id),
            background: field.overlay_field ? 'transparent' : 'light',
            canvas_width: BOARD_SIZE.width,
            canvas_height: BOARD_SIZE.height,
            show_download: Boolean(field.download),
            accept_image_drop: Boolean(field.overlay_field),
          },
        },
        ...(field.help
          ? [
              {
                id: `pp-f-${id}-help`,
                type: 'ui:text',
                props: { variant: 'caption', text: field.help },
              },
            ]
          : []),
      ];
    default:
      return [
        {
          id: `pp-f-${id}`,
          type: 'ui:text-field',
          props: { ...common, placeholder: field.placeholder || '', value },
        },
      ];
  }
}
