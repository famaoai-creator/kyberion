import { actionButtonClass } from './MissionIntelligenceViewHelpers';

export function MissionIntelligenceDangerousActionDialog(context: Record<string, unknown>) {
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
  return (
    <>
      {dangerousAction ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center kb-surface-well px-4 py-6"
          onClick={clearDangerousAction}
          role="presentation"
        >
          <div
            className="w-full max-w-lg rounded-2xl border kb-border-subtle bg-[#0b1020] p-5 shadow-2xl shadow-black/40"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="chronos-dangerous-action-title"
          >
            <div className="text-[10px] uppercase tracking-[0.26em] kb-status-negative">
              risky action confirmation
            </div>
            <div
              id="chronos-dangerous-action-title"
              className="mt-2 text-lg font-semibold tracking-tight kb-text-primary"
            >
              {dangerousAction.title}
            </div>
            <div className="mt-3 text-[12px] leading-6 kb-text-secondary">
              {dangerousAction.detail}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={clearDangerousAction}
                className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
              >
                {dangerousAction.cancelLabel || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => void confirmDangerousAction()}
                className={actionButtonClass('risky')}
              >
                {dangerousAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
