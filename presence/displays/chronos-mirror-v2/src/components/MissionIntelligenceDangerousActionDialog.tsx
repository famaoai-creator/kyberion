import { Button } from '@agent/shared-ui';
import { resolveChronosLocale, uxTextOr } from '../lib/ux-vocabulary';

/**
 * Risky actions are always routed through this confirmation step before any
 * state changes: cancel (or a click on the scrim) drops the request, only
 * the explicit danger button runs `confirmDangerousAction`.
 */
export function MissionIntelligenceDangerousActionDialog({
  context,
}: {
  context: Record<string, unknown>;
}) {
  const { dangerousAction, clearDangerousAction, confirmDangerousAction } = context as {
    dangerousAction?: {
      title: string;
      detail: string;
      cancelLabel?: string;
      confirmLabel: string;
    };
    clearDangerousAction: () => void;
    confirmDangerousAction: () => Promise<void>;
  };
  if (!dangerousAction) return null;
  const locale = resolveChronosLocale();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      style={{ background: 'color-mix(in srgb, var(--kb-ui-canvas) 72%, transparent)' }}
      onClick={clearDangerousAction}
      role="presentation"
    >
      <div
        className="w-full max-w-lg"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') clearDangerousAction();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chronos-dangerous-action-title"
        aria-describedby="chronos-dangerous-action-detail"
      >
        <section className="kb-section" data-tone="danger">
          <header className="kb-section__header">
            <div className="kb-section__heading">
              <p className="kb-text kb-text--caption">
                {uxTextOr('chronos_mi_risky_confirmation', 'Confirm a risky action', locale)}
              </p>
              <h2 id="chronos-dangerous-action-title" className="kb-section__title">
                {dangerousAction.title}
              </h2>
              <p id="chronos-dangerous-action-detail" className="kb-section__description">
                {dangerousAction.detail}
              </p>
            </div>
          </header>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              label={dangerousAction.cancelLabel || uxTextOr('chronos_mi_cancel', 'Cancel', locale)}
              variant="secondary"
              onClick={clearDangerousAction}
            />
            <Button
              label={dangerousAction.confirmLabel}
              variant="danger"
              onClick={() => void confirmDangerousAction()}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
