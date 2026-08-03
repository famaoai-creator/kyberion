'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';

/**
 * CS-03 文書取込 — the ingest ceremony as a dedicated page (linked from the
 * header). One document per submit, no watch folder, no auto-ingest: the
 * default is a dry-run preview so the operator sees what WOULD land before
 * explicitly committing it — an honest two-step ceremony.
 */

type TenantOption = {
  tenant_slug: string;
  display_name: string;
};

type IngestSummary = {
  dry_run: boolean;
  outcome: 'committed' | 'would_commit' | 'duplicate';
  target_path?: string;
  file_name: string;
  tenant: string;
};

const FORMAT_OPTIONS = ['docx', 'pdf', 'xlsx', 'html', 'markdown', 'text'] as const;

export default function IngestPage() {
  const { t } = useConciergeI18n();
  const [tenants, setTenants] = React.useState<TenantOption[]>([]);
  const [tenant, setTenant] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [format, setFormat] = React.useState('');
  const [dryRun, setDryRun] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);
  const [result, setResult] = React.useState<IngestSummary | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Tenant candidates come from the same catalog the /setup tenant
        // section uses (tenant registry via /api/setup).
        const response = await fetch('/api/setup', { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'setup failed');
        if (cancelled) return;
        const catalog = (payload.setup?.tenant?.catalog || []) as TenantOption[];
        setTenants(catalog);
        setTenant(String(payload.setup?.tenant?.active_slug || catalog[0]?.tenant_slug || ''));
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const acceptFile = React.useCallback((next: File | null) => {
    setFile(next);
    setResult(null);
    setNotice(null);
  }, []);

  const submit = React.useCallback(
    async (asDryRun: boolean) => {
      if (!file || !tenant || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const form = new FormData();
        form.set('file', file);
        form.set('tenant', tenant);
        if (format) form.set('format', format);
        if (asDryRun) form.set('dry_run', 'true');
        const response = await fetch('/api/ingest', { method: 'POST', body: form });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'ingest failed');
        setResult(payload.summary as IngestSummary);
        setNotice({ text: String(payload.message || '') });
        if (payload.summary?.outcome === 'committed') {
          // The ceremony is complete — the next upload starts fresh.
          setFile(null);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      } catch (error) {
        setResult(null);
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setBusy(false);
      }
    },
    [busy, file, format, tenant]
  );

  if (loadError) {
    return <div className="notice error">{t('ingest.load_error', { error: loadError })}</div>;
  }

  return (
    <section className="pane ingest-pane" aria-label={t('ingest.title')}>
      <h2>{t('ingest.title')}</h2>
      <p className="pane-subtitle">{t('ingest.description')}</p>

      <div
        className={`ingest-dropzone${dragOver ? ' dragover' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped) acceptFile(dropped);
        }}
      >
        <p className="item-body">{file ? file.name : t('ingest.drop_hint')}</p>
        <button
          type="button"
          className="action-button secondary"
          onClick={() => fileInputRef.current?.click()}
        >
          {t('ingest.choose_file')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={(event) => acceptFile(event.target.files?.[0] || null)}
        />
      </div>

      <label className="field-label">
        {t('ingest.tenant_label')}
        <select value={tenant} onChange={(event) => setTenant(event.target.value)}>
          {tenants.map((option) => (
            <option key={option.tenant_slug} value={option.tenant_slug}>
              {option.display_name} ({option.tenant_slug})
            </option>
          ))}
        </select>
      </label>

      <label className="field-label">
        {t('ingest.format_label')}
        <select value={format} onChange={(event) => setFormat(event.target.value)}>
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
          onChange={(event) => setDryRun(event.target.checked)}
        />{' '}
        {t('ingest.dry_run_label')}
      </label>
      <p className="item-meta">{t('ingest.dry_run_hint')}</p>

      <div className="button-row">
        <button
          type="button"
          className="action-button"
          disabled={!file || !tenant || busy}
          onClick={() => void submit(dryRun)}
        >
          {dryRun ? t('ingest.submit_preview') : t('ingest.submit_commit')}
        </button>
      </div>
      {busy ? <p className="item-meta">{t('ingest.busy')}</p> : null}

      {notice ? (
        <div className={`notice${notice.error ? ' error' : ''}`} style={{ marginTop: 12 }}>
          {notice.text}
        </div>
      ) : null}

      {result ? (
        <div className="item-card">
          <p className="item-title">
            {result.file_name}
            <span className={`status-chip${result.outcome === 'duplicate' ? '' : ' ok'}`}>
              {t(`ingest.outcome.${result.outcome}` as Parameters<typeof t>[0])}
            </span>
          </p>
          {result.target_path ? (
            <p className="item-meta">{t('ingest.target_path', { value: result.target_path })}</p>
          ) : null}
          <p className="item-meta">{t('ingest.tenant_note', { value: result.tenant })}</p>
          {result.dry_run && result.outcome === 'would_commit' && file ? (
            <div className="button-row">
              {/* The honest second step: commit exactly what was previewed. */}
              <button
                type="button"
                className="action-button"
                disabled={busy}
                onClick={() => void submit(false)}
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
