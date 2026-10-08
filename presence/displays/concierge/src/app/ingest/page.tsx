'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { useIngestFlow } from '../../lib/use-ingest-flow';

/**
 * CS-03 文書取込 — the ingest ceremony as a dedicated page (linked from the
 * header). One document per submit, no watch folder, no auto-ingest: the
 * default is a dry-run preview so the operator sees what WOULD land before
 * explicitly committing it — an honest two-step ceremony.
 */

const FORMAT_OPTIONS = ['docx', 'pdf', 'xlsx', 'html', 'markdown', 'text'] as const;

export default function IngestPage() {
  const { t } = useConciergeI18n();
  const flow = useIngestFlow();
  const {
    tenants,
    selection: { file, tenant, format },
    dryRun,
    pending,
    result,
    failure,
    uncertain,
    access,
    loading,
    loadError,
  } = flow;
  const busy = pending !== null;
  const disabled = busy || loading || loadError || access !== null;
  const [dragOver, setDragOver] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (!file && fileInputRef.current) fileInputRef.current.value = '';
  }, [file]);

  return (
    <section className="pane ingest-pane" aria-label={t('ingest.title')}>
      <h2>{t('ingest.title')}</h2>
      <p className="pane-subtitle">{t('ingest.description')}</p>

      {loading ? <p role="status">{t('ingest.loading')}</p> : null}
      {loadError || access ? (
        <div className="notice error" role="alert">
          <p>
            {t(
              access === 401
                ? 'ingest.signin_required'
                : access === 403
                  ? 'ingest.access_denied'
                  : 'ingest.prepare_failed'
            )}
          </p>
          {access === 401 ? <a href="/signin">{t('ingest.signin')}</a> : null}
          <button
            type="button"
            className="action-button secondary"
            disabled={busy || loading}
            onClick={flow.reload}
          >
            {t('ingest.reload')}
          </button>
        </div>
      ) : null}
      {!loading && !loadError && !access && tenants.length === 0 ? (
        <div>
          <p role="status">{t('ingest.no_destination')}</p>
          <button type="button" className="action-button secondary" onClick={flow.reload}>
            {t('ingest.reload')}
          </button>
        </div>
      ) : null}
      {uncertain ? (
        <div className="notice error" role="alert">
          <p>
            {t('ingest.commit_uncertain', {
              file: uncertain.file?.name || '',
              tenant: uncertain.tenant,
            })}
          </p>
          <p>{t('ingest.uncertain_guidance')}</p>
        </div>
      ) : null}
      <div
        className={`ingest-dropzone${dragOver ? ' dragover' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped && !disabled) flow.changeSelection({ file: dropped });
        }}
      >
        <p className="item-body">{file ? file.name : t('ingest.drop_hint')}</p>
        <button
          type="button"
          className="action-button secondary"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          {t('ingest.choose_file')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          disabled={disabled}
          onChange={(event) => {
            if (!disabled) flow.changeSelection({ file: event.target.files?.[0] || null });
          }}
        />
      </div>

      <label className="field-label">
        {t('ingest.tenant_label')}
        <select
          disabled={disabled}
          value={tenant}
          onChange={(event) => flow.changeSelection({ tenant: event.target.value })}
        >
          {tenants.map((option) => (
            <option key={option.tenant_slug} value={option.tenant_slug}>
              {option.display_name} ({option.tenant_slug})
            </option>
          ))}
        </select>
      </label>

      <label className="field-label">
        {t('ingest.format_label')}
        <select
          disabled={disabled}
          value={format}
          onChange={(event) => flow.changeSelection({ format: event.target.value })}
        >
          <option value="">{t('ingest.format_auto')}</option>
          {FORMAT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="field-label ingest-dry-run">
        <input
          type="checkbox"
          checked={dryRun}
          disabled={disabled || uncertain !== null}
          onChange={(event) => flow.changeDryRun(event.target.checked)}
        />{' '}
        {t('ingest.dry_run_label')}
      </label>
      <p className="item-meta">{t('ingest.dry_run_hint')}</p>

      <div className="button-row">
        <button
          type="button"
          className="action-button"
          disabled={!file || !tenant || disabled}
          onClick={() => void flow.submit(dryRun)}
        >
          {dryRun ? t('ingest.submit_preview') : t('ingest.submit_commit')}
        </button>
      </div>
      {busy ? (
        <p className="item-meta" role="status">
          {t(pending === 'commit' ? 'ingest.filing' : 'ingest.busy')}
        </p>
      ) : null}

      {failure ? (
        <div className="notice error" role="alert">
          <p>{failure.detail}</p>
          <p>{t(failure.key)}</p>
        </div>
      ) : null}

      {result ? (
        <div className="item-card" role="status">
          <p className="item-title">
            {result.file_name}
            <span className={`status-chip${result.outcome === 'duplicate' ? '' : ' ok'}`}>
              {t(
                result.outcome === 'duplicate'
                  ? 'ingest.duplicate_label'
                  : (`ingest.outcome.${result.outcome}` as Parameters<typeof t>[0])
              )}
            </span>
          </p>
          {result.target_path && result.outcome !== 'duplicate' ? (
            <p className="item-meta">{t('ingest.target_path', { value: result.target_path })}</p>
          ) : null}
          <p className="item-meta">{t('ingest.requested_destination', { value: result.tenant })}</p>
          {result.outcome === 'duplicate' ? <p>{t('ingest.duplicate_note')}</p> : null}
          {flow.canConfirm ? (
            <div className="button-row">
              {/* The honest second step: submit the reviewed client selection (not a server-bound token). */}
              <button
                type="button"
                className="action-button"
                disabled={disabled}
                onClick={() => void flow.submit(false, true)}
              >
                {t('ingest.commit_after_preview')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
