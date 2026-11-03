'use client';

import { Button, Callout } from '@agent/shared-ui';
import { ChronosInline, ChronosMeta } from './chronos-ui';

type SurfaceStatusTone = 'neutral' | 'info' | 'warning' | 'error' | 'success';

/** Legacy tone → `ui:callout` tone. */
const CALLOUT_TONE: Record<SurfaceStatusTone, 'info' | 'success' | 'warning' | 'danger'> = {
  neutral: 'info',
  info: 'info',
  warning: 'warning',
  error: 'danger',
  success: 'success',
};

/**
 * UI-07: a status / empty / error notice, rendered as the shared `ui:callout`
 * (icon + title + body, tone from the status vocabulary) with optional
 * eyebrow / meta lines and up to two actions.
 */
export function SurfaceStatusPanel({
  eyebrow,
  title,
  detail,
  tone = 'neutral',
  meta,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: {
  eyebrow?: string;
  title: string;
  detail: string;
  tone?: SurfaceStatusTone;
  meta?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}) {
  return (
    <Callout tone={CALLOUT_TONE[tone]} title={title} body={detail}>
      {eyebrow ? <ChronosMeta>{eyebrow}</ChronosMeta> : null}
      {meta ? <ChronosMeta mono>{meta}</ChronosMeta> : null}
      {(actionLabel && onAction) || (secondaryActionLabel && onSecondaryAction) ? (
        <ChronosInline>
          {actionLabel && onAction ? <Button label={actionLabel} onClick={onAction} /> : null}
          {secondaryActionLabel && onSecondaryAction ? (
            <Button variant="ghost" label={secondaryActionLabel} onClick={onSecondaryAction} />
          ) : null}
        </ChronosInline>
      ) : null}
    </Callout>
  );
}
