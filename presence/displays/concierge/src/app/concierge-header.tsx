'use client';

import Link from 'next/link';
import { useConciergeI18n } from '../lib/use-concierge-i18n';

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
        <Link href="/" style={{ marginRight: 12 }}>
          {t('header.home')}
        </Link>
        <Link href="/ingest" style={{ marginRight: 12 }}>
          {t('header.ingest')}
        </Link>
        <Link href="/setup" style={{ marginRight: 12 }}>
          {t('header.setup')}
        </Link>
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
