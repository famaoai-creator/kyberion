'use client';

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { KbToolbarProps } from '@agent/core/a2ui-catalog';
import {
  toolbarInitialFocus,
  toolbarItemAction,
  toolbarItems,
  toolbarRovingTarget,
  type KbToolbarItemModel,
} from '../../vanilla/pads.js';
import { useFormDispatch } from '../forms/shared.js';

export interface ToolbarProps extends KbToolbarProps {
  /** A2UI component id (unused for DOM ids; accepted for renderer symmetry). */
  id?: string;
}

/**
 * `ui:toolbar` (PA-01): WAI-ARIA toolbar with a roving tabindex. Toggles are
 * controlled (`pressed`) with a local echo until the next props; file items
 * open a hidden `<input type=file>` and hand the File objects only to
 * `onAction` (`{ id, files }`).
 */
export function Toolbar(p: ToolbarProps) {
  const dispatch = useFormDispatch();
  const items = useMemo(() => toolbarItems(p), [p]);
  const initial = toolbarInitialFocus(items);
  const [active, setActive] = useState(initial);
  // Local toggle echo, reset whenever new props arrive.
  const [echo, setEcho] = useState<{ source: unknown; pressed: Record<string, boolean> }>({
    source: p.items,
    pressed: {},
  });
  if (echo.source !== p.items) setEcho({ source: p.items, pressed: {} });
  const buttons = useRef(new Map<number, HTMLButtonElement | null>());
  const files = useRef(new Map<number, HTMLInputElement | null>());
  const current = items[active]?.focusable ? active : initial;

  const fire = (item: KbToolbarItemModel, runtime: Record<string, unknown>) =>
    dispatch(toolbarItemAction(item), { id: item.id, ...runtime });

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const target = toolbarRovingTarget(items, index, event.key);
    if (target < 0) return;
    event.preventDefault();
    setActive(target);
    buttons.current.get(target)?.focus();
  };

  return (
    <div
      className="kb-toolbar"
      role="toolbar"
      aria-label={p.label}
      data-density={p.density === 'compact' || p.density === 'comfortable' ? p.density : undefined}
      data-sticky={p.sticky === true ? 'true' : undefined}
    >
      {items.map((item, index) => {
        if (item.type === 'separator')
          return (
            <span
              key={item.key}
              className="kb-toolbar__separator"
              role="separator"
              aria-orientation="vertical"
            />
          );
        if (item.type === 'spacer')
          return <span key={item.key} className="kb-toolbar__spacer" aria-hidden="true" />;
        if (item.type === 'status')
          return (
            <span
              key={item.key}
              className="kb-toolbar__status"
              role="status"
              aria-live="polite"
              data-item-id={item.id || undefined}
              data-tone={item.tone || undefined}
            >
              {item.text}
            </span>
          );
        const pressed = Object.prototype.hasOwnProperty.call(echo.pressed, item.key)
          ? echo.pressed[item.key]
          : item.pressed;
        const button = (
          <button
            key={item.key}
            type="button"
            className={`kb-btn kb-btn--${item.variant} kb-toolbar__item`}
            data-item-type={item.type}
            data-item-id={item.id}
            tabIndex={index === current ? 0 : -1}
            disabled={item.disabled || undefined}
            aria-label={item.hideLabel ? item.label : undefined}
            title={item.hideLabel ? item.label : undefined}
            aria-pressed={item.type === 'toggle' ? pressed : undefined}
            ref={(node) => {
              buttons.current.set(index, node);
            }}
            onFocus={() => setActive(index)}
            onKeyDown={onKeyDown(index)}
            onClick={() => {
              if (item.disabled) return;
              setActive(index);
              if (item.type === 'file') {
                files.current.get(index)?.click();
                return;
              }
              if (item.type === 'toggle') {
                const next = !pressed;
                setEcho((prev) => ({ ...prev, pressed: { ...prev.pressed, [item.key]: next } }));
                fire(item, { pressed: next });
                return;
              }
              fire(item, {});
            }}
          >
            {item.icon ? (
              <span className="kb-toolbar__icon" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            {item.hideLabel ? null : <span className="kb-toolbar__label">{item.label}</span>}
          </button>
        );
        if (item.type !== 'file') return button;
        return [
          button,
          <input
            key={`${item.key}:input`}
            className="kb-toolbar__file"
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            hidden
            accept={item.accept || undefined}
            multiple={item.multiple || undefined}
            disabled={item.disabled || undefined}
            ref={(node) => {
              files.current.set(index, node);
            }}
            onChange={(event) => {
              const input = event.currentTarget;
              const picked = input.files ? Array.from(input.files) : [];
              try {
                input.value = '';
              } catch {
                // some engines refuse; harmless
              }
              if (picked.length > 0) fire(item, { files: picked });
            }}
          />,
        ];
      })}
    </div>
  );
}
