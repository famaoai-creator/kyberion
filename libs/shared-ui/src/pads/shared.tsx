'use client';

import { KB_DRAWING_ICON_PATHS } from '../../vanilla/pads.js';

/**
 * Shared pieces of the React pad components (PA-01). Markup mirrors
 * `libs/shared-ui/vanilla/{toolbar,dialog,drawing}.js` exactly (parity-tested).
 */

/** Decorative 18px glyph from the shared drawing icon set (tools, undo, clear, download). */
export function PadIcon({ name }: { name: string }) {
  const paths = Object.prototype.hasOwnProperty.call(KB_DRAWING_ICON_PATHS, name)
    ? KB_DRAWING_ICON_PATHS[name]
    : [];
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** `true` when a DOM node can still take focus (still attached to a document). */
export function canRefocus(node: unknown): node is HTMLElement {
  return (
    Boolean(node) &&
    typeof (node as HTMLElement).focus === 'function' &&
    (node as { isConnected?: boolean }).isConnected !== false
  );
}
