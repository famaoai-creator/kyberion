import { KB_ICON_PATHS } from '../vanilla/kyberion-ui.js';

/**
 * Minimal inline icon set (24px grid, stroke = currentColor) so the kit has
 * no icon-library dependency. Path data is sourced from
 * `libs/shared-ui/vanilla/kyberion-ui.js` (single source shared with the
 * vanilla renderer); unknown names render nothing.
 */

export const KB_ICON_NAMES: readonly string[] = Object.freeze(Object.keys(KB_ICON_PATHS));

export interface KbIconProps {
  name?: string;
  className?: string;
  size?: number;
  /** Accessible name; makes the icon `role="img"` instead of decorative (`aria-hidden`). */
  label?: string;
}

export function KbIcon({ name, className, size = 18, label }: KbIconProps) {
  const paths =
    name && Object.prototype.hasOwnProperty.call(KB_ICON_PATHS, name) ? KB_ICON_PATHS[name] : null;
  if (!paths) return null;
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
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      {paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
