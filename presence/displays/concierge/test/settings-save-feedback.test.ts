import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SettingsSaveFeedback,
  type SettingsSaveFeedbackState,
} from '../src/app/settings/sections/SettingsSaveFeedback';
import { conciergeText, type ConciergeMessageKey } from '../src/lib/i18n';

describe('settings save feedback semantics', () => {
  for (const locale of ['en', 'ja'] as const)
    for (const phase of ['saving', 'saved', 'unconfirmed', 'unavailable'] as const) {
      it(locale + ' ' + phase + ' has exactly one live region and localized guidance', () => {
        const html = renderToStaticMarkup(
          createElement(SettingsSaveFeedback, {
            feedback: { section: 'notifications', phase },
            t: (key: ConciergeMessageKey) => conciergeText(key, locale),
          })
        );
        expect(html.match(/role="(?:status|alert)"/g) || []).toHaveLength(1);
        expect(html).not.toContain('setup.');
        expect(html).toContain(
          phase === 'saving'
            ? conciergeText('setup.section_save_pending', locale)
            : phase === 'unconfirmed'
              ? conciergeText('setup.draft_save_unconfirmed', locale)
              : phase === 'unavailable'
                ? conciergeText('setup.draft_context_unavailable', locale)
                : conciergeText('setup.notification_saved', locale)
        );
      });
    }
  it('describes confirmed submitted changes separately from later unsaved edits', () => {
    const feedback: SettingsSaveFeedbackState = { section: 'profile', phase: 'saved' };
    const html = renderToStaticMarkup(
      createElement(SettingsSaveFeedback, {
        feedback,
        hasUnsavedChanges: true,
        t: (key: ConciergeMessageKey) => conciergeText(key, 'en'),
      })
    );
    expect(html).toContain('Submitted changes saved. You still have unsaved edits.');
    expect(html).toContain('data-tone="info"');
  });
});
