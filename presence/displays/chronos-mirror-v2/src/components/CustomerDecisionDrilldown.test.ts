import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  query: '',
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.query),
}));

import {
  CustomerDecisionCard,
  CustomerDecisionSelectionView,
  drillDownTarget,
  focusDrillDownOpener,
  isInAppNavigation,
  type DrillDownElement,
} from './CustomerDecisionDrilldown';
import {
  customerDecisionHrefs,
  readCustomerDecisionSelection,
} from '../lib/customer-decision-navigation';

/** A minimal element: attributes, a parent chain for `closest`, and a focus spy. */
function element(
  attributes: Record<string, string>,
  parent: FakeElement | null = null
): FakeElement {
  const node: FakeElement = {
    attributes,
    parent,
    focused: false,
    getAttribute: (name) => attributes[name] ?? null,
    closest: (selector) => {
      const matches = (candidate: FakeElement) =>
        selector.split(',').some((part) => {
          const trimmed = part.trim();
          if (trimmed === 'a[href]')
            return candidate.attributes.tag === 'a' && 'href' in candidate.attributes;
          if (trimmed === 'tr[data-href]')
            return candidate.attributes.tag === 'tr' && 'data-href' in candidate.attributes;
          return false;
        });
      for (let current: FakeElement | null = node; current; current = current.parent)
        if (matches(current)) return current;
      return null;
    },
    focus: () => {
      node.focused = true;
    },
  };
  return node;
}

interface FakeElement extends DrillDownElement {
  attributes: Record<string, string>;
  parent: FakeElement | null;
  focused: boolean;
  focus(): void;
}

const render = (query: string) => {
  const params = new URLSearchParams(query);
  return renderToStaticMarkup(
    createElement(CustomerDecisionSelectionView, {
      selection: readCustomerDecisionSelection(params),
      tenant: 'acme',
      locale: 'en',
      hrefs: customerDecisionHrefs('/', params),
    })
  );
};

describe('CustomerDecisionDrilldown (CD-12)', () => {
  beforeEach(() => {
    nav.query = '';
    nav.push.mockReset();
  });

  it('shows the view the address selects', () => {
    expect(render('tenant=acme')).toContain('Loading customer decisions');
    const caseView = render('tenant=acme&cd_view=case&cd_case=case-a');
    expect(caseView).toContain('<span aria-current="page">case-a</span>');
    expect(caseView).toContain('Loading the details');
    const agendaView = render('tenant=acme&cd_view=case&cd_case=case-a&cd_agenda=agd-1');
    expect(agendaView).toContain('<span aria-current="page">agd-1</span>');
    expect(agendaView).toContain('href="/?tenant=acme&amp;cd_view=case&amp;cd_case=case-a"');
    expect(render('tenant=acme&cd_view=learning')).toContain(
      '<span aria-current="page">Learning from customer decisions</span>'
    );
    // A malformed selection falls back to the overview; nothing is requested for it.
    expect(render('tenant=acme&cd_view=case&cd_case=../x')).toContain('Loading customer decisions');
  });

  it('renders the card from the router query', () => {
    nav.query = 'tenant=acme&cd_view=case&cd_case=case-a';
    const html = renderToStaticMarkup(createElement(CustomerDecisionCard, { tenant: 'acme' }));
    expect(html).toContain('class="chronos-cd-host"');
    expect(html).toContain('<span aria-current="page">case-a</span>');
  });

  it('moves focus only after an in-app navigation, not on a direct load or refresh', () => {
    expect(
      isInAppNavigation('tenant=acme&cd_view=case&cd_case=a', 'tenant=acme&cd_view=case&cd_case=a')
    ).toBe(false);
    expect(isInAppNavigation('tenant=acme', 'tenant=acme&cd_view=case&cd_case=a')).toBe(true);
  });

  it('remembers the link or row that opened a view, inside the card only', () => {
    const host = element({ tag: 'div' });
    const row = element({ tag: 'tr', 'data-href': '/?cd_view=case&cd_case=a' }, host);
    const cell = element({ tag: 'td' }, row);
    const link = element({ tag: 'a', href: '/?cd_view=learning' }, host);
    const inside = { contains: (node: DrillDownElement) => node === row || node === link };
    expect(drillDownTarget(cell, inside)).toBe('/?cd_view=case&cd_case=a');
    expect(drillDownTarget(link, inside)).toBe('/?cd_view=learning');
    // Outside the card, not an opener, or not an element: nothing to remember.
    expect(drillDownTarget(cell, { contains: () => false })).toBeNull();
    expect(drillDownTarget(element({ tag: 'span' }, host), inside)).toBeNull();
    expect(drillDownTarget('text', inside)).toBeNull();
  });

  it('returns focus to the opener once it is back in the card', () => {
    const rows = [
      element({ tag: 'tr', 'data-href': '/?cd_view=case&cd_case=a' }),
      element({ tag: 'tr', 'data-href': '/?cd_view=case&cd_case=b' }),
    ];
    let shown: FakeElement[] = [];
    const container = { querySelectorAll: () => shown };
    // The overview is still loading: not there yet (the card waits for it).
    expect(focusDrillDownOpener(container, '/?cd_view=case&cd_case=b')).toBe(false);
    shown = rows;
    expect(focusDrillDownOpener(container, '/?cd_view=case&cd_case=b')).toBe(true);
    expect(rows.map((row) => row.focused)).toEqual([false, true]);
  });
});
