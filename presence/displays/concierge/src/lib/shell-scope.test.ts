import { describe, expect, it } from 'vitest';
import { destinationTabHref, shellScopeFromQuery } from './shell-scope';

describe('shell scope', () => {
  it('reads camel and snake scope keys and falls back to the shell selection', () => {
    expect(
      shellScopeFromQuery(new URLSearchParams('tenant=acme&organizationId=o1&project_id=p1'))
    ).toEqual({
      tenant: 'acme',
      organizationId: 'o1',
      projectId: 'p1',
    });
    expect(shellScopeFromQuery(new URLSearchParams(''), 'beta')).toEqual({
      tenant: 'beta',
      organizationId: '',
      projectId: '',
    });
    // The URL wins over the cookie; malformed values are ignored.
    expect(shellScopeFromQuery(new URLSearchParams('tenant=acme'), 'beta').tenant).toBe('acme');
    expect(shellScopeFromQuery(new URLSearchParams('tenant=../x'), null).tenant).toBe('');
    expect(shellScopeFromQuery(new URLSearchParams(''), '<script>').tenant).toBe('');
  });

  it('builds tab hrefs that keep the scope and reset list filters', () => {
    const current = new URLSearchParams('tenant=acme&tab=items&q=x&status=done&view=list');
    expect(destinationTabHref('/work', current, 'missions', 'missions')).toBe('/work?tenant=acme');
    expect(destinationTabHref('/work', current, 'items', 'missions')).toBe(
      '/work?tenant=acme&tab=items'
    );
    // The opened request belongs to 依頼 only.
    const opened = new URLSearchParams('tenant=acme&tab=requests&request=req-1');
    expect(destinationTabHref('/work', opened, 'items', 'missions')).toBe(
      '/work?tenant=acme&tab=items'
    );
  });
});
