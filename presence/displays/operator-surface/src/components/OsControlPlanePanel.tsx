import type { CloudflareOsSurfaceSnapshot } from '@agent/core/cloudflare-os-surface';
import { Badge, Callout, EmptyState, Grid, List, Section } from '@agent/shared-ui';
import { operatorTranslator, type OperatorLocale } from '@/lib/i18n';
import { asKbStatus } from '@/lib/view';

/**
 * Cloudflare OS projection (read-only). Held actions and observations are
 * listed only; deciding / applying stays in the guarded surface, which is
 * offered as a link (never a form or a request from here).
 */
export default function OsControlPlanePanel({
  snapshot,
  tenantScope,
  guardedSurfaceUrl,
  locale,
}: {
  snapshot: CloudflareOsSurfaceSnapshot;
  tenantScope?: string;
  guardedSurfaceUrl?: string;
  locale: OperatorLocale;
}) {
  const t = operatorTranslator(locale);
  const held = snapshot.heldActions.slice(0, 8).map((item) => ({
    title: item.op,
    meta: [
      `${item.missionId} · ${item.tenantSlug || 'public'} · ${item.submittedBy}`,
      `${item.irreversible ? t('os_irreversible') : t('os_reversible')} · ${
        item.effectBinding || t('os_effect_binding_unavailable')
      }${item.failureRecorded ? ` · ${t('os_apply_failed')}` : ''}`,
      t('os_submitted_at', { at: item.submittedAt }),
    ].join(' · '),
    status: asKbStatus(item.status) ?? 'pending',
    status_label: item.status,
  }));
  const observations = snapshot.observations.slice(0, 8).map((item) => ({
    title: `${item.service} · ${item.tier}`,
    meta: [
      `${item.resourceRef} · ${item.purpose}`,
      item.summary,
      `${item.id} · ${t('os_observed_at', { at: item.observedAt })}`,
    ].join(' · '),
  }));

  return (
    <Section title={t('os_title')} description={t('os_description')}>
      <div className="operator-chips">
        <Badge label={t('os_eyebrow')} tone="accent" />
        <Badge label={t('read_only_badge')} tone="neutral" />
      </div>
      {!tenantScope ? (
        <Callout tone="warning" title={t('os_no_tenant_title')} body={t('os_no_tenant_body')} />
      ) : null}
      <Grid min_column_width="md" gap="md">
        <Section
          title={t('os_held_actions', { count: snapshot.heldActions.length })}
          headingLevel={3}
        >
          {held.length ? <List items={held} /> : <EmptyState title={t('os_held_actions_empty')} />}
        </Section>
        <Section
          title={t('os_observations', { count: snapshot.observations.length })}
          headingLevel={3}
        >
          {observations.length ? (
            <List items={observations} variant="timeline" />
          ) : (
            <EmptyState title={t('os_observations_empty')} />
          )}
        </Section>
      </Grid>
      {snapshot.heldActions.length ? (
        <Callout tone="warning" title={t('os_human_action_required')}>
          {guardedSurfaceUrl ? (
            <p className="kb-callout__body">
              <a href={guardedSurfaceUrl} className="kb-btn kb-btn--secondary">
                {t('os_open_guarded_surface')}
              </a>
            </p>
          ) : (
            <p className="kb-callout__body">{t('os_configure_guarded_surface')}</p>
          )}
        </Callout>
      ) : null}
    </Section>
  );
}
