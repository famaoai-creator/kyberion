'use client';

import * as React from 'react';
import { A2UIActionProvider, KB_FORM_ACTIONS, useA2UIActions } from '@agent/shared-ui';

/**
 * UI-07 (wave 3b): small Chronos-side glue for the shared design system.
 *
 * shared-ui form controls (`TextField`, `Select`, `Segmented`, …) report
 * edits as `field.change` through the enclosing `A2UIActionProvider`. A panel
 * that owns local state wraps its controls in `ChronosFieldScope`: field
 * changes are handled locally, every other action (kb buttons with an
 * `action`) still bubbles to the page handler, and the host link component /
 * navigation are kept.
 */
export function ChronosFieldScope({
  onChange,
  children,
}: {
  onChange: (name: string, value: unknown) => void;
  children?: React.ReactNode;
}) {
  const parent = useA2UIActions();
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const parentAction = parent.onAction;
  const onAction = React.useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId === KB_FORM_ACTIONS.fieldChange && payload && typeof payload.name === 'string') {
        onChangeRef.current(payload.name, payload.value);
        return;
      }
      parentAction?.(actionId, payload);
    },
    [parentAction]
  );
  return (
    <A2UIActionProvider
      onAction={onAction}
      linkComponent={parent.linkComponent}
      navigate={parent.navigate}
    >
      {children}
    </A2UIActionProvider>
  );
}

/** A wrapping row of filters / actions above a list or table. */
export function ChronosToolbar({ children }: { children?: React.ReactNode }) {
  return <div className="chronos-toolbar">{children}</div>;
}

/** A wrapping row of small inline items (pills, badges, meta text). */
export function ChronosInline({ children }: { children?: React.ReactNode }) {
  return <div className="chronos-inline">{children}</div>;
}

/** Secondary one-line text (timestamps, ids, counts) under a title. */
export function ChronosMeta({ children, mono }: { children?: React.ReactNode; mono?: boolean }) {
  return (
    <span className="chronos-meta" data-mono={mono ? 'true' : undefined}>
      {children}
    </span>
  );
}

/** Horizontal-scroll container for wide diagrams (ui:flow / ui:sequence). */
export function ChronosDiagram({ children }: { children?: React.ReactNode }) {
  return <div className="chronos-diagram">{children}</div>;
}
