'use client';
import * as React from 'react';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { createOutcomeFilesController } from '../lib/outcome-files-client';
import { createOutcomeFilesFocus } from '../lib/outcome-files-focus';
export function OutcomeFiles({ entryId, revision }: { entryId: string; revision: string }) {
  const { t } = useConciergeI18n();
  const id = React.useId();
  const panelId = 'outcome-files-' + id;
  const disclosureId = panelId + '-toggle';
  const panel = React.useRef<HTMLDivElement>(null);
  const errorPanel = React.useRef<HTMLDivElement>(null);
  const controller = React.useMemo(
    () => createOutcomeFilesController(entryId),
    [entryId, revision]
  );
  const state = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const focus = React.useMemo(() => createOutcomeFilesFocus(), []);
  React.useEffect(() => () => controller.dispose(), [controller]);
  React.useLayoutEffect(() => () => focus.cancel(), [controller, focus]);
  React.useEffect(() => {
    const moved = (event: FocusEvent) => focus.moved(event.target);
    const pointed = (event: PointerEvent) => {
      if (event.target instanceof Node) focus.pointed(event.target);
    };
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', pointed, true);
    window.addEventListener('blur', focus.cancel);
    return () => {
      document.removeEventListener('focusin', moved);
      document.removeEventListener('pointerdown', pointed, true);
      window.removeEventListener('blur', focus.cancel);
    };
  }, [focus]);
  React.useLayoutEffect(() => {
    focus.complete(controller, state, panel.current, errorPanel.current);
  }, [controller, state, focus]);
  const loadFromControl = (event: React.MouseEvent<HTMLButtonElement>, append: boolean) => {
    if (state.busy) return;
    focus.begin(controller, event.currentTarget, append ? state.files.length : 0);
    void (append ? controller.loadMore() : controller.open());
  };
  return (
    <div className="outcome-files">
      <button
        type="button"
        className="kb-btn kb-btn--secondary"
        id={disclosureId}
        aria-expanded={state.open}
        aria-controls={panelId}
        onClick={() => {
          focus.cancel();
          if (state.open) controller.close();
          else void controller.open();
        }}
      >
        {t(state.open ? 'home.files_hide' : 'home.files_show')}
      </button>
      <div
        ref={panel}
        id={panelId}
        hidden={!state.open}
        role="region"
        aria-labelledby={disclosureId}
        aria-live="polite"
        aria-busy={state.busy}
        tabIndex={-1}
      >
        {state.open ? (
          <>
            <p className="decide-muted">{t('home.files_scope')}</p>
            {state.error ? (
              <div ref={errorPanel} tabIndex={-1} role="alert">
                <p>{t('home.files_error')}</p>
                <button
                  type="button"
                  className="kb-btn kb-btn--secondary"
                  onClick={(event) => loadFromControl(event, false)}
                >
                  {t('home.files_retry')}
                </button>
              </div>
            ) : null}
            {!state.busy && !state.error && state.total === 0 ? (
              <p>{t('home.files_empty')}</p>
            ) : null}
            <ul>
              {state.files.map((file) => (
                <li key={file.index} data-outcome-file-index={file.index}>
                  {file.status === 'available' ? (
                    <a href={file.download_url} download>
                      {t('home.files_download', { name: file.name })}
                    </a>
                  ) : (
                    <span tabIndex={-1}>
                      {file.name ? file.name + ': ' : ''}
                      {t(
                        file.status === 'too_large'
                          ? 'home.files_too_large'
                          : 'home.files_unavailable'
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {state.busy ? <p>{t('home.files_loading')}</p> : null}
            {state.nextCursor && !state.error ? (
              <button
                type="button"
                className="kb-btn kb-btn--secondary"
                aria-disabled={state.busy}
                onClick={(event) => loadFromControl(event, true)}
              >
                {t('home.files_more')}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
