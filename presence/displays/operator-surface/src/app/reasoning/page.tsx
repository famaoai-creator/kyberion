import { Section } from '@agent/shared-ui';
import SelectionSettings from '@/components/SelectionSettings';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { requireOperatorViewer } from '@/lib/viewer-context';
import { getReasoningSelectionSnapshot } from '@/lib/selection-service';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

export default async function ReasoningPage() {
  const viewer = await requireOperatorViewer();
  // Settings are a cached projection. Visiting this page never runs provider probes.
  let snapshot = null;
  try {
    snapshot = getReasoningSelectionSnapshot(viewer);
  } catch {
    /* Keep configuration failures visible without exposing raw file/provider details. */
  }
  emitMosRead({
    page: '/reasoning',
    resource_kind: 'reasoning_routes',
    result_count: snapshot?.rows.length ?? 0,
  });
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);
  return (
    <>
      <OperatorPageHeader title={t('reasoning_title')} subtitle={t('reasoning_subtitle')} />
      {snapshot ? (
        <SelectionSettings target={{ kind: 'reasoning' }} initial={snapshot} locale={locale} />
      ) : (
        <Section title={t('selection_reasoning_title')}>
          <p role="alert">{t('selection_error')}</p>
        </Section>
      )}
    </>
  );
}
