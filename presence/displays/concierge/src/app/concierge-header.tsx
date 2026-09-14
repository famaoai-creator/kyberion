'use client';

import { useConciergeI18n } from '../lib/use-concierge-i18n';

// FD-00c: the Home / 資料の取込 / Setup nav links moved to `FrontDeskRail` —
// this header keeps only the crest/tagline and the locale switcher.
export function ConciergeHeader() {
  const { locale, setLocale, t } = useConciergeI18n();
  return (
    <header className="concierge-header">
      <div className="concierge-header-title">
        <span className="concierge-crest">秘</span>
        <div>
          <strong>{locale === 'ja' ? '秘書室' : 'Concierge'}</strong>
          <div className="concierge-tagline">{t('header.tagline')}</div>
        </div>
      </div>
      <div className="concierge-header-note">
        <select
          aria-label={t('locale.label')}
          value={locale}
          onChange={(event) => setLocale(event.target.value as 'en' | 'ja')}
        >
          <option value="ja">{t('locale.japanese')}</option>
          <option value="en">{t('locale.english')}</option>
        </select>
      </div>
    </header>
  );
}
