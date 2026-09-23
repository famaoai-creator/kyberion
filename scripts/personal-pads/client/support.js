/*
 * personal-pads browser runtime — pure helpers (served at `/personal-pads/support.js`).
 * DOM-free except `el`; no user-visible text.
 */
/* global document, FileReader */

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

export function dataUrlBytes(value) {
  const comma = String(value || '').indexOf(',');
  return comma < 0 ? 0 : Math.floor(((String(value).length - comma - 1) * 3) / 4);
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
            name: field.id,
            label: field.label,
            tools: (field.drawing_tools || []).map((tool) => tool.id),
            background: field.overlay_field ? 'transparent' : 'light',
            canvas_width: BOARD_SIZE.width,
            canvas_height: BOARD_SIZE.height,
            show_download: Boolean(field.download),
            ...(field.download && field.download.filename
              ? { download_name: field.download.filename }
              : {}),
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
