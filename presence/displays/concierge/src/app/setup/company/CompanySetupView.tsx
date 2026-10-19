import * as React from 'react';
import type { ConciergeMessageKey } from '../../../lib/i18n';
import {
  companyActionAllowed,
  companyApprovalHref,
  type CompanyAction,
  type CompanySetupState,
  type CompanyStage,
} from './company-setup-model';

type Translate = (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;
const STAGES: CompanyStage[] = [
  'unregistered',
  'registered',
  'awaiting_approval',
  'active',
  'first_work_prepared',
];
export function CompanySetupView({
  state,
  t,
  changeTenant,
  updateDraft,
  act,
  refresh,
  dismissReview,
}: {
  state: CompanySetupState;
  t: Translate;
  changeTenant: (tenant: string) => void;
  updateDraft: (patch: Partial<CompanySetupState['draft']>) => void;
  act: (action: CompanyAction) => void;
  refresh: () => void;
  dismissReview: () => void;
}) {
  const { setup, review, busy } = state;
  const action = (kind: CompanyAction, label: ConciergeMessageKey) => (
    <button
      type="button"
      className="action-button"
      disabled={!companyActionAllowed(state, kind)}
      onClick={() => act(kind)}
    >
      {t(label)}
    </button>
  );
  return (
    <main className="settings-page">
      <header>
        <h1 className="kb-text kb-text--title">{t('company_setup.title')}</h1>
        <p className="pane-subtitle">{t('company_setup.description')}</p>
      </header>
      <section className="pane" aria-label={t('company_setup.company')}>
        <label>
          {t('company_setup.company')}
          <select
            value={state.tenantSlug}
            onChange={(event) => changeTenant(event.target.value)}
            aria-label={t('company_setup.company')}
          >
            <option value="">{t('company_setup.choose_company')}</option>
            {state.tenants.map((tenant) => (
              <option key={tenant.slug} value={tenant.slug}>
                {tenant.name}
              </option>
            ))}
          </select>
        </label>
        <p className="pane-subtitle">{t('company_setup.tenant_hint')}</p>
        <a href="/setup/first-run">{t('company_setup.first_run')}</a>
      </section>
      {state.notice ? (
        <p className="notice error" role="alert">
          {t(('company_setup.' + state.notice) as ConciergeMessageKey)}
        </p>
      ) : null}
      {busy ? (
        <p role="status" aria-live="polite">
          {t('company_setup.busy')}
        </p>
      ) : null}
      <div className="button-row">
        <button type="button" className="action-button" disabled={busy} onClick={refresh}>
          {t('company_setup.refresh')}
        </button>
        {state.notice === 'expired' || state.notice === 'forbidden' ? (
          <a href="/login?next=%2Fsetup%2Fcompany">{t('management.sign_in')}</a>
        ) : null}
      </div>
      {setup ? (
        <>
          <section className="pane" aria-label={t('company_setup.progress')}>
            <h2>{t('company_setup.progress')}</h2>
            <ol>
              {STAGES.map((stage) => (
                <li key={stage} aria-current={stage === setup.stage ? 'step' : undefined}>
                  {t(('company_setup.stage_' + stage) as ConciergeMessageKey)}
                  {stage === setup.stage ? ' · ' + t('company_setup.current') : ''}
                </li>
              ))}
            </ol>
            <label>
              {t('company_setup.company_name')}
              <input value={setup.companyName} readOnly />
            </label>
            <p className="pane-subtitle">{t('company_setup.name_locked')}</p>
            {setup.organizationId ? <p>{setup.organizationId}</p> : null}
          </section>
          {setup.stage === 'unregistered' ? (
            <section className="pane" aria-label={t('company_setup.registration')}>
              <h2>{t('company_setup.registration')}</h2>
              <label>
                {t('company_setup.vertical')}
                <select
                  value={state.draft.vertical}
                  disabled={busy || state.needsRefresh}
                  onChange={(event) => updateDraft({ vertical: event.target.value })}
                >
                  <option value="">{t('company_setup.choose_vertical')}</option>
                  {setup.verticals.map((vertical) => (
                    <option key={vertical} value={vertical}>
                      {vertical}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('company_setup.first_work')}
                <textarea
                  value={state.draft.firstWork}
                  rows={4}
                  maxLength={4000}
                  disabled={busy || state.needsRefresh}
                  onChange={(event) => updateDraft({ firstWork: event.target.value })}
                />
              </label>
              <p className="pane-subtitle">{t('company_setup.registration_hint')}</p>
              {action('preview_company', 'company_setup.preview_company')}
            </section>
          ) : (
            <section className="pane" aria-label={t('company_setup.first_work')}>
              <h2>{t('company_setup.first_work')}</h2>
              <p>{setup.firstWork}</p>
            </section>
          )}
          {setup.probeSummary.length ? (
            <section className="pane" aria-label={t('company_setup.probe_results')}>
              <h2>{t('company_setup.probe_results')}</h2>
              <ul>
                {setup.probeSummary.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {setup.blockers.length ? (
            <section className="pane" aria-label={t('company_setup.blockers')}>
              <h2>{t('company_setup.blockers')}</h2>
              <ul>
                {setup.blockers.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {setup.stage === 'registered' ? (
            <section className="pane" aria-label={t('company_setup.activation')}>
              <h2>{t('company_setup.activation')}</h2>
              <p>{t('company_setup.probe_hint')}</p>
              <div className="button-row">
                {action('probe', 'company_setup.probe')}
                {action('request_activation', 'company_setup.request_activation')}
              </div>
            </section>
          ) : null}
          {setup.stage === 'awaiting_approval' ? (
            <section className="pane" aria-label={t('company_setup.approval')}>
              <h2>{t('company_setup.approval')}</h2>
              <p>{t('company_setup.approval_hint')}</p>
              {setup.activationApproval ? <p>{setup.activationApproval.id}</p> : null}
              <div className="button-row">
                <a className="action-button" href={companyApprovalHref(setup)}>
                  {t('company_setup.open_approval')}
                </a>
                {action('apply_activation', 'company_setup.apply_activation')}
              </div>
              <p className="pane-subtitle">{t('company_setup.apply_hint')}</p>
            </section>
          ) : null}
          {setup.stage === 'active' ? (
            <section className="pane" aria-label={t('company_setup.prepare_title')}>
              <h2>{t('company_setup.prepare_title')}</h2>
              <p>{t('company_setup.prepare_hint')}</p>
              {action('preview_first_work', 'company_setup.preview_first_work')}
            </section>
          ) : null}
          {review ? (
            <section className="pane" aria-label={t('company_setup.review')} aria-live="polite">
              <h2>{t('company_setup.review')}</h2>
              <h3>{review.title}</h3>
              <ul>
                {review.summary.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
              <p className="pane-subtitle">{t('company_setup.review_hint')}</p>
              <div className="button-row">
                {action(
                  review.action,
                  review.action === 'register_company'
                    ? 'company_setup.register_company'
                    : 'company_setup.apply_first_work'
                )}
                <button
                  type="button"
                  className="action-button"
                  disabled={busy}
                  onClick={dismissReview}
                >
                  {t('company_setup.cancel_review')}
                </button>
              </div>
            </section>
          ) : null}
          {setup.stage === 'first_work_prepared' ? (
            <p className="notice" role="status">
              {t('company_setup.prepared')}
            </p>
          ) : null}
          <p className="pane-subtitle">{t('company_setup.no_execution')}</p>
          <a
            href={
              '/management?' +
              new URLSearchParams({
                tenant: setup.tenantSlug,
                ...(setup.stage !== 'unregistered' && setup.organizationId
                  ? { organization_id: setup.organizationId }
                  : {}),
              })
            }
          >
            {t('company_setup.management')}
          </a>
        </>
      ) : null}
    </main>
  );
}
