'use client';

import type { ReactNode } from 'react';
import { Dialog, DialogView } from './dialog.js';
import { DrawingPalette, PaletteView, SketchBoard } from './drawing.js';
import { Toolbar } from './toolbar.js';

/**
 * PA-01 pad components (PADS_A2UI_AND_AVATAR_PLAN_2026-09-23 §3).
 * `renderPadComponent` is the A2UIRenderer hook: it returns `undefined` for
 * types outside this group so the base switch handles them.
 */

export const KB_PAD_COMPONENT_TYPES = [
  'ui:toolbar',
  'ui:dialog',
  'ui:drawing-palette',
  'ui:sketch-board',
] as const;

export type KbPadComponentType = (typeof KB_PAD_COMPONENT_TYPES)[number];

const PAD_TYPES: ReadonlySet<string> = new Set(KB_PAD_COMPONENT_TYPES);

export function isKbPadComponentType(type: string): type is KbPadComponentType {
  return PAD_TYPES.has(type);
}

/** Render a pad catalog type with its A2UI component id (for deterministic DOM ids). */
export function renderPadComponent(
  type: string,
  id: string,
  rawProps: Record<string, unknown>,
  children?: ReactNode
): ReactNode | undefined {
  if (!isKbPadComponentType(type)) return undefined;
  // Props were schema-validated upstream (or are best-effort from a trusted
  // host); each component hardens what it reads.
  const p = <C extends (props: never) => unknown>(_component: C) =>
    ({ ...rawProps, id }) as unknown as Parameters<C>[0];
  switch (type) {
    case 'ui:toolbar':
      return <Toolbar {...p(Toolbar)} />;
    case 'ui:dialog':
      return <Dialog {...p(Dialog)}>{children}</Dialog>;
    case 'ui:drawing-palette':
      return <DrawingPalette {...p(DrawingPalette)} />;
    case 'ui:sketch-board':
      return <SketchBoard {...p(SketchBoard)} />;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export { Dialog, DialogView, DrawingPalette, PaletteView, SketchBoard, Toolbar };
