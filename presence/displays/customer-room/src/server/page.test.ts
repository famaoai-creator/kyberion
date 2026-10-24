import { describe, expect, it } from 'vitest';
import {
  buildBundles,
  localeFromAcceptLanguage,
  renderCustomerRoomPage,
  toInlineJson,
} from './page.js';

describe('customer-room page', () => {
  const catalog = {
    domains: {
      customer_room: {
        page_title: { en: 'Items <for> you', ja: 'ご確認', 'qps-ploc': 'x' },
        only_en: { en: 'Only English' },
      },
      other: { page_title: { en: 'nope' } },
    },
  };

  it('builds en + ja bundles from the customer_room domain only', () => {
    const bundles = buildBundles(catalog);
    expect(bundles.ja.page_title).toBe('ご確認');
    expect(bundles.ja.only_en).toBe('Only English');
    expect(Object.keys(bundles.en)).toEqual(['page_title', 'only_en']);
    expect(buildBundles(null)).toEqual({ en: {}, ja: {} });
  });

  it('picks the page language from Accept-Language', () => {
    expect(localeFromAcceptLanguage('ja,en;q=0.8')).toBe('ja');
    expect(localeFromAcceptLanguage('fr, en-US')).toBe('en');
    expect(localeFromAcceptLanguage(undefined)).toBe('en');
  });

  it('embeds the bundles inertly and escapes the title', () => {
    const html = renderCustomerRoomPage(
      '<html lang="{{locale}}"><title>{{page-title}}</title><script type="application/json">{{vocabulary-json}}</script>',
      buildBundles(catalog),
      'en'
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Items &lt;for&gt; you</title>');
    expect(html).not.toContain('Items <for>');
    expect(toInlineJson({ a: '</script><x>' })).not.toContain('<');
  });
});
