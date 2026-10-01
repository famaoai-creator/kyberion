'use client';

import * as React from 'react';
import { Button, Select, SettingRow, SettingsGroup, TextField } from '@agent/shared-ui';
import {
  DEFAULT_CHARTER_DRAFT,
  applyProposalToDraft,
  charterErrorKind,
  checkDraft,
  draftFromCharter,
  draftToForm,
  isManuallyStopped,
  parseCharterOverview,
  proposalDraftField,
  usagePercent,
  type CharterFormDraft,
  type CharterTenantView,
} from '../../../lib/charter-view';
import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

type Message = { text: string; error?: boolean } | null;

/**
 * 設定 › 組織とメンバー › 責任者憲章. What the AI may do without asking, who
 * answers for it, and the off switch. Owns its own load/save; the server is the
 * only authority (owner-only creation, digest-bound statement, responsible-only stop).
 */
export function CharterPane({ t }: { t: SettingsTranslate }) {
  const { locale } = useConciergeI18n();
  const [tenants, setTenants] = React.useState<CharterTenantView[]>([]);
  const [tenant, setTenant] = React.useState('');
  const [draft, setDraft] = React.useState<CharterFormDraft>(DEFAULT_CHARTER_DRAFT);
  const [preview, setPreview] = React.useState<{ statement: string; sha: string } | null>(null);
  const [agreed, setAgreed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<Message>(null);

  const current = tenants.find((entry) => entry.tenant_slug === tenant) ?? null;

  const load = React.useCallback(async () => {
    try {
      const response = await fetch(`/api/charters?locale=${locale}`, { cache: 'no-store' });
      const parsed = parseCharterOverview(await response.json().catch(() => null));
      if (!response.ok || !parsed) return;
      setTenants(parsed);
      setTenant((prev) =>
        parsed.some((e) => e.tenant_slug === prev) ? prev : (parsed[0]?.tenant_slug ?? '')
      );
    } catch {
      // The pane stays empty; the server is the authority either way.
    }
  }, [locale]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Switching organization (or reloading) restarts the form from that tenant's charter.
  React.useEffect(() => {
    setDraft(current?.charter ? draftFromCharter(current.charter) : DEFAULT_CHARTER_DRAFT);
    setPreview(null);
    setAgreed(false);
  }, [tenant, current?.charter?.charter_id]);

  const fail = (code: string) => {
    const kind = charterErrorKind(code);
    const text =
      kind === 'owner'
        ? t('setup.charter_err_owner')
        : kind === 'member'
          ? t('setup.charter_err_member')
          : kind === 'changed'
            ? t('setup.charter_err_changed')
            : kind === 'responsible'
              ? t('setup.charter_err_responsible')
              : t('setup.charter_err_generic', { detail: code });
    setMessage({ text, error: true });
  };

  const post = async (url: string, body: unknown): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !data || data.ok !== true) {
        fail(typeof data?.error === 'string' ? data.error : 'error');
        return null;
      }
      return data;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const check = checkDraft(draft);

  const review = async () => {
    if (!check.ok || !current) return;
    setAgreed(false);
    const data = await post('/api/charters', {
      action: 'preview',
      form: draftToForm(current.tenant_slug, draft),
    });
    if (data && typeof data.statement === 'string' && typeof data.statement_sha256 === 'string') {
      setPreview({ statement: data.statement, sha: data.statement_sha256 });
    }
  };

  const accept = async () => {
    if (!check.ok || !current || !preview || !agreed) return;
    const data = await post('/api/charters', {
      action: 'accept',
      form: draftToForm(current.tenant_slug, draft),
      statement_sha256: preview.sha,
    });
    if (data) {
      setMessage({ text: t('setup.charter_saved') });
      setPreview(null);
      setAgreed(false);
      await load();
    }
  };

  const act = async (action: 'stop' | 'clear' | 'retire') => {
    if (!current) return;
    const data = await post('/api/charters/tripwire', { tenant_slug: current.tenant_slug, action });
    if (data) {
      setMessage({ text: t('setup.charter_done') });
      await load();
    }
  };

  if (tenants.length === 0) return null;
  const stopped = current ? isManuallyStopped(current) : false;
  const onOff = (value: boolean) => (value ? 'on' : 'off');
  const yesNo = [
    { value: 'off', label: t('setup.charter_off_option') },
    { value: 'on', label: t('setup.charter_on_option') },
  ];
  const field = (key: keyof CharterFormDraft, label: string, id: string) => (
    <SettingRow label={label}>
      <TextField
        id={id}
        name={`charter.${key}`}
        label={label}
        hide_label
        value={String(draft[key])}
      />
    </SettingRow>
  );

  return (
    <FormScope
      fields={{
        'charter.tenant': (value) => setTenant(asText(value)),
        'charter.per_action': (v) => setDraft((d) => ({ ...d, per_action: asText(v) })),
        'charter.per_day': (v) => setDraft((d) => ({ ...d, per_day: asText(v) })),
        'charter.per_month': (v) => setDraft((d) => ({ ...d, per_month: asText(v) })),
        'charter.max_loss_per_incident': (v) =>
          setDraft((d) => ({ ...d, max_loss_per_incident: asText(v) })),
        'charter.deputies': (v) => setDraft((d) => ({ ...d, deputies: asText(v) })),
        'charter.expires_in_days': (v) => setDraft((d) => ({ ...d, expires_in_days: asText(v) })),
        'charter.allow_named_spend': (v) =>
          setDraft((d) => ({ ...d, allow_named_spend: asText(v) === 'on' })),
        'charter.supersedes_decision_rights': (v) =>
          setDraft((d) => ({ ...d, supersedes_decision_rights: asText(v) === 'on' })),
        'charter.agree': (v) => setAgreed(asText(v) === 'on'),
      }}
    >
      <SettingsGroup
        id="settings-charter"
        title={t('setup.charter_title')}
        description={t('setup.charter_description')}
      >
        {tenants.length > 1 ? (
          <SettingRow label={t('setup.charter_tenant')}>
            <Select
              id="charter-tenant"
              name="charter.tenant"
              label={t('setup.charter_tenant')}
              hide_label
              value={tenant}
              options={tenants.map((e) => ({ value: e.tenant_slug, label: e.tenant_slug }))}
            />
          </SettingRow>
        ) : null}

        {current?.charter ? (
          <div className="charter-current settings-row-block">
            <p>{t('setup.charter_responsible', { name: current.charter.responsible })}</p>
            <p>{t('setup.charter_expires', { date: current.charter.expires_at.slice(0, 10) })}</p>
            <p className="charter-report" style={{ whiteSpace: 'pre-wrap' }}>
              {current.charter.report_text}
            </p>
            {current.charter.report.money ? (
              <>
                {(
                  [
                    [
                      'setup.charter_usage_day',
                      current.charter.report.money.spent_today,
                      current.charter.money.per_day,
                    ],
                    [
                      'setup.charter_usage_month',
                      current.charter.report.money.spent_this_month,
                      current.charter.money.per_month,
                    ],
                  ] as const
                ).map(([key, spent, limit]) => (
                  <p key={key}>
                    <span>
                      {t(key, { spent: spent.toLocaleString(), limit: limit.toLocaleString() })}
                    </span>{' '}
                    <progress max={100} value={usagePercent(spent, limit)} />
                  </p>
                ))}
              </>
            ) : null}
            {(current.charter.report.amendment_proposals ?? []).length > 0 ? (
              <div className="charter-proposals">
                <h4>{t('setup.charter_proposals_title')}</h4>
                {(current.charter.report.amendment_proposals ?? []).map((proposal) => (
                  <div key={proposal.field} className="settings-row-block">
                    <p>
                      {t('setup.charter_proposal_line', {
                        count: String(proposal.count),
                        field: proposal.field,
                        current: String(proposal.current ?? '—'),
                        requested: String(proposal.requested ?? '—'),
                      })}
                    </p>
                    {current.can_create && proposalDraftField(proposal) ? (
                      <Button
                        label={t('setup.charter_proposal_apply')}
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setDraft((d) => applyProposalToDraft(d, proposal));
                          setPreview(null);
                          setAgreed(false);
                        }}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {stopped ? <p role="alert">{t('setup.charter_stopped')}</p> : null}
            {current.can_stop ? (
              <div className="settings-row-actions">
                {stopped ? (
                  <Button
                    label={t('setup.charter_resume')}
                    variant="primary"
                    disabled={busy}
                    onClick={() => void act('clear')}
                  />
                ) : (
                  <Button
                    label={t('setup.charter_stop')}
                    variant="danger"
                    disabled={busy}
                    onClick={() => void act('stop')}
                  />
                )}
                <Button
                  label={t('setup.charter_retire')}
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void act('retire')}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <p>{t('setup.charter_none')}</p>
        )}

        {current && !current.can_create ? <p>{t('setup.charter_owner_only')}</p> : null}

        {current?.can_create ? (
          <>
            <h4>{t('setup.charter_form_title')}</h4>
            {field('per_action', t('setup.charter_per_action'), 'charter-per-action')}
            {field('per_day', t('setup.charter_per_day'), 'charter-per-day')}
            {field('per_month', t('setup.charter_per_month'), 'charter-per-month')}
            {field('max_loss_per_incident', t('setup.charter_max_loss'), 'charter-max-loss')}
            {field('deputies', t('setup.charter_deputies'), 'charter-deputies')}
            {field('expires_in_days', t('setup.charter_expires_days'), 'charter-expires-days')}
            <SettingRow label={t('setup.charter_named_spend')}>
              <Select
                id="charter-named-spend"
                name="charter.allow_named_spend"
                label={t('setup.charter_named_spend')}
                hide_label
                value={onOff(draft.allow_named_spend)}
                options={yesNo}
              />
            </SettingRow>
            <SettingRow label={t('setup.charter_supersedes')}>
              <Select
                id="charter-supersedes"
                name="charter.supersedes_decision_rights"
                label={t('setup.charter_supersedes')}
                hide_label
                value={onOff(draft.supersedes_decision_rights)}
                options={yesNo}
              />
            </SettingRow>
            <div className="settings-row-actions">
              <Button
                label={t('setup.charter_review')}
                variant="secondary"
                disabled={busy || !check.ok}
                onClick={() => void review()}
              />
            </div>
            {!check.ok ? (
              <p role="status">{t('setup.charter_err_generic', { detail: check.reason })}</p>
            ) : null}
            {preview ? (
              <div className="charter-statement settings-row-block">
                <h4>{t('setup.charter_statement_title')}</h4>
                <p style={{ whiteSpace: 'pre-wrap' }}>{preview.statement}</p>
                <SettingRow label={t('setup.charter_agree')}>
                  <Select
                    id="charter-agree"
                    name="charter.agree"
                    label={t('setup.charter_agree')}
                    hide_label
                    value={onOff(agreed)}
                    options={yesNo}
                  />
                </SettingRow>
                <div className="settings-row-actions">
                  <Button
                    label={t('setup.charter_accept')}
                    variant="primary"
                    disabled={busy || !agreed}
                    onClick={() => void accept()}
                  />
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {message ? <p role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
      </SettingsGroup>
    </FormScope>
  );
}
