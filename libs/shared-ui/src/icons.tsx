import type { ReactNode } from 'react';

/**
 * Minimal inline icon set (24px grid, stroke = currentColor) so the kit has
 * no icon-library dependency. Names match the catalog's `icon` pattern
 * (`^[a-z0-9-]{1,40}$`); unknown names render nothing.
 */
const PATHS: Readonly<Record<string, ReactNode>> = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5" />,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  chart: <path d="M4 20V4m0 16h16M8 16v-5m5 5V8m5 8v-3" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3m0 13v3M2.5 12h3m13 0h3M5.3 5.3l2.1 2.1m9.2 9.2 2.1 2.1M5.3 18.7l2.1-2.1m9.2-9.2 2.1-2.1" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14m0 3v.01" />
    </>
  ),
  inbox: <path d="M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" />
    </>
  ),
  file: <path d="M6 3h8l4 4v14H6zM14 3v4h4" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20.5h4" />,
  shield: <path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z" />,
  terminal: <path d="M3 5h18v14H3zM7 9l3 3-3 3m5 0h5" />,
  'arrow-up': <path d="M12 19V5m-6 6 6-6 6 6" />,
  'arrow-down': <path d="M12 5v14m-6-6 6 6 6-6" />,
  'arrow-right': <path d="M5 12h14m-6-6 6 6-6 6" />,
};

export const KB_ICON_NAMES: readonly string[] = Object.freeze(Object.keys(PATHS));

export interface KbIconProps {
  name?: string;
  className?: string;
  size?: number;
}

export function KbIcon({ name, className, size = 18 }: KbIconProps) {
  const path = name && Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name] : null;
  if (!path) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}
